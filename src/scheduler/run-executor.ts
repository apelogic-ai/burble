import { createHash, randomUUID } from "node:crypto";
import type {
  AgentInput,
  AgentOutput,
  AgentRunEvent,
  AgentRunner,
} from "../agent/types";
import { collectAgentRun } from "../agent/types";
import { selectRuntimeToolGroups } from "../agent/tool-groups";
import {
  buildScheduledJobContext,
  type ScheduledJobContext,
} from "../agent/scheduled-job-context";
import { isRuntimeProgressOnlyResponseText } from "../agent/runtime-control-notices";
import { shouldNotifyScheduledRunFailure } from "./failure-notification-policy";
import { inferAllowedToolsForScheduledJob } from "./job-capabilities";
import { findProviderToolSpec } from "../providers/catalog";
import {
  expandProviderToolDependencies,
  providerToolCovers,
} from "../providers/catalog";
import {
  formatScheduledJobFailureMessage,
  scheduledTaskRuntimePrompt,
  validateScheduledJobOutput,
} from "./output-contract";
import type {
  AgentJobRunRecord,
  AgentRuntimeEngine,
  ConversationRouteRecord,
  ProviderConnection,
  ScheduledJobRecord,
  TokenStore,
} from "../db";
import {
  recordTaskWorkflowRunFailed,
  recordTaskWorkflowRunStarted,
  recordTaskWorkflowRunSucceeded,
} from "../workflow/task-workflow-shadow";
import {
  DEFAULT_TASK_WORKFLOW_MAX_ATTEMPTS,
  TASK_WORKFLOW_AGENT_ATTEMPT_MODE,
  TASK_WORKFLOW_RUNTIME_FAILURE_CLASS,
  TASK_WORKFLOW_VALIDATION_FAILURE_CLASS,
  type TaskWorkflowEvent,
} from "../workflow/task-workflow";
import {
  runTaskWorkflowDriver,
  type TaskWorkflowDriverHandlers,
} from "../workflow/task-workflow-driver";
import type { TaskWorkflowEventStore } from "../workflow/task-workflow-store";
import { markdownToSlackMrkdwn } from "../slack-mrkdwn";
import { validateScheduledTask } from "./task-validation";
import { formatScheduledTaskValidationFailureReason } from "./task-validation-format";

type SlackPostClient = {
  chat: {
    postMessage(input: {
      channel: string;
      text: string;
      thread_ts?: string;
    }): Promise<unknown>;
  };
};

type ScheduledRunExecutionContext = {
  job: ScheduledJobRecord;
  route: ConversationRouteRecord | null;
  destination: ReturnType<typeof readSlackRouteDestination>;
  runtimePrompt: string;
  toolGroups: ReturnType<typeof selectRuntimeToolGroups>;
  scheduledJobContext: ScheduledJobContext | undefined;
  requiredExecutionTools: string[];
};

type ScheduledRunAttemptResult = {
  text: string;
  output: AgentOutput;
  events: AgentRunEvent[];
};

type ScheduledAgentRunCollection = {
  output: AgentOutput;
  events: AgentRunEvent[];
};

const DEFAULT_WORKFLOW_ATTEMPT_HEARTBEAT_INTERVAL_MS = 60_000;
const DEFAULT_SCHEDULED_RUNTIME_RETRY_BASE_MS = 5_000;
const DEFAULT_SCHEDULED_RUNTIME_RETRY_MAX_MS = 30_000;
const DEFAULT_SCHEDULED_RUNTIME_RETRY_JITTER_RATIO = 0.5;

export type SchedulerRunExecutor = {
  executeRun(runId: string): Promise<void>;
  notifyFailedRun(runId: string): Promise<boolean>;
};

export function buildScheduledRunAdmissionAgentInput(input: {
  store: Pick<
    TokenStore,
    | "getAgentJobCapability"
    | "getConversationRoute"
    | "getConnectionForSlackUser"
    | "getScheduledJob"
  >;
  job: ScheduledJobRecord;
  workspaceId: string;
  slackUserId: string;
  runId?: string;
  now?: Date;
}): AgentInput {
  const timestamp = (input.now ?? new Date()).toISOString();
  const run: AgentJobRunRecord = {
    runId: input.runId ?? `jobrun_admission_${randomUUID()}`,
    jobId: input.job.jobId,
    workspaceId: input.workspaceId,
    slackUserId: input.slackUserId,
    triggerSource: "manual",
    status: "queued",
    failureReason: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: null,
    finishedAt: null,
  };
  return buildScheduledRunAgentInput({
    store: input.store,
    run,
    executionContext: prepareScheduledRunExecution(input.store, run, input.job),
  });
}

