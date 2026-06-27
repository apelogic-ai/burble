import type { AgentRunner } from "../agent/types";
import { collectAgentRun } from "../agent/types";
import { selectRuntimeToolGroups } from "../agent/tool-groups";
import {
  buildScheduledJobContext,
  type ScheduledJobContext,
} from "../agent/scheduled-job-context";
import { isRuntimeProgressOnlyResponseText } from "../agent/runtime-control-notices";
import { inferAllowedToolsForScheduledJob } from "./job-capabilities";
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
        const toolGroups = selectRuntimeToolGroups({
          text: job.prompt,
          attachmentCount: 0,
          contextTexts: [],
        });
        const result = await collectAgentRun(input.agentRunner, {
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
          text: job.prompt,
          toolGroups,
          scheduledJob: scheduledJobContextForRun(
            input.store,
            job,
            toolGroups.groups,
          ),
          connections: {
            github: connectionForSlackUser(input.store, "github", run),
            google: connectionForSlackUser(input.store, "google", run),
            hubspot: connectionForSlackUser(input.store, "hubspot", run),
            jira: connectionForSlackUser(input.store, "jira", run),
            slack: connectionForSlackUser(input.store, "slack", run),
          },
        });

        const resultText = result.text.trim();
        if (
          destination &&
          resultText &&
          !isRuntimeProgressOnlyResponseText(resultText)
        ) {
          await input.slackClient.chat.postMessage({
            channel: destination.channelId,
            text: resultText,
            ...(destination.threadTs && !destination.isDirectMessage
              ? { thread_ts: destination.threadTs }
              : {}),
          });
        } else if (
          resultText &&
          isRuntimeProgressOnlyResponseText(resultText)
        ) {
          input.logWarn?.(
            `Scheduled job run suppressed runtime-control output runId=${run.runId} jobId=${job.jobId}`,
          );
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

function scheduledJobContextForRun(
  store: Pick<TokenStore, "getAgentJobCapability">,
  job: ScheduledJobRecord,
  toolGroups: string[],
): ScheduledJobContext {
  const capability = store.getAgentJobCapability(job.jobId);
  if (capability) {
    return buildScheduledJobContext(capability);
  }

  return {
    jobId: job.jobId,
    capabilityProfile: "scheduled_job",
    allowedTools: inferAllowedToolsForScheduledJob(job, toolGroups),
    ...(job.routeId ? { routeId: job.routeId } : {}),
    ...(job.runtimeType
      ? { runtimeType: job.runtimeType as AgentRuntimeEngine }
      : {}),
    stateRefs: [],
    visibilityPolicy: {},
  };
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
