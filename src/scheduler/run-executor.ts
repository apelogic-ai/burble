import type { AgentInput, AgentRunEvent, AgentRunner } from "../agent/types";
import { collectAgentRun } from "../agent/types";
import { selectRuntimeToolGroups } from "../agent/tool-groups";
import {
  buildScheduledJobContext,
  type ScheduledJobContext,
} from "../agent/scheduled-job-context";
import { isRuntimeProgressOnlyResponseText } from "../agent/runtime-control-notices";
import { containsRuntimeToolCallProtocolFragments } from "@burble/runtime-sdk/runtime-text-protocol";
import { inferAllowedToolsForScheduledJob } from "./job-capabilities";
import { providerToolCatalog } from "../providers/catalog";
import type {
  AgentJobRunRecord,
  AgentRuntimeEngine,
  ConversationRouteRecord,
  ProviderConnection,
  ScheduledJobRecord,
  TokenStore,
} from "../db";

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
    | "getAgentJobCapability"
    | "getScheduledJob"
    | "getConversationRoute"
    | "getConnectionForSlackUser"
  >;
  agentRunner: AgentRunner;
  slackClient: SlackPostClient;
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
        const runtimePrompt = runtimePromptForScheduledJob(job.prompt);
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

        const resultText = result.text.trim();
        if (resultText && isRuntimeProgressOnlyResponseText(resultText)) {
          throw new Error(
            "Managed runtime final response contained only runtime-control/progress text",
          );
        }
        if (containsRuntimeToolCallProtocolFragments(resultText)) {
          throw new Error(
            "Managed runtime final response leaked tool-call protocol text",
          );
        }
        if (destination && resultText) {
          await input.slackClient.chat.postMessage({
            channel: destination.channelId,
            text: resultText,
            ...(destination.threadTs && !destination.isDirectMessage
              ? { thread_ts: destination.threadTs }
              : {}),
          });
        }

        input.store.finishAgentJobRun({
          runId: run.runId,
          status: "succeeded",
        });
        input.logInfo?.(
          `Scheduled job run finish runId=${run.runId} jobId=${job.jobId}`,
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Scheduled job run failed";
        input.store.finishAgentJobRun({
          runId: run.runId,
          status: "failed",
          failureReason: message.slice(0, 500),
        });
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
    scheduledJobContext.allowedTools.every((toolName) => {
      const spec = findProviderToolSpec(toolName);
      return spec?.risk === "read";
    }),
  );
}

function findProviderToolSpec(toolName: string) {
  return (
    providerToolCatalog.find(
      (tool) =>
        tool.name === toolName ||
        tool.alias === toolName ||
        tool.aliases?.includes(toolName),
    ) ?? null
  );
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

function runtimePromptForScheduledJob(prompt: string): string {
  const literalMessage = readLiteralScheduledMessage(prompt);
  if (!literalMessage) {
    return prompt;
  }
  return `Return exactly this message as your entire final answer, with no extra text. Do not call tools for delivery; Burble will deliver your final answer.\n\n${literalMessage}`;
}

function readLiteralScheduledMessage(prompt: string): string | null {
  const match = /^Post exactly this message:\s*(?<message>.+)$/isu.exec(
    prompt.trim(),
  );
  const message = match?.groups?.message?.trim();
  return message ? message : null;
}

function scheduledRunConversationRoot(
  job: ScheduledJobRecord,
  run: AgentJobRunRecord,
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

function formatScheduledJobFailureMessage(
  job: ScheduledJobRecord,
  run: AgentJobRunRecord,
  message: string,
): string {
  const title = job.title?.trim() || job.jobId;
  return [
    `Scheduled job failed: ${title}`,
    `Job ID: ${job.jobId}`,
    `Run ID: ${run.runId}`,
    `Reason: ${message.slice(0, 500)}`,
  ].join("\n");
}