export function createSchedulerRunExecutor(input: {
  store: Pick<
    TokenStore,
    | "claimAgentJobRun"
    | "finishAgentJobRun"
    | "getAgentJobRun"
    | "getAgentJobCapability"
    | "getScheduledJob"
    | "getConversationRoute"
    | "getConnectionForSlackUser"
    | "upsertAgentJobRunAudit"
  >;
  agentRunner: AgentRunner;
  slackClient: SlackPostClient;
  workflowShadowStore?: TaskWorkflowEventStore;
  workflowAuthority?: "off" | "manual" | "timer";
  workflowMaxAttempts?: number;
  workflowHeartbeatIntervalMs?: number;
  scheduledRuntimeRetryDelayMs?: (attempt: number) => number;
  scheduledRuntimeRetrySleep?: (delayMs: number) => Promise<void>;
  logInfo?: (message: string) => void;
  logWarn?: (message: string) => void;
}): SchedulerRunExecutor {
  return {
    async notifyFailedRun(runId) {
      const run = input.store.getAgentJobRun(runId);
      if (!run || run.status !== "failed") {
        return false;
      }
      const job = input.store.getScheduledJob(run.jobId);
      if (!job?.routeId) {
        return false;
      }
      const route = input.store.getConversationRoute(job.routeId);
      const destination = route ? readSlackRouteDestination(route) : null;
      return postScheduledRunFailureNotification({
        slackClient: input.slackClient,
        job,
        run,
        destination,
        reason: run.failureReason ?? "Scheduled job run failed",
      });
    },
    async executeRun(runId) {
      const run = input.store.claimAgentJobRun(runId);
      if (!run) {
        return;
      }
      if (
        isWorkflowAuthoritativeRun(input.workflowAuthority, run) &&
        input.workflowShadowStore
      ) {
        const workflowShadowStore = input.workflowShadowStore;
        try {
          await executeWorkflowAuthoritativeManualRun(
            { ...input, workflowShadowStore },
            run,
          );
        } catch (error) {
          const message = scheduledRunErrorMessage(error);
          const currentRun = input.store.getAgentJobRun(run.runId);
          if (currentRun?.status === "succeeded") {
            recordWorkflowDriverSuccess({
              store: workflowShadowStore,
              run: currentRun,
              job: input.store.getScheduledJob(currentRun.jobId),
              logWarn: input.logWarn,
            });
            input.logWarn?.(
              `Scheduled job workflow run errored after authoritative success runId=${run.runId} error=${message}`,
            );
            return;
          }
          const failedRun =
            input.store.finishAgentJobRun({
              runId: run.runId,
              status: "failed",
              failureReason: message.slice(0, 500),
            }) ?? input.store.getAgentJobRun(run.runId);
          recordWorkflowDriverFailure({
            store: workflowShadowStore,
            run: failedRun ?? run,
            reason: failedRun?.failureReason ?? message.slice(0, 500),
            logWarn: input.logWarn,
          });
          if (!workflowErrorNotificationWasSent(error)) {
            await notifyWorkflowDriverFailure({
              store: input.store,
              slackClient: input.slackClient,
              run: failedRun ?? run,
              reason: failedRun?.failureReason ?? message.slice(0, 500),
              logWarn: input.logWarn,
            });
          }
          input.logWarn?.(
            `Scheduled job workflow run failed runId=${run.runId} error=${message}`,
          );
        }
        return;
      }
      let executionContext: ScheduledRunExecutionContext | null = null;

      try {
        const preparedExecutionContext = prepareScheduledRunExecution(
          input.store,
          run,
        );
        executionContext = preparedExecutionContext;
        assertScheduledRunDestinationAvailable(preparedExecutionContext);

        input.logInfo?.(
          `Scheduled job run start runId=${run.runId} jobId=${preparedExecutionContext.job.jobId}`,
        );
        recordTaskWorkflowRunStarted({
          store: input.workflowShadowStore,
          run,
          logWarn: input.logWarn,
        });
        const attemptResult =
          input.workflowShadowStore && input.workflowAuthority !== "off"
            ? await runWithWorkflowAttemptHeartbeats({
                intervalMs:
                  input.workflowHeartbeatIntervalMs ??
                  DEFAULT_WORKFLOW_ATTEMPT_HEARTBEAT_INTERVAL_MS,
                heartbeat: () =>
                  appendWorkflowRunHeartbeat({
                    store: input.workflowShadowStore!,
                    taskId: run.jobId,
                    jobRunId: run.runId,
                  }),
                run: () =>
                  executeScheduledRunAttempt({
                    runner: input.agentRunner,
                    store: input.store,
                    run,
                    executionContext: preparedExecutionContext,
                    scheduledRuntimeRetryDelayMs:
                      input.scheduledRuntimeRetryDelayMs,
                    scheduledRuntimeRetrySleep:
                      input.scheduledRuntimeRetrySleep,
                    logWarn: input.logWarn,
                  }),
                logWarn: input.logWarn,
              })
            : await executeScheduledRunAttempt({
                runner: input.agentRunner,
                store: input.store,
                run,
                executionContext: preparedExecutionContext,
                scheduledRuntimeRetryDelayMs:
                  input.scheduledRuntimeRetryDelayMs,
                scheduledRuntimeRetrySleep: input.scheduledRuntimeRetrySleep,
                logWarn: input.logWarn,
              });
        await postScheduledRunOutput({
          slackClient: input.slackClient,
          destination: preparedExecutionContext.destination,
          text: attemptResult.text,
        });
        const finishedRun =
          input.store.finishAgentJobRun({
            runId: run.runId,
            status: "succeeded",
          }) ?? input.store.getAgentJobRun(run.runId);
        if (finishedRun?.status === "succeeded") {
          recordTaskWorkflowRunSucceeded({
            store: input.workflowShadowStore,
            run: finishedRun,
            outputText: attemptResult.text,
            routeId: executionContext.job.routeId,
            logWarn: input.logWarn,
          });
          recordScheduledRunAudit({
            store: input.store,
            runner: input.agentRunner,
            run: finishedRun,
            executionContext,
            attemptResult,
            logWarn: input.logWarn,
          });
        } else if (finishedRun?.status === "failed") {
          recordTaskWorkflowRunFailed({
            store: input.workflowShadowStore,
            run: finishedRun,
            failureClass: TASK_WORKFLOW_RUNTIME_FAILURE_CLASS,
            reason: finishedRun.failureReason ?? "Scheduled job run failed",
            logWarn: input.logWarn,
          });
        }
        input.logInfo?.(
          `Scheduled job run finish runId=${run.runId} jobId=${executionContext.job.jobId}`,
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Scheduled job run failed";
        const failedRun =
          input.store.finishAgentJobRun({
            runId: run.runId,
            status: "failed",
            failureReason: message.slice(0, 500),
          }) ?? input.store.getAgentJobRun(run.runId);
        if (failedRun?.status === "failed") {
          recordTaskWorkflowRunFailed({
            store: input.workflowShadowStore,
            run: failedRun,
            failureClass: TASK_WORKFLOW_RUNTIME_FAILURE_CLASS,
            reason: failedRun.failureReason ?? message.slice(0, 500),
            logWarn: input.logWarn,
          });
        }
        input.logWarn?.(
          `Scheduled job run failed runId=${run.runId} error=${message}`,
        );
        if (executionContext) {
          try {
            await postScheduledRunFailureNotification({
              slackClient: input.slackClient,
              job: executionContext.job,
              run,
              destination: executionContext.destination,
              reason: message,
            });
          } catch (deliveryError) {
            const deliveryMessage =
              deliveryError instanceof Error
                ? deliveryError.message
                : "Scheduled job failure delivery failed";
            input.logWarn?.(
              `Scheduled job failure notification failed runId=${run.runId} error=${deliveryMessage}`,
            );
          }
        }
      }
    },
  };
}

function isWorkflowAuthoritativeRun(
  authority: "off" | "manual" | "timer" | undefined,
  run: AgentJobRunRecord,
): boolean {
  if (authority === "manual") {
    return run.triggerSource === "manual";
  }
  if (authority === "timer") {
    return run.triggerSource === "manual" || run.triggerSource === "schedule";
  }
  return false;
}

function prepareScheduledRunExecution(
  store: Pick<
    TokenStore,
    "getScheduledJob" | "getConversationRoute" | "getAgentJobCapability"
  >,
  run: AgentJobRunRecord,
  preloadedJob?: ScheduledJobRecord,
): ScheduledRunExecutionContext {
  const job = preloadedJob ?? store.getScheduledJob(run.jobId);
  if (!job) {
    throw new Error("Scheduled job not found");
  }
  const route = job.routeId ? store.getConversationRoute(job.routeId) : null;
  const destination = route ? readSlackRouteDestination(route) : null;
  const runtimePrompt = scheduledTaskRuntimePrompt(job.prompt);
  const toolGroups = selectRuntimeToolGroups({
    text: runtimePrompt,
    attachmentCount: 0,
    contextTexts: [],
  });
  return {
    job,
    route,
    destination,
    runtimePrompt,
    toolGroups,
    scheduledJobContext: scheduledJobContextForRun(
      store,
      job,
      toolGroups.groups,
    ),
    requiredExecutionTools: resolvedExecutionToolsForRun(store, job),
  };
}

function assertScheduledRunDestinationAvailable(
  executionContext: ScheduledRunExecutionContext,
): void {
  if (executionContext.job.routeId && !executionContext.destination) {
    throw new Error("Scheduled job delivery route is unavailable");
  }
}

function buildScheduledRunAgentInput(input: {
  store: Pick<TokenStore, "getConnectionForSlackUser">;
  run: AgentJobRunRecord;
  executionContext: ScheduledRunExecutionContext;
}): AgentInput {
  const {
    job,
    route,
    destination,
    runtimePrompt,
    toolGroups,
    scheduledJobContext,
  } = input.executionContext;
  return {
    principal: {
      workspaceId: input.run.workspaceId,
      slackUserId: input.run.slackUserId,
    },
    executionMode: "native-runtime",
    ...(destination
      ? {
          conversation: {
            routeId: route?.id,
            source: "slack" as const,
            workspaceId: input.run.workspaceId,
            channelId: destination.channelId,
            rootId: scheduledRunConversationRoot(job, input.run),
            isDirectMessage: destination.isDirectMessage,
          },
        }
      : {}),
    text: runtimePrompt,
    toolGroups,
    ...(scheduledJobContext ? { scheduledJob: scheduledJobContext } : {}),
    connections: {
      github: connectionForSlackUser(input.store, "github", input.run),
      google: connectionForSlackUser(input.store, "google", input.run),
      hubspot: connectionForSlackUser(input.store, "hubspot", input.run),
      jira: connectionForSlackUser(input.store, "jira", input.run),
      slack: connectionForSlackUser(input.store, "slack", input.run),
    },
  };
}

async function executeScheduledRunAttempt(input: {
  runner: AgentRunner;
  store: Pick<TokenStore, "getConnectionForSlackUser">;
  run: AgentJobRunRecord;
  executionContext: ScheduledRunExecutionContext;
  scheduledRuntimeRetryDelayMs?: (attempt: number) => number;
  scheduledRuntimeRetrySleep?: (delayMs: number) => Promise<void>;
  logWarn?: (message: string) => void;
}): Promise<ScheduledRunAttemptResult> {
  assertScheduledRunDestinationAvailable(input.executionContext);
  const collected = await collectScheduledAgentRunWithProgressRetry({
    runner: input.runner,
    agentInput: buildScheduledRunAgentInput({
      store: input.store,
      run: input.run,
      executionContext: input.executionContext,
    }),
    job: input.executionContext.job,
    scheduledJobContext: input.executionContext.scheduledJobContext,
    scheduledRuntimeRetryDelayMs: input.scheduledRuntimeRetryDelayMs,
    scheduledRuntimeRetrySleep: input.scheduledRuntimeRetrySleep,
    logWarn: input.logWarn,
  });
  const evidence = validateScheduledRunToolEvidence({
    requiredTools: input.executionContext.requiredExecutionTools,
    events: collected.events,
  });
  if (!evidence.ok) {
    throw new Error(evidence.reason);
  }
  const output = validateScheduledJobOutput(collected.output);
  if (!output.ok) {
    throw new Error(output.reason);
  }
  return {
    text: output.text,
    output: collected.output,
    events: collected.events,
  };
}

async function postScheduledRunOutput(input: {
  slackClient: SlackPostClient;
  destination: ReturnType<typeof readSlackRouteDestination>;
  text: string;
}): Promise<boolean> {
  if (!input.destination) {
    return false;
  }
  await input.slackClient.chat.postMessage({
    channel: input.destination.channelId,
    text: markdownToSlackMrkdwn(input.text),
    ...(input.destination.threadTs && !input.destination.isDirectMessage
      ? { thread_ts: input.destination.threadTs }
      : {}),
  });
  return true;
}

async function postScheduledRunFailureNotification(input: {
  slackClient: SlackPostClient;
  job: ScheduledJobRecord;
  run: AgentJobRunRecord;
  destination: ReturnType<typeof readSlackRouteDestination>;
  reason: string;
}): Promise<boolean> {
  if (
    !shouldNotifyScheduledRunFailure({
      run: input.run,
      hasDestination: Boolean(input.destination),
    }) ||
    !input.destination
  ) {
    return false;
  }
  await input.slackClient.chat.postMessage({
    channel: input.destination.channelId,
    text: formatScheduledJobFailureMessage(input.job, input.run, input.reason),
    ...(input.destination.threadTs && !input.destination.isDirectMessage
      ? { thread_ts: input.destination.threadTs }
      : {}),
  });
  return true;
}

function recordScheduledRunAudit(input: {
  store: Pick<TokenStore, "upsertAgentJobRunAudit">;
  runner: AgentRunner;
  run: AgentJobRunRecord;
  executionContext: ScheduledRunExecutionContext;
  attemptResult: ScheduledRunAttemptResult;
  logWarn?: (message: string) => void;
}): void {
  try {
    const { job, destination } = input.executionContext;
    input.store.upsertAgentJobRunAudit({
      runId: input.run.runId,
      jobId: input.run.jobId,
      workspaceId: input.run.workspaceId,
      slackUserId: input.run.slackUserId,
      runtimeType: job.runtimeType,
      runnerName: input.runner.name,
      executionMode: "native-runtime",
      routeId: job.routeId,
      outputDigest: outputTextDigest(input.attemptResult.text),
      outputBytes: textByteLength(input.attemptResult.text),
      usage: auditJsonField(
        "usage",
        input.attemptResult.output.usage ?? null,
        input,
      ),
      telemetry: auditJsonField(
        "telemetry",
        scheduledRunAuditTelemetry(
          input.attemptResult.output.telemetry,
          input.attemptResult.events,
        ),
        input,
      ),
      visibility: auditJsonField(
        "visibility",
        destination
          ? {
              destination: "slack",
              channelId: destination.channelId,
              isDirectMessage: destination.isDirectMessage,
              threadTs: destination.threadTs ?? null,
            }
          : {
              destination: "none",
            },
        input,
      ),
    });
  } catch (error) {
    input.logWarn?.(
      `Scheduled job run audit write failed runId=${input.run.runId} error=${scheduledRunErrorMessage(error)}`,
    );
  }
}

function auditJsonField(
  fieldName: "usage" | "telemetry" | "visibility",
  value: unknown,
  input: { run: AgentJobRunRecord; logWarn?: (message: string) => void },
): unknown {
  try {
    JSON.stringify(value);
    return value;
  } catch {
    input.logWarn?.(
      `Scheduled job run audit field ${fieldName} was not JSON-serializable runId=${input.run.runId}`,
    );
    return null;
  }
}

async function executeWorkflowAuthoritativeManualRun(
  input: {
    store: Pick<
      TokenStore,
      | "claimAgentJobRun"
      | "finishAgentJobRun"
      | "getAgentJobRun"
      | "getAgentJobCapability"
      | "getScheduledJob"
      | "getConversationRoute"
      | "getConnectionForSlackUser"
      | "upsertAgentJobRunAudit"
    >;
    agentRunner: AgentRunner;
    slackClient: SlackPostClient;
    workflowShadowStore: TaskWorkflowEventStore;
    workflowMaxAttempts?: number;
    workflowHeartbeatIntervalMs?: number;
    scheduledRuntimeRetryDelayMs?: (attempt: number) => number;
    scheduledRuntimeRetrySleep?: (delayMs: number) => Promise<void>;
    logInfo?: (message: string) => void;
    logWarn?: (message: string) => void;
  },
  run: AgentJobRunRecord,
): Promise<void> {
  const job = input.store.getScheduledJob(run.jobId);
  if (!job) {
    const failedRun =
      input.store.finishAgentJobRun({
        runId: run.runId,
        status: "failed",
        failureReason: "Scheduled job not found",
      }) ?? input.store.getAgentJobRun(run.runId);
    if (failedRun?.status === "failed") {
      appendWorkflowEvent(input.workflowShadowStore, {
        type: "task_triggered",
        taskId: run.jobId,
        jobRunId: run.runId,
        triggerKey: workflowTriggerKey(run),
        source: run.triggerSource,
        at: run.createdAt,
      });
      appendWorkflowEvent(input.workflowShadowStore, {
        type: "validation_failed",
        taskId: run.jobId,
        jobRunId: run.runId,
        failureClass: TASK_WORKFLOW_VALIDATION_FAILURE_CLASS,
        reason: failedRun.failureReason ?? "Scheduled job not found",
        at: failedRun.finishedAt ?? new Date().toISOString(),
      });
    }
    return;
  }

  const executionContext = prepareScheduledRunExecution(input.store, run, job);
  const { destination, scheduledJobContext } = executionContext;
  const outputByDigest = new Map<string, ScheduledRunAttemptResult>();
  let failureNotificationSent = false;
  const workflowReplayConfig = {
    maxAttempts:
      input.workflowMaxAttempts ?? DEFAULT_TASK_WORKFLOW_MAX_ATTEMPTS,
  };
  const initialWorkflowState = input.workflowShadowStore.replayState({
    initialConfig: workflowReplayConfig,
  });
  const maxWorkflowAttempts =
    initialWorkflowState.maxAttempts ?? DEFAULT_TASK_WORKFLOW_MAX_ATTEMPTS;

  input.logInfo?.(
    `Scheduled job workflow run start runId=${run.runId} jobId=${job.jobId}`,
  );

  const handlers: TaskWorkflowDriverHandlers = {
    validateTask: async (command) => {
      const capability = input.store.getAgentJobCapability(command.taskId);
      const validation = validateScheduledTask(job, capability);
      if (!validation.ok) {
        const failureReason =
          formatScheduledTaskValidationFailureReason(validation);
        const failedRun =
          input.store.finishAgentJobRun({
            runId: command.jobRunId,
            status: "failed",
            failureReason,
          }) ?? input.store.getAgentJobRun(command.jobRunId);
        return {
          type: "validation_failed",
          taskId: command.taskId,
          jobRunId: command.jobRunId,
          failureClass: TASK_WORKFLOW_VALIDATION_FAILURE_CLASS,
          reason:
            failedRun?.failureReason ?? "Scheduled task validation failed.",
          at: failedRun?.finishedAt ?? new Date().toISOString(),
        };
      }
      return {
        type: "validation_passed",
        taskId: command.taskId,
        jobRunId: command.jobRunId,
        at: new Date().toISOString(),
      };
    },
    startAttempt: async (command, ctx) => {
      try {
        const attemptResult = await runWithWorkflowAttemptHeartbeats({
          intervalMs:
            input.workflowHeartbeatIntervalMs ??
            DEFAULT_WORKFLOW_ATTEMPT_HEARTBEAT_INTERVAL_MS,
          heartbeat: () =>
            appendWorkflowRunHeartbeat({
              store: input.workflowShadowStore,
              taskId: command.taskId,
              jobRunId: command.jobRunId,
            }),
          run: () =>
            executeScheduledRunAttempt({
              runner: input.agentRunner,
              store: input.store,
              run,
              executionContext,
              scheduledRuntimeRetryDelayMs:
                input.scheduledRuntimeRetryDelayMs,
              scheduledRuntimeRetrySleep: input.scheduledRuntimeRetrySleep,
              logWarn: input.logWarn,
            }),
          logWarn: input.logWarn,
        });
        const outputDigest = outputTextDigest(attemptResult.text);
        outputByDigest.set(outputDigest, attemptResult);
        return {
          type: "attempt_succeeded",
          taskId: command.taskId,
          jobRunId: command.jobRunId,
          attempt: command.attempt,
          outputDigest,
          at: new Date().toISOString(),
        };
      } catch (error) {
        const message = scheduledRunErrorMessage(error);
        const retryable = shouldRetryWorkflowAttempt({
          attempt: command.attempt,
          maxAttempts: maxWorkflowAttempts,
          scheduledJobContext,
        });
        if (retryable) {
          return {
            type: "attempt_failed",
            taskId: command.taskId,
            jobRunId: command.jobRunId,
            attempt: command.attempt,
            failureClass: TASK_WORKFLOW_RUNTIME_FAILURE_CLASS,
            reason: message.slice(0, 500),
            retryable: true,
            at: new Date().toISOString(),
          };
        }
        const failedRun =
          input.store.finishAgentJobRun({
            runId: command.jobRunId,
            status: "failed",
            failureReason: message.slice(0, 500),
          }) ?? input.store.getAgentJobRun(command.jobRunId);
        return {
          type: "attempt_failed",
          taskId: command.taskId,
          jobRunId: command.jobRunId,
          attempt: command.attempt,
          failureClass: TASK_WORKFLOW_RUNTIME_FAILURE_CLASS,
          reason: failedRun?.failureReason ?? message.slice(0, 500),
          at: failedRun?.finishedAt ?? new Date().toISOString(),
        };
      }
    },
    deliverOutput: async (command) => {
      const artifact = outputByDigest.get(command.outputDigest);
      const deliveryKey = workflowDeliveryKey(
        command.jobRunId,
        job.routeId,
        command.outputDigest,
      );
      const started: TaskWorkflowEvent = {
        type: "delivery_started",
        taskId: command.taskId,
        jobRunId: command.jobRunId,
        deliveryKey,
        at: new Date().toISOString(),
      };
      let outputDelivered = false;
      try {
        if (!artifact) {
          throw new Error("Scheduled job output artifact is unavailable");
        }
        outputDelivered = await postScheduledRunOutput({
          slackClient: input.slackClient,
          destination,
          text: artifact.text,
        });
        const finishedRun =
          input.store.finishAgentJobRun({
            runId: command.jobRunId,
            status: "succeeded",
          }) ?? input.store.getAgentJobRun(command.jobRunId);
        if (finishedRun?.status !== "succeeded") {
          const reason =
            finishedRun?.failureReason ??
            "Scheduled job run could not be marked succeeded";
          if (!outputDelivered) {
            throw new Error(reason);
          }
          input.logWarn?.(
            `Scheduled job workflow output delivered but run projection was not marked succeeded runId=${command.jobRunId} status=${finishedRun?.status ?? "missing"} reason=${reason}`,
          );
        }
        if (finishedRun?.status === "succeeded") {
          recordScheduledRunAudit({
            store: input.store,
            runner: input.agentRunner,
            run: finishedRun,
            executionContext,
            attemptResult: artifact,
            logWarn: input.logWarn,
          });
        }
        return [
          started,
          {
            type: "delivery_succeeded",
            taskId: command.taskId,
            jobRunId: command.jobRunId,
            deliveryKey,
            at: finishedRun?.finishedAt ?? new Date().toISOString(),
          },
        ];
      } catch (error) {
        const message = scheduledRunErrorMessage(error);
        if (outputDelivered) {
          input.logWarn?.(
            `Scheduled job workflow output delivered but terminal projection failed runId=${command.jobRunId} error=${message}`,
          );
          return [
            started,
            {
              type: "delivery_succeeded",
              taskId: command.taskId,
              jobRunId: command.jobRunId,
              deliveryKey,
              at: new Date().toISOString(),
            },
          ];
        }
        const failedRun =
          input.store.finishAgentJobRun({
            runId: command.jobRunId,
            status: "failed",
            failureReason: message.slice(0, 500),
          }) ?? input.store.getAgentJobRun(command.jobRunId);
        return [
          started,
          {
            type: "delivery_failed",
            taskId: command.taskId,
            jobRunId: command.jobRunId,
            deliveryKey,
            failureClass: "delivery_failed",
            reason: failedRun?.failureReason ?? message.slice(0, 500),
            at: failedRun?.finishedAt ?? new Date().toISOString(),
          },
        ];
      }
    },
    notifyFailure: async (command) => {
      if (destination) {
        await postScheduledRunFailureNotification({
          slackClient: input.slackClient,
          job,
          run,
          destination,
          reason: command.reason,
        });
        failureNotificationSent = true;
      }
      return null;
    },
  };

  try {
    await runTaskWorkflowDriver({
      initialState: initialWorkflowState,
      initialEvent: {
        type: "task_triggered",
        taskId: job.jobId,
        jobRunId: run.runId,
        triggerKey: workflowTriggerKey(run),
        source: run.triggerSource,
        at: run.createdAt,
      },
      handlers,
      onEvent: async (event) => {
        appendWorkflowEvent(input.workflowShadowStore, event);
      },
    });
  } catch (error) {
    throw new ScheduledWorkflowRunError(scheduledRunErrorMessage(error), {
      failureNotificationSent,
    });
  }

  input.logInfo?.(
    `Scheduled job workflow run finish runId=${run.runId} jobId=${job.jobId}`,
  );
}

function shouldRetryWorkflowAttempt(input: {
  attempt: number;
  maxAttempts: number;
  scheduledJobContext: ScheduledJobContext | undefined;
}): boolean {
  return (
    input.attempt < input.maxAttempts &&
    scheduledJobContextAllowsOnlyReadTools(input.scheduledJobContext)
  );
}

function recordWorkflowDriverFailure(input: {
  store: TaskWorkflowEventStore;
  run: AgentJobRunRecord;
  reason: string;
  logWarn?: (message: string) => void;
}): void {
  try {
    appendWorkflowEvent(input.store, {
      type: "task_triggered",
      taskId: input.run.jobId,
      jobRunId: input.run.runId,
      triggerKey: workflowTriggerKey(input.run),
      source: input.run.triggerSource,
      at: input.run.createdAt,
    });
    const workflowRun = input.store.replayState().runs[input.run.runId];
    const at = input.run.finishedAt ?? new Date().toISOString();
    if (workflowRun?.status === "delivering") {
      appendWorkflowEvent(input.store, {
        type: "delivery_failed",
        taskId: input.run.jobId,
        jobRunId: input.run.runId,
        ...(workflowRun.deliveryKey
          ? { deliveryKey: workflowRun.deliveryKey }
          : {}),
        failureClass: "delivery_failed",
        reason: input.reason,
        at,
      });
      return;
    }
    if (workflowRun?.status === "running") {
      const attempt = workflowRun.attempt ?? 1;
      if (!workflowRun.attempt) {
        appendWorkflowEvent(input.store, {
          type: "attempt_started",
          taskId: input.run.jobId,
          jobRunId: input.run.runId,
          attempt,
          mode: TASK_WORKFLOW_AGENT_ATTEMPT_MODE,
          at,
        });
      }
      appendWorkflowEvent(input.store, {
        type: "attempt_failed",
        taskId: input.run.jobId,
        jobRunId: input.run.runId,
        attempt,
        failureClass: TASK_WORKFLOW_RUNTIME_FAILURE_CLASS,
        reason: input.reason,
        at,
      });
      return;
    }
    appendWorkflowEvent(input.store, {
      type: "validation_failed",
      taskId: input.run.jobId,
      jobRunId: input.run.runId,
      failureClass: TASK_WORKFLOW_VALIDATION_FAILURE_CLASS,
      reason: input.reason,
      at,
    });
  } catch (error) {
    input.logWarn?.(
      `Task workflow failure compensation failed runId=${input.run.runId} error=${scheduledRunErrorMessage(error)}`,
    );
  }
}

function recordWorkflowDriverSuccess(input: {
  store: TaskWorkflowEventStore;
  run: AgentJobRunRecord;
  job: ScheduledJobRecord | null;
  logWarn?: (message: string) => void;
}): void {
  try {
    appendWorkflowEvent(input.store, {
      type: "task_triggered",
      taskId: input.run.jobId,
      jobRunId: input.run.runId,
      triggerKey: workflowTriggerKey(input.run),
      source: input.run.triggerSource,
      at: input.run.createdAt,
    });
    const workflowRun = input.store.replayState().runs[input.run.runId];
    if (workflowRun?.status === "succeeded") {
      return;
    }
    const outputDigest = workflowRun?.outputDigest;
    const deliveryKey =
      workflowRun?.deliveryKey ??
      (outputDigest
        ? workflowDeliveryKey(input.run.runId, input.job?.routeId, outputDigest)
        : null);
    if (workflowRun?.status !== "delivering" || !deliveryKey) {
      input.logWarn?.(
        `Task workflow success compensation skipped runId=${input.run.runId} workflowStatus=${workflowRun?.status ?? "missing"}`,
      );
      return;
    }
    const at = input.run.finishedAt ?? new Date().toISOString();
    if (!workflowRun.deliveryKey) {
      appendWorkflowEvent(input.store, {
        type: "delivery_started",
        taskId: input.run.jobId,
        jobRunId: input.run.runId,
        deliveryKey,
        at,
      });
    }
    appendWorkflowEvent(input.store, {
      type: "delivery_succeeded",
      taskId: input.run.jobId,
      jobRunId: input.run.runId,
      deliveryKey,
      at,
    });
  } catch (error) {
    input.logWarn?.(
      `Task workflow success compensation failed runId=${input.run.runId} error=${scheduledRunErrorMessage(error)}`,
    );
  }
}

async function notifyWorkflowDriverFailure(input: {
  store: Pick<TokenStore, "getScheduledJob" | "getConversationRoute">;
  slackClient: SlackPostClient;
  run: AgentJobRunRecord;
  reason: string;
  logWarn?: (message: string) => void;
}): Promise<void> {
  const job = input.store.getScheduledJob(input.run.jobId);
  if (!job?.routeId) {
    return;
  }
  const route = input.store.getConversationRoute(job.routeId);
  const destination = route ? readSlackRouteDestination(route) : null;
  if (!destination) {
    return;
  }
  try {
    await input.slackClient.chat.postMessage({
      channel: destination.channelId,
      text: formatScheduledJobFailureMessage(job, input.run, input.reason),
      ...(destination.threadTs && !destination.isDirectMessage
        ? { thread_ts: destination.threadTs }
        : {}),
    });
  } catch (error) {
    input.logWarn?.(
      `Scheduled job workflow failure notification failed runId=${input.run.runId} error=${scheduledRunErrorMessage(error)}`,
    );
  }
}

async function collectScheduledAgentRunWithProgressRetry(input: {
  runner: AgentRunner;
  agentInput: AgentInput;
  job: ScheduledJobRecord;
  scheduledJobContext: ScheduledJobContext | undefined;
  scheduledRuntimeRetryDelayMs?: (attempt: number) => number;
  scheduledRuntimeRetrySleep?: (delayMs: number) => Promise<void>;
  logWarn?: (message: string) => void;
}): Promise<ScheduledAgentRunCollection> {
  const collected = collectAgentRunWithEvents(input.runner, input.agentInput);
  const events = collected.events;
  try {
    const result = await collected.output;
    const retryContext = progressOnlyScheduledRunRetryContext(
      events,
      input.scheduledJobContext,
    );
    if (isRuntimeProgressOnlyResponseText(result.text) && retryContext) {
      return collectScheduledAgentRunProgressRetry({
        ...input,
        scheduledJobContext: retryContext,
      });
    }
    if (
      isRuntimeProgressOnlyResponseText(result.text) &&
      shouldFailUnsafeProgressOnlyResult(events, input.scheduledJobContext)
    ) {
      throw new Error(
        "Managed runtime final response contained only runtime-control/progress text",
      );
    }
    return { output: result, events };
  } catch (error) {
    const retryContext = progressOnlyScheduledRunRetryContext(
      events,
      input.scheduledJobContext,
    );
    if (isProgressOnlyRuntimeFinalError(error) && retryContext) {
      return collectScheduledAgentRunProgressRetry({
        ...input,
        scheduledJobContext: retryContext,
      });
    }
    const transientRetryContext = transientScheduledRunRetryContext(
      input.scheduledJobContext,
    );
    if (
      isRetryableScheduledRuntimeError(error) &&
      transientRetryContext
    ) {
      return collectScheduledAgentRunTransientRetry({
        ...input,
        error,
        scheduledJobContext: transientRetryContext,
      });
    }
    throw error;
  }
}

function progressOnlyScheduledRunRetryContext(
  events: AgentRunEvent[],
  scheduledJobContext: ScheduledJobContext | undefined,
): ScheduledJobContext | null {
  const canRetry =
    !events.some((event) => event.type === "tool_call") &&
    Boolean(scheduledJobContext?.allowedTools.length) &&
    scheduledJobContextAllowsOnlyReadTools(scheduledJobContext);
  return canRetry && scheduledJobContext ? scheduledJobContext : null;
}

function transientScheduledRunRetryContext(
  scheduledJobContext: ScheduledJobContext | undefined,
): ScheduledJobContext | null {
  const canRetry =
    Boolean(scheduledJobContext?.allowedTools.length) &&
    scheduledJobContextAllowsOnlyReadTools(scheduledJobContext);
  return canRetry && scheduledJobContext ? scheduledJobContext : null;
}

function shouldFailUnsafeProgressOnlyResult(
  events: AgentRunEvent[],
  scheduledJobContext: ScheduledJobContext | undefined,
): boolean {
  return (
    !events.some((event) => event.type === "tool_call") &&
    Boolean(scheduledJobContext?.allowedTools.length) &&
    !scheduledJobContextAllowsOnlyReadTools(scheduledJobContext)
  );
}

async function appendWorkflowRunHeartbeat(input: {
  store: TaskWorkflowEventStore;
  taskId: string;
  jobRunId: string;
}): Promise<void> {
  appendWorkflowEvent(input.store, {
    type: "run_heartbeat",
    taskId: input.taskId,
    jobRunId: input.jobRunId,
    at: new Date().toISOString(),
  });
}

async function runWithWorkflowAttemptHeartbeats<T>(input: {
  intervalMs: number;
  heartbeat: () => Promise<void>;
  run: () => Promise<T>;
  logWarn?: (message: string) => void;
}): Promise<T> {
  await input.heartbeat();
  const intervalMs =
    Number.isFinite(input.intervalMs) && input.intervalMs > 0
      ? input.intervalMs
      : DEFAULT_WORKFLOW_ATTEMPT_HEARTBEAT_INTERVAL_MS;
  const timer = setInterval(() => {
    input.heartbeat().catch((error) => {
      input.logWarn?.(
        `Scheduled job workflow heartbeat failed error=${scheduledRunErrorMessage(error)}`,
      );
    });
  }, intervalMs);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  try {
    return await input.run();
  } finally {
    clearInterval(timer);
  }
}

function scheduledJobContextAllowsOnlyReadTools(
  scheduledJobContext: ScheduledJobContext | undefined,
): boolean {
  return Boolean(
    scheduledJobContext?.allowedTools.length &&
    scheduledJobContext.allowedTools.every((toolName) =>
      isPositiveReadOnlyProviderTool(toolName),
    ),
  );
}

function isPositiveReadOnlyProviderTool(toolName: string): boolean {
  return findProviderToolSpec(toolName)?.risk === "read";
}

async function collectScheduledAgentRunProgressRetry(input: {
  runner: AgentRunner;
  agentInput: AgentInput;
  job: ScheduledJobRecord;
  scheduledJobContext: ScheduledJobContext;
  logWarn?: (message: string) => void;
}): Promise<ScheduledAgentRunCollection> {
  input.logWarn?.(
    `Scheduled job runtime returned progress-only output before tool call; retrying run jobId=${input.job.jobId}`,
  );
  const collected = collectAgentRunWithEvents(input.runner, {
    ...input.agentInput,
    text: buildScheduledProgressRetryPrompt(
      input.job.prompt,
      input.scheduledJobContext.allowedTools,
    ),
  });
  const result = await collected.output;
  if (isRuntimeProgressOnlyResponseText(result.text)) {
    throw new Error(
      "Managed runtime final response contained only runtime-control/progress text after scheduled task retry",
    );
  }
  return { output: result, events: collected.events };
}

async function collectScheduledAgentRunTransientRetry(input: {
  runner: AgentRunner;
  agentInput: AgentInput;
  job: ScheduledJobRecord;
  scheduledJobContext: ScheduledJobContext;
  error: unknown;
  scheduledRuntimeRetryDelayMs?: (attempt: number) => number;
  scheduledRuntimeRetrySleep?: (delayMs: number) => Promise<void>;
  logWarn?: (message: string) => void;
}): Promise<ScheduledAgentRunCollection> {
  const delayMs = Math.max(
    0,
    Math.round(
      input.scheduledRuntimeRetryDelayMs?.(1) ??
        scheduledRuntimeRetryDelayMs(1),
    ),
  );
  input.logWarn?.(
    `Scheduled job runtime failed with retryable error; retrying run jobId=${input.job.jobId} delayMs=${delayMs} error=${scheduledRunErrorMessage(input.error)}`,
  );
  await (input.scheduledRuntimeRetrySleep ?? sleepFor)(delayMs);
  const collected = collectAgentRunWithEvents(input.runner, {
    ...input.agentInput,
    text: buildScheduledRuntimeRetryPrompt(
      input.job.prompt,
      input.scheduledJobContext.allowedTools,
      scheduledRunErrorMessage(input.error),
    ),
  });
  return { output: await collected.output, events: collected.events };
}

function collectAgentRunWithEvents(
  runner: AgentRunner,
  input: AgentInput,
): { output: Promise<AgentOutput>; events: AgentRunEvent[] } {
  const events: AgentRunEvent[] = [];
  return {
    output: collectAgentRun(runner, input, (event) => {
      events.push(event);
    }),
    events,
  };
}

function scheduledRunAuditTelemetry(
  telemetry: AgentOutput["telemetry"],
  events: AgentRunEvent[],
): Record<string, unknown> {
  return {
    ...(telemetry ?? {}),
    scheduledRun: {
      toolEvents: events.flatMap(sanitizeScheduledRunToolEvent),
    },
  };
}

function sanitizeScheduledRunToolEvent(
  event: AgentRunEvent,
): Array<Record<string, unknown>> {
  if (event.type === "tool_call") {
    return [
      {
        type: event.type,
        toolName: event.toolName,
        callId: event.callId,
      },
    ];
  }
  if (event.type === "tool_result") {
    return [
      {
        type: event.type,
        toolName: event.toolName,
        callId: event.callId,
        classification: event.classification,
        ...(event.status ? { status: event.status } : {}),
      },
    ];
  }
  return [];
}

export function validateScheduledRunToolEvidence(input: {
  requiredTools: readonly string[];
  events: readonly AgentRunEvent[];
}): { ok: true } | { ok: false; reason: string } {
  const successfulResults = input.events.filter(
    (event): event is Extract<AgentRunEvent, { type: "tool_result" }> =>
      event.type === "tool_result" && event.status !== "error",
  );
  for (const requiredTool of input.requiredTools) {
    const spec = findProviderToolSpec(requiredTool);
    if (spec?.risk !== "read") {
      continue;
    }
    if (
      !successfulResults.some((event) =>
        providerToolCovers(event.toolName, requiredTool),
      )
    ) {
      return {
        ok: false,
        reason: `Scheduled run did not complete required tool ${spec.name}.`,
      };
    }
  }

  const calls = new Map(
    input.events.flatMap((event) =>
      event.type === "tool_call" ? [[event.callId, event.toolName] as const] : [],
    ),
  );
  for (const event of input.events) {
    if (event.type !== "tool_result" || event.status !== "error") {
      continue;
    }
    const toolName = calls.get(event.callId) ?? event.toolName;
    const spec = findProviderToolSpec(toolName);
    if (spec && spec.risk !== "read") {
      return {
        ok: false,
        reason: `Scheduled run tool ${spec.name} failed before delivery.`,
      };
    }
  }
  return { ok: true };
}

export function scheduledRuntimeRetryDelayMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const exponentialMs = Math.min(
    DEFAULT_SCHEDULED_RUNTIME_RETRY_MAX_MS,
    DEFAULT_SCHEDULED_RUNTIME_RETRY_BASE_MS *
      2 ** Math.max(0, Math.floor(attempt) - 1),
  );
  const jitterMs =
    exponentialMs *
    DEFAULT_SCHEDULED_RUNTIME_RETRY_JITTER_RATIO *
    Math.min(1, Math.max(0, random()));
  return Math.round(
    Math.min(DEFAULT_SCHEDULED_RUNTIME_RETRY_MAX_MS, exponentialMs + jitterMs),
  );
}

