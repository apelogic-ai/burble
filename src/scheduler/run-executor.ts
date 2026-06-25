import type { AgentRunner } from "../agent/types";
import { collectAgentRun } from "../agent/types";
import { selectRuntimeToolGroups } from "../agent/tool-groups";
import type {
  AgentJobRunRecord,
  AgentRuntimeEngine,
  ConversationRouteRecord,
  ProviderConnection,
  TokenStore
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

      try {
        const job = input.store.getScheduledJob(run.jobId);
        if (!job) {
          throw new Error("Scheduled job not found");
        }

        const route = job.routeId
          ? input.store.getConversationRoute(job.routeId)
          : null;
        const destination = route ? readSlackRouteDestination(route) : null;
        if (job.routeId && !destination) {
          throw new Error("Scheduled job delivery route is unavailable");
        }

        input.logInfo?.(
          `Scheduled job run start runId=${run.runId} jobId=${job.jobId}`
        );
        const result = await collectAgentRun(input.agentRunner, {
          principal: {
            workspaceId: run.workspaceId,
            slackUserId: run.slackUserId
          },
          executionMode: "native-runtime",
          ...(destination
            ? {
                conversation: {
                  routeId: route?.id,
                  source: "slack" as const,
                  workspaceId: run.workspaceId,
                  channelId: destination.channelId,
                  rootId: destination.rootId ?? `scheduled:${job.jobId}`,
                  isDirectMessage: destination.isDirectMessage
                }
              }
            : {}),
          text: job.prompt,
          toolGroups: selectRuntimeToolGroups({
            text: job.prompt,
            attachmentCount: 0,
            contextTexts: []
          }),
          scheduledJob: {
            jobId: job.jobId,
            capabilityProfile: "scheduled_job",
            allowedTools: [],
            ...(job.routeId ? { routeId: job.routeId } : {}),
            ...(job.runtimeType
              ? { runtimeType: job.runtimeType as AgentRuntimeEngine }
              : {}),
            stateRefs: [],
            visibilityPolicy: {}
          },
          connections: {
            github: connectionForSlackUser(input.store, "github", run),
            google: connectionForSlackUser(input.store, "google", run),
            hubspot: connectionForSlackUser(input.store, "hubspot", run),
            jira: connectionForSlackUser(input.store, "jira", run),
            slack: connectionForSlackUser(input.store, "slack", run)
          }
        });

        if (destination && result.text.trim()) {
          await input.slackClient.chat.postMessage({
            channel: destination.channelId,
            text: result.text,
            ...(destination.threadTs && !destination.isDirectMessage
              ? { thread_ts: destination.threadTs }
              : {})
          });
        }

        input.store.finishAgentJobRun({
          runId: run.runId,
          status: "succeeded"
        });
        input.logInfo?.(
          `Scheduled job run finish runId=${run.runId} jobId=${job.jobId}`
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Scheduled job run failed";
        input.store.finishAgentJobRun({
          runId: run.runId,
          status: "failed",
          failureReason: message.slice(0, 500)
        });
        input.logWarn?.(
          `Scheduled job run failed runId=${run.runId} error=${message}`
        );
      }
    }
  };
}

function connectionForSlackUser(
  store: Pick<TokenStore, "getConnectionForSlackUser">,
  provider: Parameters<TokenStore["getConnectionForSlackUser"]>[0],
  run: AgentJobRunRecord
): ProviderConnection | null {
  return store.getConnectionForSlackUser(provider, run.slackUserId);
}

function readSlackRouteDestination(route: ConversationRouteRecord):
  | {
      channelId: string;
      isDirectMessage: boolean;
      rootId?: string;
      threadTs?: string;
    }
  | null {
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
        : {})
    };
  } catch {
    return null;
  }
}
