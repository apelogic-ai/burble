import { createHash } from "node:crypto";
import type { AgentInput, AgentRunEvent, AgentRunner } from "../agent/types";
import { collectAgentRun } from "../agent/types";
import { selectRuntimeToolGroups } from "../agent/tool-groups";
import {
  buildScheduledJobContext,
  type ScheduledJobContext,
} from "../agent/scheduled-job-context";
import { isRuntimeProgressOnlyResponseText } from "../agent/runtime-control-notices";
import { inferAllowedToolsForScheduledJob } from "./job-capabilities";
import { findProviderToolSpec } from "../providers/catalog";
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

export type SchedulerRunExecutor = {
  executeRun(runId: string): Promise<void>;
};

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
  >;
  agentRunner: AgentRunner;
  slackClient: SlackPostClient;
  workflowShadowStore?: TaskWorkflowEventStore;
  workflowAuthority?: "off" | "manual" | "timer";
  logInfo?: (message: string) => void;
  logWarn?: (message: string) => void;
}): SchedulerRunExecutor {
  return {
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
      let job: ScheduledJobRecord | null = null;
      let destination: ReturnType<typeof readSlackRouteDestination> = null;

      try {
        job = input.store.getScheduledJob(run.jobId);
        if (!job) {
          throw new Error("Scheduled job not found");
        }

        const route = job.routeId
          ? input.store.getConversationRoute(job.routeId)
          : null;
        destination = route ? readSlackRouteDestination(route) : null;
        if (job.routeId && !destination) {
          throw new Error("Scheduled job delivery route is unavailable");
        }

        input.logInfo?.(
          `Scheduled job run start runId=${run.runId} jobId=${job.jobId}`,
        );
        recordTaskWorkflowRunStarted({
          store: input.workflowShadowStore,
          run,
          logWarn: input.logWarn,
        });
        const runtimePrompt = scheduledTaskRuntimePrompt(job.prompt);
        const toolGroups = selectRuntimeToolGroups({
          text: runtimePrompt,
          attachmentCount: 0,
          contextTexts: [],
        });
        const scheduledJobContext = scheduledJobContextForRun(
          input.store,
          job,
          toolGroups.groups,
        );
        const agentInput: AgentInput = {
          principal: {
            workspaceId: run.workspaceId,
            slackUserId: run.slackUserId,
          },
          executionMode: "native-runtime",
          ...(destination
            ? {
                conversation: {
                  routeId: route?.id,
                  source: "slack" as const,
                  workspaceId: run.workspaceId,
                  channelId: destination.channelId,
                  rootId: scheduledRunConversationRoot(job, run),
                  isDirectMessage: destination.isDirectMessage,
                },
              }
            : {}),
          text: runtimePrompt,
          toolGroups,
          ...(scheduledJobContext ? { scheduledJob: scheduledJobContext } : {}),
          connections: {
            github: connectionForSlackUser(input.store, "github", run),
            google: connectionForSlackUser(input.store, "google", run),
            hubspot: connectionForSlackUser(input.store, "hubspot", run),
            jira: connectionForSlackUser(input.store, "jira", run),
            slack: connectionForSlackUser(input.store, "slack", run),
          },
        };
        const result = await collectScheduledAgentRunWithProgressRetry({
          runner: input.agentRunner,
          agentInput,
          job,
          scheduledJobContext,
          logWarn: input.logWarn,
        });

        const output = validateScheduledJobOutput(result);
        if (!output.ok) {
          throw new Error(output.reason);
        }
        if (destination) {
          await input.slackClient.chat.postMessage({
            channel: destination.channelId,
            text: output.text,
            ...(destination.threadTs && !destination.isDirectMessage
              ? { thread_ts: destination.threadTs }
              : {}),
          });
        }
        const finishedRun =
          input.store.finishAgentJobRun({
            runId: run.runId,
            status: "succeeded",
          }) ?? input.store.getAgentJobRun(run.runId);
        if (finishedRun?.status === "succeeded") {
          recordTaskWorkflowRunSucceeded({
            store: input.workflowShadowStore,
            run: finishedRun,
            outputText: output.text,
            routeId: job.routeId,
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
          `Scheduled job run finish runId=${run.runId} jobId=${job.jobId}`,
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
        if (job && destination) {
          try {
            await input.slackClient.chat.postMessage({
              channel: destination.channelId,
              text: formatScheduledJobFailureMessage(job, run, message),
              ...(destination.threadTs && !destination.isDirectMessage
                ? { thread_ts: destination.threadTs }
                : {}),
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
    >;
    agentRunner: AgentRunner;
    slackClient: SlackPostClient;
    workflowShadowStore: TaskWorkflowEventStore;
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

  const route = job.routeId
    ? input.store.getConversationRoute(job.routeId)
    : null;
  const destination = route ? readSlackRouteDestination(route) : null;
  const runtimePrompt = scheduledTaskRuntimePrompt(job.prompt);
  const toolGroups = selectRuntimeToolGroups({
    text: runtimePrompt,
    attachmentCount: 0,
    contextTexts: [],
  });
  const scheduledJobContext = scheduledJobContextForRun(
    input.store,
    job,
    toolGroups.groups,
  );
  const outputByDigest = new Map<string, string>();
  let failureNotificationSent = false;

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
        await ctx.heartbeat({
          taskId: command.taskId,
          jobRunId: command.jobRunId,
        });
        if (job.routeId && !destination) {
          throw new Error("Scheduled job delivery route is unavailable");
        }
        const agentInput: AgentInput = {
          principal: {
            workspaceId: run.workspaceId,
            slackUserId: run.slackUserId,
          },
          executionMode: "native-runtime",
          ...(destination
            ? {
                conversation: {
                  routeId: route?.id,
                  source: "slack" as const,
                  workspaceId: run.workspaceId,
                  channelId: destination.channelId,
                  rootId: scheduledRunConversationRoot(job, run),
                  isDirectMessage: destination.isDirectMessage,
                },
              }
            : {}),
          text: runtimePrompt,
          toolGroups,
          ...(scheduledJobContext ? { scheduledJob: scheduledJobContext } : {}),
          connections: {
            github: connectionForSlackUser(input.store, "github", run),
            google: connectionForSlackUser(input.store, "google", run),
            hubspot: connectionForSlackUser(input.store, "hubspot", run),
            jira: connectionForSlackUser(input.store, "jira", run),
            slack: connectionForSlackUser(input.store, "slack", run),
          },
        };
        const result = await collectScheduledAgentRunWithProgressRetry({
          runner: input.agentRunner,
          agentInput,
          job,
          scheduledJobContext,
          logWarn: input.logWarn,
        });
        const output = validateScheduledJobOutput(result);
        if (!output.ok) {
          throw new Error(output.reason);
        }
        const outputDigest = outputTextDigest(output.text);
        outputByDigest.set(outputDigest, output.text);
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
      const text = outputByDigest.get(command.outputDigest);
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
        if (!text) {
          throw new Error("Scheduled job output artifact is unavailable");
        }
        if (destination) {
          await input.slackClient.chat.postMessage({
            channel: destination.channelId,
            text,
            ...(destination.threadTs && !destination.isDirectMessage
              ? { thread_ts: destination.threadTs }
              : {}),
          });
          outputDelivered = true;
        }
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
        await input.slackClient.chat.postMessage({
          channel: destination.channelId,
          text: formatScheduledJobFailureMessage(job, run, command.reason),
          ...(destination.threadTs && !destination.isDirectMessage
            ? { thread_ts: destination.threadTs }
            : {}),
        });
        failureNotificationSent = true;
      }
      return null;
    },
  };

  try {
    await runTaskWorkflowDriver({
      initialState: input.workflowShadowStore.replayState(),
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
  logWarn?: (message: string) => void;
}) {
  const events: AgentRunEvent[] = [];
  try {
    const result = await collectAgentRun(
      input.runner,
      input.agentInput,
      (event) => {
        events.push(event);
      },
    );
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
    return result;
  } catch (error) {
    const retryContext = progressOnlyScheduledRunRetryContext(
      events,
      input.scheduledJobContext,
    );
    if (!isProgressOnlyRuntimeFinalError(error) || !retryContext) {
      throw error;
    }
    return collectScheduledAgentRunProgressRetry({
      ...input,
      scheduledJobContext: retryContext,
    });
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
}) {
  input.logWarn?.(
    `Scheduled job runtime returned progress-only output before tool call; retrying run jobId=${input.job.jobId}`,
  );
  const result = await collectAgentRun(input.runner, {
    ...input.agentInput,
    text: buildScheduledProgressRetryPrompt(
      input.job.prompt,
      input.scheduledJobContext.allowedTools,
    ),
  });
  if (isRuntimeProgressOnlyResponseText(result.text)) {
    throw new Error(
      "Managed runtime final response contained only runtime-control/progress text after scheduled task retry",
    );
  }
  return result;
}

function isProgressOnlyRuntimeFinalError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message ===
      "Managed runtime final response contained only runtime-control/progress text"
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