async function sleepFor(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

function isProgressOnlyRuntimeFinalError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message ===
      "Managed runtime final response contained only runtime-control/progress text"
  );
}

function isRetryableScheduledRuntimeError(error: unknown): boolean {
  const message = scheduledRunErrorMessage(error);
  return (
    /\boperation timed out\b/i.test(message) ||
    /\bupstream provider timeout\b/i.test(message) ||
    /\bdid not produce a final response\b/i.test(message) ||
    /\breturned no assistant text\b/i.test(message) ||
    /\bconnection reset by peer\b/i.test(message)
  );
}

function buildScheduledProgressRetryPrompt(
  originalPrompt: string,
  allowedTools: string[],
): string {
  return [
    "Protocol correction for this same scheduled task.",
    "",
    "The previous runtime attempt returned only internal progress/control text and did not invoke a structured tool call.",
    `Allowed task tools: ${allowedTools.join(", ")}`,
    "",
    "Run the scheduled task now. If the task needs provider data, invoke the appropriate allowed tool through the structured tool protocol. Then return a normal final answer for Burble to deliver.",
    "",
    "Scheduled task:",
    originalPrompt,
  ].join("\n");
}

function buildScheduledRuntimeRetryPrompt(
  originalPrompt: string,
  allowedTools: string[],
  previousError: string,
): string {
  return [
    "Retry this same scheduled task.",
    "",
    "The previous runtime attempt failed before producing deliverable output.",
    `Previous error: ${previousError.slice(0, 240)}`,
    `Allowed task tools: ${allowedTools.join(", ")}`,
    "",
    "Run the scheduled task now. Use only the allowed read-only tools needed for the task, then return a normal final answer for Burble to deliver.",
    "",
    "Scheduled task:",
    originalPrompt,
  ].join("\n");
}

