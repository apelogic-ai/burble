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
  type TaskWorkflowShadowStore,
} from "../workflow/task-workflow-shadow";
import { TASK_WORKFLOW_RUNTIME_FAILURE_CLASS } from "../workflow/task-workflow";

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
  workflowShadowStore?: TaskWorkflowShadowStore;
  logInfo?: (message: string) => void;
  logWarn?: (message: string) => void;
}): SchedulerRunExecutor {
  return {
    async executeRun(runId) {
      const run = input.store.claimAgentJobRun(runId);
      if (!run) {
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