function appendWorkflowEvent(
  store: TaskWorkflowEventStore,
  event: TaskWorkflowEvent,
): void {
  store.appendEvent({
    eventId: workflowEventId(event),
    event,
    recordedAt: "at" in event ? event.at : new Date().toISOString(),
    ...(event.type === "task_triggered" ? { signalId: event.triggerKey } : {}),
  });
}

function workflowEventId(event: TaskWorkflowEvent): string {
  switch (event.type) {
    case "task_triggered":
      return `shadow:${event.jobRunId}:task_triggered`;
    case "validation_passed":
      return `shadow:${event.jobRunId}:validation_passed`;
    case "validation_failed":
      return `shadow:${event.jobRunId}:validation_failed`;
    case "attempt_started":
      return `shadow:${event.jobRunId}:attempt_started:${event.attempt}`;
    case "attempt_succeeded":
      return `shadow:${event.jobRunId}:attempt_succeeded:${event.attempt}:${encodeURIComponent(event.outputDigest)}`;
    case "attempt_failed":
      return `shadow:${event.jobRunId}:attempt_failed:${event.attempt}:${encodeURIComponent(event.failureClass)}`;
    case "run_heartbeat":
      return `workflow:${event.jobRunId}:heartbeat:${encodeURIComponent(event.at)}`;
    case "delivery_started":
      return `shadow:${event.jobRunId}:delivery_started:${encodeURIComponent(event.deliveryKey)}`;
    case "delivery_succeeded":
      return `shadow:${event.jobRunId}:delivery_succeeded:${encodeURIComponent(event.deliveryKey)}`;
    case "run_reconciled_succeeded":
      return `workflow:${event.jobRunId}:run_reconciled_succeeded`;
    case "delivery_failed":
      return `shadow:${event.jobRunId}:delivery_failed:${encodeURIComponent(event.deliveryKey ?? "no-key")}:${encodeURIComponent(event.failureClass ?? "delivery_failed")}`;
    case "handler_failed":
      return `workflow:${event.jobRunId}:handler_failed:${event.commandType}:${encodeURIComponent(event.failureClass)}:${event.attempt ?? "no-attempt"}:${encodeURIComponent(event.outputDigest ?? "no-output")}`;
    case "side_effect_failed":
      return `workflow:${event.jobRunId ?? event.taskId}:side_effect_failed:${event.commandType}:${encodeURIComponent(event.failureClass ?? "no-class")}`;
    case "side_effect_failure_acknowledged":
      return `workflow:side_effect_acknowledged:${encodeURIComponent(event.failureId)}`;
  }
}

function workflowTriggerKey(run: AgentJobRunRecord): string {
  return `${run.jobId}:${run.triggerSource}:${run.runId}`;
}

function workflowDeliveryKey(
  runId: string,
  routeId: string | null | undefined,
  outputDigest: string,
): string {
  return `${runId}:${routeId ?? "no-route"}:${outputDigest}`;
}

class ScheduledWorkflowRunError extends Error {
  readonly failureNotificationSent: boolean;

  constructor(message: string, input: { failureNotificationSent: boolean }) {
    super(message);
    this.name = "ScheduledWorkflowRunError";
    this.failureNotificationSent = input.failureNotificationSent;
  }
}

function workflowErrorNotificationWasSent(error: unknown): boolean {
  return (
    error instanceof ScheduledWorkflowRunError && error.failureNotificationSent
  );
}

function outputTextDigest(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function textByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function scheduledRunErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Scheduled job run failed";
}

function scheduledJobContextForRun(
  store: Pick<TokenStore, "getAgentJobCapability">,
  job: ScheduledJobRecord,
  toolGroups: string[],
): ScheduledJobContext | undefined {
  const capability = store.getAgentJobCapability(job.jobId);
  if (capability) {
    const context = buildScheduledJobContext(capability);
    return isDeliveryOnlyScheduledJobContext(context) ? undefined : context;
  }

  const allowedTools = inferAllowedToolsForScheduledJob(job, toolGroups);
  if (!allowedTools.length) {
    return undefined;
  }
  return {
    jobId: job.jobId,
    capabilityProfile: "scheduled_job",
    allowedTools,
    ...(job.routeId ? { routeId: job.routeId } : {}),
    ...(job.runtimeType
      ? { runtimeType: job.runtimeType as AgentRuntimeEngine }
      : {}),
    stateRefs: [],
    visibilityPolicy: {},
  };
}

function resolvedExecutionToolsForRun(
  store: Pick<TokenStore, "getAgentJobCapability">,
  job: ScheduledJobRecord,
): string[] {
  const expectedTools = store.getAgentJobCapability(job.jobId)?.expectedTools;
  return expectedTools ? expandProviderToolDependencies(expectedTools) : [];
}

function isDeliveryOnlyScheduledJobContext(
  context: ScheduledJobContext,
): boolean {
  return (
    context.allowedTools.length === 0 ||
    context.allowedTools.every((tool) => tool === "conversation.sendMessage")
  );
}

function scheduledRunConversationRoot(
  job: ScheduledJobRecord,
  run: { runId: string },
): string {
  return `scheduled:${job.jobId}:${run.runId}`;
}

function connectionForSlackUser(
  store: Pick<TokenStore, "getConnectionForSlackUser">,
  provider: Parameters<TokenStore["getConnectionForSlackUser"]>[0],
  run: AgentJobRunRecord,
): ProviderConnection | null {
  return store.getConnectionForSlackUser(provider, run.slackUserId);
}

function readSlackRouteDestination(route: ConversationRouteRecord): {
  channelId: string;
  isDirectMessage: boolean;
  rootId?: string;
  threadTs?: string;
} | null {
  if (route.transport !== "slack" || route.revokedAt) {
    return null;
  }
  try {
    const parsed = JSON.parse(route.destinationJson) as Record<string, unknown>;
    if (typeof parsed.channelId !== "string") {
      return null;
    }
    return {
      channelId: parsed.channelId,
      isDirectMessage: parsed.isDirectMessage === true,
      ...(typeof parsed.rootId === "string" ? { rootId: parsed.rootId } : {}),
      ...(typeof parsed.threadTs === "string"
        ? { threadTs: parsed.threadTs }
        : {}),
    };
  } catch {
    return null;
  }
}
