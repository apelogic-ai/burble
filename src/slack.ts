import { App, LogLevel } from "@slack/bolt";
import { stripRuntimeToolCallProtocolFragments } from "@burble/runtime-sdk/runtime-text-protocol";
import type { View } from "@slack/types";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import {
  isRuntimeControlNotice,
  isRuntimeProgressOnlyMessage,
  runtimeControlNoticeFallbackText
} from "./agent/runtime-control-notices";
import {
  agentRuntimeEngines,
  defaultAgentRuntimeImage,
  defaultAgentRuntimeSandboxStartCommand,
  isDefaultAgentRuntimeImage,
  type AgentRuntimeStreamingMode,
  type Config
} from "./config";
import type { SlackLogLevel } from "./config";
import { markdownToSlackMrkdwn } from "./slack-mrkdwn";
import {
  addGitHubIssueLabels,
  buildGitHubOAuthUrl,
  commentOnGitHubIssueOrPullRequest,
  createGitHubIssue,
  createGitHubPullRequest,
  getGitHubUser,
  listAssignedIssues,
  listMyPullRequests,
  removeGitHubIssueLabels,
  requestGitHubPullRequestReview,
  searchIssues,
  updateGitHubPullRequest
} from "./providers/github/client";
import {
  buildGoogleOAuthUrl,
  copyGoogleSlidesPresentation,
  createGoogleDriveTextFile,
  createGoogleDocsDocument,
  createGoogleSlidesSlide,
  fillGoogleSlidesPlaceholders,
  getGoogleAnalyticsMetadata,
  getGoogleSlidesPresentation,
  getGoogleUser,
  listGoogleAnalyticsProperties,
  listGoogleSharedDrives,
  probeGoogleSlidesTemplate,
  refreshGoogleAccessToken,
  runGoogleAnalyticsReport,
  searchGoogleCalendarEvents,
  searchGoogleDriveFiles,
  searchGoogleSlidesPresentations,
  searchGoogleMailMessages
} from "./providers/google/client";
import {
  buildHubSpotOAuthUrl,
  getHubSpotAccessTokenInfo,
  listHubSpotOwners,
  listHubSpotUsers,
  readHubSpotApiResource,
  refreshHubSpotAccessToken,
  searchHubSpotCompanies,
  searchHubSpotContacts,
  searchHubSpotDeals,
  searchHubSpotReadableCrmObjects
} from "./providers/hubspot/client";
import {
  buildJiraOAuthUrl,
  getJiraUser,
  listAssignedJiraIssues,
  refreshJiraAccessToken,
  searchJiraIssues
} from "./providers/jira/client";
import {
  buildSlackOAuthUrl,
  searchSlackMessages,
  searchSlackUsers
} from "./providers/slack/client";
import {
  connectedProviderDescriptors,
  connectedProviderIds,
  isConnectedProviderId
} from "./providers/descriptors";
import type {
  AgentRuntimeRecord,
  AgentJobRunRecord,
  AgentRuntimeEngine,
  AgentRuntimeStatus,
  ConversationRouteRecord,
  Provider,
  ProviderConnection,
  TokenStore
} from "./db";
import {
  formatScheduledJobCreateResult,
  formatScheduledJobDeleteResult,
  formatScheduledJobList,
  formatScheduledJobMutationResult,
  formatScheduledJobPromptUpdateResult,
  formatScheduledJobRunList,
  formatScheduledJobScheduleUpdateResult,
  formatScheduledJobTriggerResult,
  formatScheduledRunStatusResult,
  formatScheduledTaskDetailResult,
  formatScheduledTaskValidationResult,
  handleConversation
} from "./conversation/orchestrator";
import { normalizeMentionText } from "./conversation/normalize";
import { createLlmSchedulerIntentResolver } from "./conversation/scheduler-intent-resolver";
import {
  createSchedulerControlPlane,
  type SchedulerControlPlane,
  type SchedulerRunStatusResult,
  type SchedulerShowTaskResult,
  type SchedulerValidateTaskResult,
  type SchedulerTaskSummary
} from "./scheduler/control-plane";
import { DEFAULT_ACTIVE_RUN_TTL_MS } from "./scheduler/active-run";
import { defaultResolveSlackChannelIdByName } from "./tool-gateway";
import { createSchedulerRunExecutor } from "./scheduler/run-executor";
import { createScheduledRunAuditMaintenanceLoop } from "./scheduler/run-audit-maintenance";
import { createScheduledRuntimeAdmissionValidator } from "./scheduler/runtime-admission";
import { createSchedulerTimer } from "./scheduler/timer";
import { createTaskWorkflowMaintenanceLoop } from "./workflow/task-workflow-maintenance";
import { createTaskWorkflowOracleLoop } from "./workflow/task-workflow-oracle";
import { createTaskWorkflowReconcileLoop } from "./workflow/task-workflow-reconcile";
import { assessTaskWorkflowAuthorityReadiness } from "./workflow/task-workflow-readiness";
import {
  finishAuthoritativeRunForStaleWorkflowFailure,
  recordWorkflowRunSucceededFromAuthoritative
} from "./workflow/task-workflow-authority";
import { createSqliteTaskWorkflowEventStore } from "./workflow/task-workflow-sqlite-store";
import type {
  ConversationAttachment,
  ConversationRequest,
  ConversationResponse,
  SchedulerIntentResolver,
  ToolClassification
} from "./conversation/types";
import { createConfiguredAgentRunner } from "./agent/runtime";
import {
  collectAgentRun,
  type AgentRunEvent,
  type AgentUsage
} from "./agent/types";
import { validateAgentModelId } from "./agent/providers";
import { selectRuntimeToolGroups } from "./agent/tool-groups";
import { createDockerRuntimeFactory } from "./agent/container-runtime-factory";
import { createSandboxRuntimeFactory } from "./agent/sandbox-runtime-factory";
import type { SandboxRuntimeFetch } from "./agent/sandbox-runtime-factory";
import type { SandboxProvider } from "./agent/sandbox-provider";
import { modelProviderUrlsForRuntimeModel } from "./agent/runtime-env";
import {
  buildRuntimeManifestForPrincipal,
  isActiveAgentRuntime,
  RuntimeEngineSelectionError,
  resolveRuntimeEngineForPrincipal,
  type RuntimeEngineSelection
} from "./agent/runtime-policy";
import { createStaticRuntimeFactory } from "./agent/runtime-factory";
import type { RuntimeFactory } from "./agent/runtime-factory";
import type { RuntimeToolGroupSelection } from "./agent/tool-groups";
import { createGitHubTools } from "./tools/github";
import { createGoogleTools } from "./tools/google";
import { createHubSpotTools } from "./tools/hubspot";
import { createJiraTools } from "./tools/jira";
import { createSlackTools } from "./tools/slack";
import {
  formatConnectGitHubMessage,
  formatGitHubIdentityMessage,
  formatIssuesMessage,
  formatMentionWorkingMessage,
  formatWorkingMessage
} from "./formatting";
import { formatLogError, withUtcTimestamp } from "./logging";
import {
  createNoopObservabilitySink,
  type ObservabilitySink
} from "./observability";
import type { RuntimeJwtIssuer } from "./runtime-jwt";
import type { McpIdentityIssuer } from "./mcp-identity";
import {
  createMcpGwGoogleAuthService,
  type McpGwGoogleAuthService,
} from "./mcp/mcp-gw-google-auth-service";
import type { McpGwGoogleAuthStatus } from "./mcp/mcp-gw-google-auth-client";

export {
  formatConnectGitHubMessage,
  formatGitHubIdentityMessage,
  formatIssuesMessage,
  formatMentionWorkingMessage,
  formatWorkingMessage
} from "./formatting";

export type SlackRuntime = {
  app: App;
  runtimeFactory?: RuntimeFactory;
  getSlackEmail: (userId: string) => Promise<string>;
  close: () => void;
};

export type SlackRuntimeOptions = {
  sandboxProvider?: SandboxProvider;
  sandboxStartCommand?: string[];
  sandboxModelProviderUrls?: string[];
  sandboxFetch?: SandboxRuntimeFetch;
  schedulerIntentResolver?: SchedulerIntentResolver;
  mcpIdentityIssuer?: McpIdentityIssuer;
  mcpGwGoogleAuthService?: McpGwGoogleAuthService;
  testbed?: boolean;
};

function createNoopSlackReceiver() {
  return {
    init: () => undefined,
    start: async () => undefined,
    stop: async () => undefined
  };
}

type SlackDirectMessageEvent = {
  channel_type?: string;
  channel?: string;
  user?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  subtype?: string;
  bot_id?: string;
  files?: SlackFileReference[];
};

type SlackFileReference = {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
};

type SlackRecentMessage = {
  author: "user" | "assistant";
  speaker?: string;
  text: string;
};

type SlackRecentMessageRead = {
  messages: SlackRecentMessage[];
  historyError?: string;
};

type SlackHistoryMessage = {
  text?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  ts?: string;
};

type SlackProgressMessage = {
  channel: string;
  ts: string;
  text: string;
  threadTs?: string;
  streamingMode?: AgentRuntimeStreamingMode;
  streamedText?: string;
  nativeStreamTs?: string;
  nativeStreamPendingText?: string;
  nativeStreamUpdatedAtMs?: number;
  nativeStreamStopped?: boolean;
  nativeStreamFallbackReason?: string;
  suppressedRuntimeControlNotice?: boolean;
  startedAtMs: number;
  updatedAtMs?: number;
  toolStartedAtMs: Record<string, number>;
  toolLinesByCallId: Record<string, string>;
  toolCallOrder: string[];
};

type LazyAgentProgressReporter = {
  getProgressMessage: () => SlackProgressMessage | undefined;
  onAgentEvent: (event: AgentRunEvent) => Promise<void>;
};

const minSlackProgressStreamUpdateIntervalMs = 1_000;
const minSlackNativeStreamAppendIntervalMs = 500;
const slackNativeStreamReplacementFallbackText =
  "_Response continued in the main message._";

type SlackNativeStreamChatClient = {
  startStream?: (input: {
    channel: string;
    thread_ts: string;
    markdown_text?: string;
  }) => Promise<{ ts?: string }>;
  appendStream?: (input: {
    channel: string;
    ts: string;
    markdown_text: string;
  }) => Promise<unknown>;
  stopStream?: (input: {
    channel: string;
    ts: string;
    markdown_text?: string;
    blocks?: unknown[];
  }) => Promise<unknown>;
};

type AgentExecTaskStatus = "running" | "stopping" | "stopped" | "finished" | "failed";

type AgentExecTask = {
  id: string;
  workspaceId: string;
  slackUserId: string;
  channelId: string;
  task: string;
  status: AgentExecTaskStatus;
  createdAtMs: number;
  updatedAtMs: number;
  progressText: string;
  runtimeId?: string;
  stopRequested?: boolean;
  message?: SlackProgressMessage;
  finalText?: string;
  failureText?: string;
};

export function createSlackRuntime(
  config: Config,
  store: TokenStore,
  runtimeJwtIssuer?: RuntimeJwtIssuer,
  observability: ObservabilitySink = createNoopObservabilitySink(),
  options: SlackRuntimeOptions = {}
): SlackRuntime {
  const app = new App({
    token: config.slackBotToken,
    appToken: options.testbed ? undefined : config.slackAppToken,
    socketMode: !options.testbed,
    ...(options.testbed ? { receiver: createNoopSlackReceiver() } : {}),
    tokenVerificationEnabled: !options.testbed,
    logLevel: toBoltLogLevel(config.slackLogLevel)
  });

  app.use(async ({ body, logger, next }) => {
    logger.info(
      withUtcTimestamp(`Received Slack payload ${summarizeSlackPayload(body)}`)
    );

    await next();
  });

  async function getSlackEmail(userId: string): Promise<string> {
    const info = await app.client.users.info({ user: userId });
    const email = info.user?.profile?.email;
    if (!email) {
      throw new Error(
        "Slack profile email is unavailable. Add users:read.email and reinstall the Slack app."
      );
    }
    return email;
  }

  const mcpGwGoogleAuthService =
    options.mcpGwGoogleAuthService ??
    (config.googleViaMcpGw &&
    config.mcpGwMcpUrl &&
    config.mcpGwAudience &&
    options.mcpIdentityIssuer
      ? createMcpGwGoogleAuthService({
          mcpUrl: config.mcpGwMcpUrl,
          audience: config.mcpGwAudience,
          issuer: options.mcpIdentityIssuer,
          getSlackEmail,
        })
      : undefined);

  const createGoogleConnectUrl =
    mcpGwGoogleAuthService
      ? async (principal: { workspaceId: string; slackUserId: string }) =>
          (await mcpGwGoogleAuthService.start(principal)).authorizationUrl
      : config.googleClientId && config.googleClientSecret
        ? async (principal: { workspaceId: string; slackUserId: string }) =>
            buildGoogleOAuthUrl(
              config,
              store.createOAuthState(principal.slackUserId),
            )
        : undefined;

  const githubTools = createGitHubTools({
    getGitHubUser,
    listAssignedIssues,
    searchIssues,
    listMyPullRequests,
    createIssue: createGitHubIssue,
    commentOnIssueOrPullRequest: commentOnGitHubIssueOrPullRequest,
    createPullRequest: createGitHubPullRequest,
    updatePullRequest: updateGitHubPullRequest,
    addLabels: addGitHubIssueLabels,
    removeLabels: removeGitHubIssueLabels,
    requestReview: requestGitHubPullRequestReview
  });
  const googleTools = createGoogleTools({
    getGoogleUser,
    searchGoogleDriveFiles,
    listGoogleSharedDrives,
    createGoogleDriveTextFile,
    createGoogleDocsDocument,
    searchGoogleCalendarEvents,
    searchGoogleMailMessages,
    searchGoogleSlidesPresentations,
    getGoogleSlidesPresentation,
    probeGoogleSlidesTemplate,
    copyGoogleSlidesPresentation,
    createGoogleSlidesSlide,
    fillGoogleSlidesPlaceholders,
    listGoogleAnalyticsProperties,
    getGoogleAnalyticsMetadata,
    runGoogleAnalyticsReport,
    refreshGoogleAccessToken: (refreshToken) =>
      refreshGoogleAccessToken(config, refreshToken),
    saveGoogleConnection: (connection) => store.upsertProviderConnection(connection)
  });
  const hubspotTools = createHubSpotTools({
    getHubSpotAccessTokenInfo,
    searchHubSpotContacts,
    searchHubSpotCompanies,
    searchHubSpotDeals,
    searchHubSpotReadableCrmObjects,
    listHubSpotOwners,
    listHubSpotUsers,
    readHubSpotApiResource,
    refreshHubSpotAccessToken: (refreshToken) =>
      refreshHubSpotAccessToken(config, refreshToken),
    saveHubSpotConnection: (connection) =>
      store.upsertProviderConnection(connection)
  });
  const jiraTools = createJiraTools({
    getJiraUser,
    listAssignedJiraIssues,
    searchJiraIssues,
    refreshJiraAccessToken: (refreshToken) =>
      refreshJiraAccessToken(config, refreshToken),
    saveJiraConnection: (connection) => store.upsertProviderConnection(connection)
  });
  const slackTools = createSlackTools({
    searchSlackUsers,
    searchSlackMessages
  });
  const workflowShadowDatabase =
    config.taskWorkflowShadowEnabled && config.taskWorkflowShadowDatabasePath
      ? new Database(config.taskWorkflowShadowDatabasePath)
      : undefined;
  const workflowShadowStore = workflowShadowDatabase
    ? createSqliteTaskWorkflowEventStore(workflowShadowDatabase)
    : undefined;
  if (workflowShadowStore) {
    app.logger.info(
      withUtcTimestamp(
        `Task workflow shadow recording enabled databasePath=${config.taskWorkflowShadowDatabasePath}`
      )
    );
  }
  const taskWorkflowReplayConfig = {
    maxAttempts: config.taskWorkflowMaxAttempts
  };
  const workflowMaintenanceLoop = workflowShadowStore
    ? createTaskWorkflowMaintenanceLoop({
        store: workflowShadowStore,
        minEvents: 1_000,
        initialConfig: taskWorkflowReplayConfig,
        logInfo: (message) => app.logger.info(withUtcTimestamp(message)),
        logWarn: (message) => app.logger.warn(withUtcTimestamp(message))
      })
    : undefined;
  const workflowReconcileLoop = workflowShadowStore
    ? createTaskWorkflowReconcileLoop({
        store: workflowShadowStore,
        staleAfterMs: DEFAULT_ACTIVE_RUN_TTL_MS,
        ...(config.taskWorkflowAuthority !== "off"
          ? {
              shouldIngestStaleRunFailure: (failure) => {
                const result = finishAuthoritativeRunForStaleWorkflowFailure({
                  store,
                  failure
                });
                if (result.status === "failed") {
                  app.logger.warn(
                    withUtcTimestamp(
                      `Task workflow reconcile failed authoritative runId=${result.run.runId} status=failed`
                    )
                  );
                  return true;
                }
                if (result.status === "succeeded") {
                  recordWorkflowRunSucceededFromAuthoritative({
                    store: workflowShadowStore,
                    run: result.run,
                    workflowRun: failure.run
                  });
                  app.logger.warn(
                    withUtcTimestamp(
                      `Task workflow reconcile synced succeeded authoritative runId=${result.run.runId}`
                    )
                  );
                  return false;
                }
                app.logger.warn(
                  withUtcTimestamp(
                    [
                      "Task workflow reconcile could not fail authoritative run",
                      `runId=${failure.run.jobRunId}`,
                      `status=${result.status}`,
                      ...(result.status === "missing"
                        ? []
                        : [`authoritativeStatus=${result.run.status}`])
                    ].join(" ")
                  )
                );
                return false;
              }
            }
          : {}),
        onStaleRunFailed: (failure) => {
          if (config.taskWorkflowAuthority !== "off") {
            return;
          }
          app.logger.warn(
            withUtcTimestamp(
              `Task workflow shadow reconcile recorded stale runId=${failure.run.jobRunId}`
            )
          );
        },
        logInfo: (message) => app.logger.info(withUtcTimestamp(message)),
        logWarn: (message) => app.logger.warn(withUtcTimestamp(message))
      })
    : undefined;
  const workflowOracleLoop = workflowShadowStore
    ? createTaskWorkflowOracleLoop({
        replayWorkflowState: () =>
          workflowShadowStore.replayState({
            initialConfig: taskWorkflowReplayConfig
          }),
        listAuthoritativeRuns: () => store.listRecentAgentJobRuns(5_000),
        logWarn: (message) => app.logger.warn(withUtcTimestamp(message))
      })
    : undefined;
  const workflowAuthorityReadiness = assessTaskWorkflowAuthorityReadiness({
    authority: config.taskWorkflowAuthority,
    hasWorkflowStore: Boolean(workflowShadowStore),
    hasMaintenanceLoop: Boolean(workflowMaintenanceLoop),
    hasReconcileLoop: Boolean(workflowReconcileLoop),
    hasOracleLoop: Boolean(workflowOracleLoop)
  });
  if (!workflowAuthorityReadiness.ok) {
    throw new Error(
      [
        `Task workflow authority ${config.taskWorkflowAuthority} is not ready.`,
        ...workflowAuthorityReadiness.issues.map((issue) => issue.message)
      ].join(" ")
    );
  }
  if (config.taskWorkflowAuthority !== "off") {
    app.logger.info(
      withUtcTimestamp(
        [
          "Task workflow authority enabled",
          `mode=${config.taskWorkflowAuthority}`,
          `maxAttempts=${config.taskWorkflowMaxAttempts}`,
          `databasePath=${config.taskWorkflowShadowDatabasePath}`
        ].join(" ")
      )
    );
  }
  workflowMaintenanceLoop?.start();
  workflowReconcileLoop?.start();
  workflowOracleLoop?.start();

  const runtimeFactory = createManagedRuntimeFactory(
    config,
    store,
    runtimeJwtIssuer,
    options
  );
  const schedulerControl = createSchedulerControlPlane(store, {
    workflowAuthority: config.taskWorkflowAuthority,
    workflowShadowStore,
    allowedRuntimeTypes:
      config.agentRuntimeAllowedEngines ?? [config.agentRuntimeEngine],
    validateRuntimeAdmission: createScheduledRuntimeAdmissionValidator({
      config,
      store,
      logWarn: (message) => app.logger.warn(withUtcTimestamp(message)),
    }),
    resolveSlackChannelIdByName: (input) =>
      defaultResolveSlackChannelIdByName(config, input)
  });
  const schedulerIntentResolver =
    options.schedulerIntentResolver ??
    createLlmSchedulerIntentResolver({
      model: config.aiModel,
      logWarn: (message) => app.logger.warn(withUtcTimestamp(message))
    });
  const agentRunner =
    config.agentMode === "llm"
      ? createConfiguredAgentRunner({
          config,
          runtime: config.agentRuntime,
          model: config.aiModel,
          githubTools,
          googleTools,
          hubspotTools,
          slackTools,
          jiraTools,
          managedRuntimeUrl: config.managedRuntimeUrl,
          ...(runtimeFactory ? { runtimeFactory } : {}),
          observability,
          logInfo: (message) => app.logger.info(withUtcTimestamp(message))
        })
      : undefined;
  const schedulerRunExecutor =
    agentRunner && !options.testbed
      ? createSchedulerRunExecutor({
          store,
          agentRunner,
          slackClient: app.client,
          workflowShadowStore,
          workflowAuthority: config.taskWorkflowAuthority,
          workflowMaxAttempts: config.taskWorkflowMaxAttempts,
          logInfo: (message) => app.logger.info(withUtcTimestamp(message)),
          logWarn: (message) => app.logger.warn(withUtcTimestamp(message))
        })
      : undefined;
  const schedulerTimer = schedulerRunExecutor
    ? createSchedulerTimer({
        store,
        executeRun: (runId) => schedulerRunExecutor.executeRun(runId),
        workflowAuthority: config.taskWorkflowAuthority,
        workflowShadowStore,
        logInfo: (message) => app.logger.info(withUtcTimestamp(message)),
        logWarn: (message) => app.logger.warn(withUtcTimestamp(message))
      })
    : undefined;
  const scheduledRunAuditMaintenanceLoop = createScheduledRunAuditMaintenanceLoop({
    store,
    retentionDays: config.scheduledRunAuditRetentionDays,
    intervalMs: config.scheduledRunAuditPruneIntervalMs,
    logInfo: (message) => app.logger.info(withUtcTimestamp(message)),
    logWarn: (message) => app.logger.warn(withUtcTimestamp(message))
  });
  scheduledRunAuditMaintenanceLoop.start();
  schedulerTimer?.start();
  const agentExecTasks = new Map<string, AgentExecTask>();

  const resolveAgentExecutionMode = (): "native-runtime" | undefined =>
    config.agentRuntime === "burble-runtime" ? "native-runtime" : undefined;

  const buildHomeViewForUser = async (input: {
    workspaceId: string;
    slackUserId: string;
  }) => {
    const agentSettings = await buildSyncedAgentHomeSettings({
      config,
      store,
      runtimeFactory,
      workspaceId: input.workspaceId,
      slackUserId: input.slackUserId
    });
    const googleAuth = await resolveGoogleAuthView({
      service: mcpGwGoogleAuthService,
      principal: {
        workspaceId: input.workspaceId,
        slackUserId: input.slackUserId
      },
      legacyUrl: mcpGwGoogleAuthService
        ? null
        : tryBuildGoogleOAuthUrl(
            config,
            store.createOAuthState(input.slackUserId)
          ),
      logWarn: (message) => app.logger.warn(withUtcTimestamp(message))
    });
    return buildAppHomeView({
      githubUrl: buildGitHubOAuthUrl(
        config,
        store.createOAuthState(input.slackUserId)
      ),
      googleUrl: googleAuth.googleUrl,
      ...(googleAuth.googleMcpGw
        ? { googleMcpGw: googleAuth.googleMcpGw }
        : {}),
      jiraUrl: tryBuildJiraOAuthUrl(
        config,
        store.createOAuthState(input.slackUserId)
      ),
      hubspotUrl: tryBuildHubSpotOAuthUrl(
        config,
        store.createOAuthState(input.slackUserId)
      ),
      slackUrl: tryBuildSlackOAuthUrl(
        config,
        store.createOAuthState(input.slackUserId)
      ),
      connections: providerConnectionsForUser(store, input.slackUserId),
      agentSettings,
      scheduledTasks: await buildScheduledTaskHomeView({
        schedulerControl,
        workspaceId: input.workspaceId,
        slackUserId: input.slackUserId
      })
    });
  };

  const publishHomeViewForUser = async (input: {
    client: SlackViewsPublishClient;
    workspaceId: string;
    slackUserId: string;
  }) => {
    await input.client.views.publish({
      user_id: input.slackUserId,
      view: await buildHomeViewForUser(input)
    });
  };

  app.event("app_home_opened", async ({ body, event, client, logger }) => {
    const homeEvent = event as { user?: string };
    if (!homeEvent.user) {
      logger.warn(withUtcTimestamp("Ignoring malformed app_home_opened event"));
      return;
    }

    try {
      logger.info(
        withUtcTimestamp(`Publishing App Home for ${homeEvent.user}`)
      );
      await publishHomeViewForUser({
        client,
        workspaceId:
          slackWorkspaceIdFromBody(body) || slackWorkspaceIdFromBody(event),
        slackUserId: homeEvent.user
      });
    } catch (error) {
      logger.error(formatLogError(error));
    }
  });

  app.action("agent_config_edit", async ({ ack, body, client, logger }) => {
    await ack();
    const context = slackInteractionContext(body);
    if (!context?.triggerId) {
      logger.warn(withUtcTimestamp("Ignoring config edit action without trigger"));
      return;
    }

    try {
      await client.views.open({
        trigger_id: context.triggerId,
        view: buildAgentConfigModalView({
          config,
          store,
          workspaceId: context.workspaceId,
          slackUserId: context.slackUserId
        })
      });
    } catch (error) {
      logger.error(formatLogError(error));
    }
  });

  app.action("agent_runtime_manage", async ({ ack, body, client, logger }) => {
    await ack();
    const context = slackInteractionContext(body);
    if (!context?.triggerId) {
      logger.warn(withUtcTimestamp("Ignoring runtime manage action without trigger"));
      return;
    }

    try {
      await client.views.open({
        trigger_id: context.triggerId,
        view: buildAgentRuntimeManageModalView({
          config,
          store,
          workspaceId: context.workspaceId,
          slackUserId: context.slackUserId
        })
      });
    } catch (error) {
      logger.error(formatLogError(error));
    }
  });

  const handleRuntimeControlAction = async (
    action: AgentRuntimeControlAction,
    body: unknown,
    client: SlackViewsPublishClient,
    logger: { warn(message: string): void; error(message: string): void }
  ) => {
    const context = slackInteractionContext(body);
    if (!context) {
      logger.warn(withUtcTimestamp(`Ignoring runtime ${action} action without context`));
      return;
    }

    try {
      if (action === "start" || action === "restart") {
        markAgentRuntimeControlInProgress({
          config,
          store,
          workspaceId: context.workspaceId,
          slackUserId: context.slackUserId
        });
        void applyAgentRuntimeControl({
          config,
          store,
          runtimeFactory,
          workspaceId: context.workspaceId,
          slackUserId: context.slackUserId,
          action
        })
          .then(() =>
            publishHomeViewForUser({
              client,
              workspaceId: context.workspaceId,
              slackUserId: context.slackUserId
            })
          )
          .catch((error) => {
            logger.error(formatLogError(error));
            void publishHomeViewForUser({
              client,
              workspaceId: context.workspaceId,
              slackUserId: context.slackUserId
            }).catch((publishError) => logger.error(formatLogError(publishError)));
          });
      } else {
        await applyAgentRuntimeControl({
          config,
          store,
          runtimeFactory,
          workspaceId: context.workspaceId,
          slackUserId: context.slackUserId,
          action
        });
      }
      await publishHomeViewForUser({
        client,
        workspaceId: context.workspaceId,
        slackUserId: context.slackUserId
      });
    } catch (error) {
      logger.error(formatLogError(error));
    }
  };

  app.action("agent_runtime_start", async ({ ack, body, client, logger }) => {
    await ack();
    await handleRuntimeControlAction("start", body, client, logger);
  });

  app.action("agent_runtime_pause", async ({ ack, body, client, logger }) => {
    await ack();
    await handleRuntimeControlAction("pause", body, client, logger);
  });

  app.action("agent_runtime_restart", async ({ ack, body, client, logger }) => {
    await ack();
    await handleRuntimeControlAction("restart", body, client, logger);
  });

  app.action("agent_runtime_refresh", async ({ ack, body, client, logger }) => {
    await ack();
    const context = slackInteractionContext(body);
    if (!context) {
      logger.warn(withUtcTimestamp("Ignoring runtime refresh action without context"));
      return;
    }

    try {
      await publishHomeViewForUser({
        client,
        workspaceId: context.workspaceId,
        slackUserId: context.slackUserId
      });
    } catch (error) {
      logger.error(formatLogError(error));
    }
  });

  const handleScheduledTaskHomeMutation = async (
    action:
      | "run"
      | "pause"
      | "resume"
      | "delete"
      | "details"
      | "validate"
      | "runs",
    body: unknown,
    client: SlackViewsClient,
    logger: { warn(message: string): void; error(message: string): void }
  ) => {
    const context = slackInteractionContext(body);
    const jobId = readSlackActionSelectedValue(body);
    if (!context || !jobId) {
      logger.warn(withUtcTimestamp(`Ignoring scheduled task ${action} action without context`));
      return;
    }

    try {
      if (action === "run") {
        const result = schedulerControl.triggerJob
          ? await schedulerControl.triggerJob({ ...context, jobId })
          : { ok: false as const, reason: "not_found" as const, jobs: [] };
        if (result.ok) {
          void schedulerRunExecutor
            ?.executeRun(result.run.runId)
            .catch((error) => logger.error(formatLogError(error)));
        }
      } else if (action === "pause") {
        await schedulerControl.pauseJob?.({ ...context, jobId });
      } else if (action === "resume") {
        await schedulerControl.resumeJob?.({ ...context, jobId });
      } else if (action === "delete") {
        await schedulerControl.deleteJob?.({ ...context, jobId });
      } else if (action === "details") {
        const result = schedulerControl.showTask
          ? await schedulerControl.showTask({ ...context, taskId: jobId })
          : { ok: false as const, reason: "not_found" as const, tasks: [] };
        if (context.triggerId && client.views.open) {
          await client.views.open({
            trigger_id: context.triggerId,
            view: buildScheduledTaskDetailsModalView(result)
          });
        }
      } else if (action === "validate") {
        const result = schedulerControl.validateTask
          ? await schedulerControl.validateTask({ ...context, taskId: jobId })
          : { ok: false as const, reason: "not_found" as const, tasks: [] };
        if (context.triggerId && client.views.open) {
          await client.views.open({
            trigger_id: context.triggerId,
            view: buildScheduledTaskValidationModalView(result)
          });
        }
      } else if (action === "runs") {
        const result = schedulerControl.listJobRuns
          ? await schedulerControl.listJobRuns({
              ...context,
              jobId,
              limit: MAX_HOME_RUNS_PER_TASK
            })
          : { runs: [] };
        if (context.triggerId && client.views.open) {
          await client.views.open({
            trigger_id: context.triggerId,
            view: buildScheduledTaskRunsModalView({
              jobId,
              runs: result.runs.slice(0, MAX_HOME_RUNS_PER_TASK)
            })
          });
        }
      }

      await publishHomeViewForUser({
        client,
        workspaceId: context.workspaceId,
        slackUserId: context.slackUserId
      });
    } catch (error) {
      logger.error(formatLogError(error));
    }
  };

  for (const action of [
    "run",
    "pause",
    "resume",
    "delete",
    "details",
    "validate",
    "runs"
  ] as const) {
    app.action(`scheduled_task_${action}`, async ({ ack, body, client, logger }) => {
      await ack();
      await handleScheduledTaskHomeMutation(action, body, client, logger);
    });
  }

  app.action("agent_runtime_engine_select", async ({ ack, body, client, logger }) => {
    await ack();
    const context = slackInteractionContext(body);
    const engine = readSlackActionSelectedValue(body);
    if (!context || !engine || !isAgentRuntimeEngine(engine)) {
      logger.warn(withUtcTimestamp("Ignoring runtime engine selection without valid context"));
      return;
    }

    try {
      await applyAgentRuntimeEngineSelection({
        config,
        store,
        runtimeFactory,
        principal: {
          workspaceId: context.workspaceId,
          slackUserId: context.slackUserId
        },
        engine,
        afterPreferenceSaved: async () => {
          await publishHomeViewForUser({
            client,
            workspaceId: context.workspaceId,
            slackUserId: context.slackUserId
          });
        }
      });
      await publishHomeViewForUser({
        client,
        workspaceId: context.workspaceId,
        slackUserId: context.slackUserId
      });
    } catch (error) {
      logger.error(formatLogError(error));
    }
  });

  app.action("provider_disconnect", async ({ ack, body, client, logger }) => {
    await ack();
    const context = slackInteractionContext(body);
    const provider = readSlackActionSelectedValue(body);
    if (!context || !isDisconnectableProvider(provider)) {
      logger.warn(withUtcTimestamp("Ignoring provider disconnect without valid context"));
      return;
    }

    try {
      if (provider === "google" && mcpGwGoogleAuthService) {
        await mcpGwGoogleAuthService.disconnect({
          workspaceId: context.workspaceId,
          slackUserId: context.slackUserId
        });
      } else {
        store.deleteConnectionForSlackUser(provider, context.slackUserId);
      }
      await publishHomeViewForUser({
        client,
        workspaceId: context.workspaceId,
        slackUserId: context.slackUserId
      });
    } catch (error) {
      logger.error(formatLogError(error));
    }
  });

  app.view("agent_config_submit", async ({ ack, body, client, logger }) => {
    const context = slackViewSubmissionContext(body);
    if (!context) {
      await ack({
        response_action: "errors",
        errors: {
          agent_config_model: "Missing Slack user context."
        }
      });
      return;
    }

    const principal = {
      workspaceId: context.workspaceId,
      slackUserId: context.slackUserId
    };
    const previousSelection = resolveRuntimeEngineForPrincipal({
      config,
      store,
      principal
    });
    const parsed = parseAgentConfigModalSubmission(body, previousSelection);
    if (!parsed.ok) {
      await ack({
        response_action: "errors",
        errors: parsed.errors
      });
      return;
    }

    const previousPolicyHash = buildRuntimeManifestForEffectiveEngine({
      config,
      store,
      principal
    }).policyHash;
    applyAgentConfigModalValues({
      store,
      principal,
      selection: previousSelection,
      values: parsed.values
    });
    const nextPolicyHash = buildRuntimeManifestForEffectiveEngine({
      config,
      store,
      principal
    }).policyHash;

    await ack({
      response_action: "update",
      view: buildAgentConfigSavedModalView(previousPolicyHash !== nextPolicyHash)
    });

    try {
      await publishHomeViewForUser({
        client,
        workspaceId: context.workspaceId,
        slackUserId: context.slackUserId
      });
      await restartAgentRuntimeIfConfigChanged({
        config,
        store,
        runtimeFactory,
        principal,
        previousPolicyHash,
        nextPolicyHash,
        previousEngine: previousSelection.effectiveEngine
      });
    } catch (error) {
      logger.error(formatLogError(error));
    }
  });

  app.event("app_mention", async ({ body, event, client, logger }) => {
    const mention = event as {
      user?: string;
      text?: string;
      channel?: string;
      ts?: string;
      thread_ts?: string;
      channel_type?: string;
      files?: SlackFileReference[];
    };

    logger.info(
      withUtcTimestamp(`Received app_mention from ${mention.user ?? "unknown"}`)
    );

    if (!mention.user || !mention.channel || !mention.ts) {
      logger.warn(withUtcTimestamp("Ignoring malformed app_mention event"));
      return;
    }

    let progressMessage: SlackProgressMessage | undefined;
    let progressReporter: LazyAgentProgressReporter | undefined;
    try {
      if (config.agentMode === "llm") {
        const workspaceId = body.team_id ?? "";
        const streamingMode = resolveSlackStreamingMode({
          config,
          store,
          workspaceId,
          slackUserId: mention.user
        });
        progressReporter = createLazyAgentProgressReporter(client, {
          channel: mention.channel,
          user: mention.user,
          isDirectMessage:
            mention.channel_type === "im" || mention.channel.startsWith("D"),
          threadTs: buildReplyThreadTs({
            isDirectMessage:
              mention.channel_type === "im" || mention.channel.startsWith("D"),
            messageTs: mention.ts,
            threadTs: mention.thread_ts
          }),
          streamThreadTs: mention.thread_ts,
          streamingMode
        });
      }
      logger.info(withUtcTimestamp("app_mention stage=profile_lookup"));
      const email = await getSlackEmail(mention.user);
      logger.info(withUtcTimestamp("app_mention stage=profile_ready"));
      const text = normalizeMentionText(mention.text ?? "");
      const isDirectMessage =
        mention.channel_type === "im" || mention.channel.startsWith("D");
      logger.info(withUtcTimestamp("app_mention stage=history_read"));
      const recentMessages = await readRecentSlackMessages(client, {
        channel: mention.channel,
        latestTs: mention.ts,
        user: mention.user,
        logWarn: (message) => logger.warn(withUtcTimestamp(message))
      });
      logger.info(withUtcTimestamp("app_mention stage=history_ready"));
      const principal = {
        workspaceId: body.team_id ?? "",
        slackUserId: mention.user
      };
      const conversationRoute =
        config.agentMode === "llm" && agentRunner
          ? await createSlackConversationRoute({
              store,
              principal,
              channelId: mention.channel,
              isDirectMessage,
              rootId: buildConversationRootIdForSlack({
                isDirectMessage,
                channelId: mention.channel,
                messageTs: mention.ts,
                threadTs: mention.thread_ts
              }),
              threadTs: buildReplyThreadTs({
                isDirectMessage,
                messageTs: mention.ts,
                threadTs: mention.thread_ts
              })
            })
          : null;
      logger.info(withUtcTimestamp("app_mention stage=route_ready"));

      logger.info(withUtcTimestamp("app_mention stage=conversation_start"));
      const response = await handleConversation(
        {
          source: "slack",
          workspaceId: body.team_id ?? "",
          channelId: mention.channel,
          threadTs: mention.thread_ts,
          messageTs: mention.ts,
          isDirectMessage,
          ...(conversationRoute
            ? { conversationRouteId: conversationRoute.id }
            : {}),
          context: buildSlackRequestContext({
            channelId: mention.channel,
            isDirectMessage,
            read: recentMessages
          }),
          user: {
            slackUserId: mention.user,
            email
          },
          text,
          ...buildConversationAttachments(mention.files)
        },
        {
          createGitHubOAuthUrl: (slackUserId) =>
            buildGitHubOAuthUrl(config, store.createOAuthState(slackUserId)),
          ...(createGoogleConnectUrl
            ? {
                createGoogleOAuthUrl: (slackUserId: string) =>
                  createGoogleConnectUrl({
                    workspaceId: body.team_id ?? "",
                    slackUserId
                  })
              }
            : {}),
          ...(config.jiraClientId && config.jiraClientSecret
            ? {
                createJiraOAuthUrl: (slackUserId: string) =>
                  buildJiraOAuthUrl(config, store.createOAuthState(slackUserId))
              }
            : {}),
          ...(config.hubspotClientId && config.hubspotClientSecret
            ? {
                createHubSpotOAuthUrl: (slackUserId: string) =>
                  buildHubSpotOAuthUrl(
                    config,
                    store.createOAuthState(slackUserId)
                  )
              }
            : {}),
          ...(config.slackClientId && config.slackClientSecret
            ? {
                createSlackOAuthUrl: (slackUserId: string) =>
                  buildSlackOAuthUrl(config, store.createOAuthState(slackUserId))
              }
            : {}),
          getConnection: (provider, emailAddress) =>
            store.getConnection(provider, emailAddress),
          tools: {
            github: githubTools,
            google: googleTools,
            hubspot: hubspotTools,
            jira: jiraTools,
            slack: slackTools
          },
          schedulerControl,
          schedulerIntentResolver,
          ...(schedulerRunExecutor
            ? {
                onSchedulerRunQueued: (run) =>
                  schedulerRunExecutor.executeRun(run.runId)
              }
            : {}),
          agentMode: config.agentMode,
          agentFastTrack: config.agentFastTrack,
          agentRuntimeEngine: config.agentRuntimeEngine,
          schedulerRuntimeEngine: resolveRuntimeEngineForPrincipal({
            config,
            store,
            principal: {
              workspaceId: body.team_id ?? "",
              slackUserId: mention.user
            }
          }).effectiveEngine,
          observability,
          ...(resolveAgentExecutionMode()
            ? { agentExecutionMode: resolveAgentExecutionMode() }
            : {}),
          ...(agentRunner ? { agentRunner } : {}),
          ...(progressReporter
            ? {
                onAgentEvent: (event) => {
                  return progressReporter!.onAgentEvent(event).catch((error) => {
                    logger.warn(formatLogError(error));
                  });
                }
              }
            : {})
        }
      );
      progressMessage = progressReporter?.getProgressMessage();

      await postConversationResponse(client, {
        response,
        channel: mention.channel,
        user: mention.user,
        ...(progressMessage ? { progressMessage } : {}),
        threadTs: buildReplyThreadTs({
          isDirectMessage,
          messageTs: mention.ts,
          threadTs: mention.thread_ts
        })
      });
    } catch (error) {
      logger.error(formatLogError(error));
      const text = formatConversationFailureMessage(error, "mention");
      if (progressMessage) {
        await failAgentProgressMessage(client, progressMessage, text);
        return;
      }

      await client.chat.postEphemeral({
        channel: mention.channel,
        user: mention.user,
        text
      });
    }
  });

  app.message(async ({ body, message, client, logger }) => {
    const directMessage = message as SlackDirectMessageEvent;

    if (!shouldHandleDirectMessageEvent(directMessage)) {
      return;
    }

    logger.info(
      withUtcTimestamp(`Received message.im from ${directMessage.user}`)
    );

    let progressMessage: SlackProgressMessage | undefined;
    let progressReporter: LazyAgentProgressReporter | undefined;
    try {
      if (config.agentMode === "llm") {
        const workspaceId = body.team_id ?? "";
        const streamingMode = resolveSlackStreamingMode({
          config,
          store,
          workspaceId,
          slackUserId: directMessage.user
        });
        progressReporter = createLazyAgentProgressReporter(client, {
          channel: directMessage.channel,
          user: directMessage.user,
          isDirectMessage: true,
          threadTs: buildReplyThreadTs({
            isDirectMessage: true,
            messageTs: directMessage.ts,
            threadTs: directMessage.thread_ts
          }),
          streamThreadTs: directMessage.thread_ts,
          streamingMode
        });
      }
      logger.info(withUtcTimestamp("message.im stage=profile_lookup"));
      const email = await getSlackEmail(directMessage.user);
      logger.info(withUtcTimestamp("message.im stage=profile_ready"));
      logger.info(withUtcTimestamp("message.im stage=history_read"));
      const recentMessages = await readRecentSlackMessages(client, {
        channel: directMessage.channel,
        latestTs: directMessage.ts,
        user: directMessage.user,
        logWarn: (message) => logger.warn(withUtcTimestamp(message))
      });
      logger.info(withUtcTimestamp("message.im stage=history_ready"));
      const principal = {
        workspaceId: body.team_id ?? "",
        slackUserId: directMessage.user
      };
      logger.info(withUtcTimestamp("message.im stage=route_create"));
      const conversationRoute =
        config.agentMode === "llm" && agentRunner
          ? await createSlackConversationRoute({
              store,
              principal,
              channelId: directMessage.channel,
              isDirectMessage: true,
              rootId: buildConversationRootIdForSlack({
                isDirectMessage: true,
                channelId: directMessage.channel,
                messageTs: directMessage.ts,
                threadTs: directMessage.thread_ts
              }),
              threadTs: buildReplyThreadTs({
                isDirectMessage: true,
                messageTs: directMessage.ts,
                threadTs: directMessage.thread_ts
              })
            })
          : null;
      logger.info(withUtcTimestamp("message.im stage=route_ready"));

      logger.info(withUtcTimestamp("message.im stage=conversation_start"));
      const response = await handleConversation(
        {
          source: "slack",
          workspaceId: body.team_id ?? "",
          channelId: directMessage.channel,
          threadTs: directMessage.thread_ts,
          messageTs: directMessage.ts,
          isDirectMessage: true,
          ...(conversationRoute
            ? { conversationRouteId: conversationRoute.id }
            : {}),
          context: buildSlackRequestContext({
            channelId: directMessage.channel,
            isDirectMessage: true,
            read: recentMessages
          }),
          user: {
            slackUserId: directMessage.user,
            email
          },
          text: directMessage.text?.trim() ?? "",
          ...buildConversationAttachments(directMessage.files)
        },
        {
          createGitHubOAuthUrl: (slackUserId) =>
            buildGitHubOAuthUrl(config, store.createOAuthState(slackUserId)),
          ...(createGoogleConnectUrl
            ? {
                createGoogleOAuthUrl: (slackUserId: string) =>
                  createGoogleConnectUrl({
                    workspaceId: body.team_id ?? "",
                    slackUserId
                  })
              }
            : {}),
          ...(config.jiraClientId && config.jiraClientSecret
            ? {
                createJiraOAuthUrl: (slackUserId: string) =>
                  buildJiraOAuthUrl(config, store.createOAuthState(slackUserId))
              }
            : {}),
          ...(config.hubspotClientId && config.hubspotClientSecret
            ? {
                createHubSpotOAuthUrl: (slackUserId: string) =>
                  buildHubSpotOAuthUrl(
                    config,
                    store.createOAuthState(slackUserId)
                  )
              }
            : {}),
          ...(config.slackClientId && config.slackClientSecret
            ? {
                createSlackOAuthUrl: (slackUserId: string) =>
                  buildSlackOAuthUrl(config, store.createOAuthState(slackUserId))
              }
            : {}),
          getConnection: (provider, emailAddress) =>
            store.getConnection(provider, emailAddress),
          tools: {
            github: githubTools,
            google: googleTools,
            hubspot: hubspotTools,
            jira: jiraTools,
            slack: slackTools
          },
          schedulerControl,
          schedulerIntentResolver,
          ...(schedulerRunExecutor
            ? {
                onSchedulerRunQueued: (run) =>
                  schedulerRunExecutor.executeRun(run.runId)
              }
            : {}),
          agentMode: config.agentMode,
          agentFastTrack: config.agentFastTrack,
          agentRuntimeEngine: config.agentRuntimeEngine,
          schedulerRuntimeEngine: resolveRuntimeEngineForPrincipal({
            config,
            store,
            principal: {
              workspaceId: body.team_id ?? "",
              slackUserId: directMessage.user
            }
          }).effectiveEngine,
          observability,
          ...(resolveAgentExecutionMode()
            ? { agentExecutionMode: resolveAgentExecutionMode() }
            : {}),
          ...(agentRunner ? { agentRunner } : {}),
          ...(progressReporter
            ? {
                onAgentEvent: (event) => {
                  return progressReporter!.onAgentEvent(event).catch((error) => {
                    logger.warn(formatLogError(error));
                  });
                }
              }
            : {})
        }
      );
      progressMessage = progressReporter?.getProgressMessage();

      await postConversationResponse(client, {
        response,
        channel: directMessage.channel,
        user: directMessage.user,
        ...(progressMessage ? { progressMessage } : {}),
        threadTs: buildReplyThreadTs({
          isDirectMessage: true,
          messageTs: directMessage.ts,
          threadTs: directMessage.thread_ts
        })
      });
    } catch (error) {
      logger.error(formatLogError(error));
      const text = formatConversationFailureMessage(error, "message");
      if (progressMessage) {
        await failAgentProgressMessage(client, progressMessage, text);
        return;
      }

      await client.chat.postMessage({
        channel: directMessage.channel,
        text
      });
    }
  });

  app.command("/auth", async ({ ack, body, logger }) => {
    try {
      logger.info(
        withUtcTimestamp(`Received /auth ${body.text} from ${body.user_id}`)
      );
      const action = parseAuthCommand(body.text);

      if (action.kind === "unknown") {
        await ack({
          response_type: "ephemeral",
          text: `Unknown auth target \`${action.value}\`. Try \`/auth\`, \`/auth github\`, \`/auth google\`, \`/auth hubspot\`, \`/auth jira\`, or \`/auth slack\`.`
        });
        return;
      }

      const githubUrl = buildGitHubOAuthUrl(
        config,
        store.createOAuthState(body.user_id)
      );
      const jiraUrl = tryBuildJiraOAuthUrl(
        config,
        store.createOAuthState(body.user_id)
      );
      const googleAuth = await resolveGoogleAuthView({
        service: mcpGwGoogleAuthService,
        principal: {
          workspaceId: body.team_id ?? "",
          slackUserId: body.user_id
        },
        legacyUrl: mcpGwGoogleAuthService
          ? null
          : tryBuildGoogleOAuthUrl(
              config,
              store.createOAuthState(body.user_id)
            ),
        includeStatus: action.kind === "connections",
        logWarn: (message) => logger.warn(withUtcTimestamp(message))
      });
      const googleUrl = googleAuth.googleUrl;
      const hubspotUrl = tryBuildHubSpotOAuthUrl(
        config,
        store.createOAuthState(body.user_id)
      );
      const slackUrl = tryBuildSlackOAuthUrl(
        config,
        store.createOAuthState(body.user_id)
      );

      await ack(
        action.kind === "github"
          ? {
              response_type: "ephemeral",
              text: formatConnectGitHubMessage(githubUrl)
            }
          : action.kind === "jira"
            ? jiraUrl
              ? {
                  response_type: "ephemeral",
                  text: `<${jiraUrl}|Connect your Jira account>`
                }
              : {
                  response_type: "ephemeral",
                  text: "Jira OAuth is not configured."
                }
            : action.kind === "google"
              ? googleUrl
                ? {
                    response_type: "ephemeral",
                    text: `<${googleUrl}|Connect your Google account>`
                  }
                : {
                    response_type: "ephemeral",
                    text: mcpGwGoogleAuthService
                      ? "MCP-GW Google authorization is temporarily unavailable."
                      : "Google OAuth is not configured."
                  }
            : action.kind === "hubspot"
              ? hubspotUrl
                ? {
                    response_type: "ephemeral",
                    text: `<${hubspotUrl}|Connect your HubSpot account>`
                  }
                : {
                    response_type: "ephemeral",
                    text: "HubSpot OAuth is not configured."
                  }
            : action.kind === "slack"
              ? slackUrl
                ? {
                    response_type: "ephemeral",
                    text: `<${slackUrl}|Connect Slack search>`
                  }
              : {
                  response_type: "ephemeral",
                  text: "Slack OAuth is not configured."
                }
              : buildAuthResponse({
                  githubUrl,
                  googleUrl,
                  hubspotUrl,
                  jiraUrl,
                  slackUrl,
                  connections: providerConnectionsForUser(store, body.user_id),
                  ...(googleAuth.googleMcpGw
                    ? { googleMcpGw: googleAuth.googleMcpGw }
                    : {})
                })
      );
    } catch (error) {
      logger.error(formatLogError(error));
      await ack({
        response_type: "ephemeral",
        text: "I could not open auth settings."
      });
    }
  });

  app.command("/help", async ({ ack, body, logger }) => {
    try {
      logger.info(withUtcTimestamp(`Received /help from ${body.user_id}`));
      await ack(buildHelpResponse());
    } catch (error) {
      logger.error(formatLogError(error));
      await ack({
        response_type: "ephemeral",
        text: "I could not open help."
      });
    }
  });

  app.command("/tasks", async ({ ack, body, logger, respond }) => {
    try {
      logger.info(
        withUtcTimestamp(`Received /tasks ${body.text} from ${body.user_id}`)
      );
      const action = parseTaskSlashCommand(body.text ?? "");
      if (action.kind === "create") {
        await ack({
          response_type: "ephemeral",
          text: "Resolving scheduled task..."
        });
        try {
          const text = await handleTaskSlashCommand({
            action,
            body,
            config,
            store,
            schedulerControl,
            schedulerIntentResolver,
            schedulerRunExecutor
          });
          await respond({
            response_type: "ephemeral",
            replace_original: true,
            text
          });
        } catch (error) {
          logger.error(formatLogError(error));
          await respond({
            response_type: "ephemeral",
            replace_original: true,
            text: "I could not handle that task command."
          });
        }
        return;
      }

      await ack({
        response_type: "ephemeral",
        text: await handleTaskSlashCommand({
          action,
          body,
          config,
          store,
          schedulerControl,
          schedulerIntentResolver,
          schedulerRunExecutor
        })
      });
    } catch (error) {
      logger.error(formatLogError(error));
      await ack({
        response_type: "ephemeral",
        text: "I could not handle that task command."
      });
    }
  });

  app.command("/jobs", async ({ ack, body, logger }) => {
    try {
      logger.info(
        withUtcTimestamp(`Received /jobs ${body.text} from ${body.user_id}`)
      );
      await ack({
        response_type: "ephemeral",
        text: await handleJobSlashCommand({
          action: parseJobSlashCommand(body.text ?? ""),
          body,
          schedulerControl
        })
      });
    } catch (error) {
      logger.error(formatLogError(error));
      await ack({
        response_type: "ephemeral",
        text: "I could not handle that job command."
      });
    }
  });

  app.command("/agent", async ({ ack, body, client, logger, respond }) => {
    try {
      logger.info(
        withUtcTimestamp(`Received /agent ${body.text} from ${body.user_id}`)
      );
      const action = parseAgentCommand(body.text);

      if (action.kind === "help") {
        await ack(buildAgentCommandHelpResponse());
        return;
      }

      if (action.kind === "destination_grant") {
        if (!body.team_id) {
          await ack(buildAgentDestinationGrantWorkspaceMissingResponse());
          return;
        }
        if (!isDestinationGrantSlashCommandChannel(body)) {
          await ack(buildAgentDestinationGrantDirectMessageResponse());
          return;
        }

        await ack(buildAgentDestinationGrantLoadingResponse());
        const preflight = await verifySlackDestinationGrantChannel({
          client,
          channelId: body.channel_id
        });
        if (!preflight.ok) {
          await respond({
            ...buildAgentDestinationGrantPreflightFailureResponse(preflight),
            replace_original: true
          });
          return;
        }

        try {
          const route = createSlackDestinationGrantRoute({
            store,
            principal: {
              workspaceId: body.team_id,
              slackUserId: body.user_id
            },
            channelId: body.channel_id,
            isPrivateChannel: preflight.isPrivateChannel
          });
          await respond({
            ...buildAgentDestinationGrantResponse(route),
            replace_original: true
          });
        } catch (error) {
          logger.error(formatLogError(error));
          await respond({
            response_type: "ephemeral",
            replace_original: true,
            text: "I could not authorize this channel as a scheduled job destination."
          });
        }
        return;
      }

      if (action.kind === "destination_revoke") {
        if (!body.team_id) {
          await ack(buildAgentDestinationGrantWorkspaceMissingResponse());
          return;
        }
        if (!isDestinationGrantSlashCommandChannel(body)) {
          await ack(buildAgentDestinationGrantDirectMessageResponse());
          return;
        }

        await ack(buildAgentDestinationGrantLoadingResponse("Revoking destination grant..."));
        try {
          const response = applySlackDestinationGrantRevoke({
            store,
            principal: {
              workspaceId: body.team_id,
              slackUserId: body.user_id
            },
            channelId: body.channel_id
          });
          await respond({
            ...response,
            replace_original: true
          });
        } catch (error) {
          logger.error(formatLogError(error));
          await respond({
            response_type: "ephemeral",
            replace_original: true,
            text: "I could not revoke this channel's scheduled job destination grant."
          });
        }
        return;
      }

      if (action.kind === "status") {
        await ack(buildAgentStatusLoadingResponse());
        try {
          const runtime = await getOrStartAgentStatusRuntime({
            config,
            store,
            runtimeFactory,
            workspaceId: body.team_id ?? "",
            slackUserId: body.user_id
          });

          await respond({
            ...buildAgentStatusResponse({ config, runtime }),
            replace_original: true
          });
        } catch (error) {
          logger.error(formatLogError(error));
          await respond({
            response_type: "ephemeral",
            replace_original: true,
            text: formatAgentStatusFailureMessage(error)
          });
        }
        return;
      }

      if (action.kind === "config") {
        await ack(buildAgentConfigLoadingResponse());
        try {
          const runtime = await getOrStartAgentStatusRuntime({
            config,
            store,
            runtimeFactory,
            workspaceId: body.team_id ?? "",
            slackUserId: body.user_id
          });
          const configFile = await readAgentConfigFile(runtime, { runtimeFactory });

          await respond({
            ...buildAgentConfigResponse({ runtime, configFile }),
            replace_original: true
          });
        } catch (error) {
          logger.error(formatLogError(error));
          await respond({
            response_type: "ephemeral",
            replace_original: true,
            text: formatAgentConfigFailureMessage(error)
          });
        }
        return;
      }

      if (action.kind === "config_get") {
        await ack(
          withDirectMessageSlashCommandVisibility(
            buildAgentUserConfigGetResponse({
              config,
              store,
              workspaceId: body.team_id ?? "",
              slackUserId: body.user_id,
              key: action.key
            }),
            body
          )
        );
        return;
      }

      if (action.kind === "config_set") {
        const principal = {
          workspaceId: body.team_id ?? "",
          slackUserId: body.user_id
        };
        const previousSelection = resolveRuntimeEngineForPrincipal({
          config,
          store,
          principal
        });
        const previousPolicyHash = buildRuntimeManifestForEffectiveEngine({
          config,
          store,
          principal
        }).policyHash;
        const response = applyAgentUserConfigSet({
          config,
          store,
          workspaceId: principal.workspaceId,
          slackUserId: principal.slackUserId,
          key: action.key,
          value: action.value
        });
        const nextPolicyHash = buildRuntimeManifestForEffectiveEngine({
          config,
          store,
          principal
        }).policyHash;
        const policyChanged = previousPolicyHash !== nextPolicyHash;
        await ack(
          withDirectMessageSlashCommandVisibility(
            addAgentConfigRuntimeRestartNotice(
              response,
              policyChanged
            ),
            body
          )
        );
        if (!policyChanged) {
          return;
        }
        try {
          const restartedRuntimeId = await restartAgentRuntimeIfConfigChanged({
            config,
            store,
            runtimeFactory,
            principal,
            previousPolicyHash,
            nextPolicyHash,
            previousEngine: previousSelection.effectiveEngine
          });
          await respond(
            withDirectMessageSlashCommandVisibility(
              buildAgentConfigRuntimeRestartResponse(restartedRuntimeId),
              body
            )
          );
        } catch (error) {
          logger.error(formatLogError(error));
          await respond(
            withDirectMessageSlashCommandVisibility(
              buildAgentConfigRuntimeRestartFailureResponse(error),
              body
            )
          );
        }
        return;
      }

      if (action.kind === "exec_list") {
        await ack(
          buildAgentExecTaskListResponse(
            listAgentExecTasks(agentExecTasks, body.team_id ?? "", body.user_id)
          )
        );
        return;
      }

      if (action.kind === "exec_inspect") {
        await ack(
          buildAgentExecTaskInspectResponse(
            findAgentExecTask(
              agentExecTasks,
              body.team_id ?? "",
              body.user_id,
              action.taskId
            )
          )
        );
        return;
      }

      if (action.kind === "exec_stop") {
        const task = findAgentExecTask(
          agentExecTasks,
          body.team_id ?? "",
          body.user_id,
          action.taskId
        );
        await ack(buildAgentExecStopLoadingResponse(task));
        if (task) {
          await stopAgentExecTask({
            task,
            runtimeFactory,
            client,
            stoppedBy: body.user_id
          });
        }
        await respond({
          ...buildAgentExecStopResponse(task),
          replace_original: true
        });
        return;
      }

      if (action.kind === "exec") {
        const principal = {
          workspaceId: body.team_id ?? "",
          slackUserId: body.user_id
        };
        const execTask = createAgentExecTask({
          workspaceId: principal.workspaceId,
          slackUserId: principal.slackUserId,
          channelId: body.channel_id,
          task: action.task
        });
        agentExecTasks.set(execTask.id, execTask);
        let progressText = "Preparing agent runtime...";
        await ack();
        let progressMessage: SlackProgressMessage | undefined;
        try {
          progressMessage = await postAgentExecResponseMessage({
            client,
            channel: body.channel_id,
            text: formatAgentExecResponseMessage(execTask, {
              statusText: progressText
            })
          });
          execTask.message = progressMessage;
          if (config.agentMode !== "llm" || !agentRunner) {
            const failureText =
              "Agent execution requires `AGENT_MODE=llm` and an agent runtime.";
            await updateAgentExecResponse({
              client,
              respond,
              progressMessage,
              text: formatAgentExecResponseMessage(execTask, {
                statusText: "Failed.",
                responseText: failureText
              })
            });
            finishAgentExecTask(execTask, "failed", failureText);
            return;
          }

          const startedAtMs = Date.now();
          const runtime = runtimeFactory
            ? await runtimeFactory.getOrCreateRuntime(principal)
            : null;
          if (runtime) {
            execTask.runtimeId = runtime.id;
          }
          if (execTask.stopRequested && runtimeFactory && runtime) {
            await runtimeFactory.stopRuntime(runtime.id);
            finishAgentExecTask(
              execTask,
              "stopped",
              "Stopped before the runtime task started."
            );
            await updateAgentExecResponse({
              client,
              respond,
              progressMessage,
              text: formatAgentExecResponseMessage(execTask, {
                statusText: "Stopped.",
                responseText: "Stopped before the runtime task started."
              })
            });
            return;
          }

          const email = await getSlackEmail(body.user_id);
          const conversationRoute = store.upsertConversationRoute({
            workspaceId: principal.workspaceId,
            slackUserId: principal.slackUserId,
            transport: "slack",
            destination: {
              channelId: body.channel_id,
              isDirectMessage: body.channel_id.startsWith("D"),
              runtimeId: runtime?.id,
              rootId: `slash-agent-exec:${execTask.id}`
            }
          });
          const result = await collectAgentRun(
            agentRunner,
            {
              principal,
              executionMode: "native-runtime",
              conversation: {
                routeId: conversationRoute.id,
                source: "slack",
                workspaceId: principal.workspaceId,
                channelId: body.channel_id,
                rootId: `slash-agent-exec:${execTask.id}`,
                isDirectMessage: body.channel_id.startsWith("D")
              },
              text: action.task,
              toolGroups: buildAgentExecToolGroups(action.task),
              connections: {
                github: store.getConnection("github", email),
                google: store.getConnection("google", email),
                hubspot: store.getConnection("hubspot", email),
                jira: store.getConnection("jira", email),
                slack: store.getConnection("slack", email)
              }
            },
            async (event) => {
              const nextText = formatAgentProgressEvent(event, progressText);
              if (!nextText || nextText === progressText) {
                return;
              }

              progressText = nextText;
              execTask.progressText = progressText;
              execTask.updatedAtMs = Date.now();
              await updateAgentExecResponse({
                client,
                respond,
                progressMessage,
                text: formatAgentExecResponseMessage(execTask, {
                  statusText: progressText
                })
              });
            }
          );

          if (execTask.status === "stopped") {
            return;
          }
          const finalStatusText = formatSlackFinalProgressLine(
            Date.now() - startedAtMs,
            result.usage
          );
          const finalResponseText =
            result.text.trim() || "Agent finished without a text response.";
          const finalText = formatAgentExecResult(finalStatusText, finalResponseText);
          finishAgentExecTask(execTask, "finished", finalText);
          await updateAgentExecResponse({
            client,
            respond,
            progressMessage,
            text: formatAgentExecResponseMessage(execTask, {
              statusText: finalStatusText,
              responseText: finalResponseText
            })
          });
        } catch (error) {
          logger.error(formatLogError(error));
          if (execTask.status === "stopped" || execTask.stopRequested) {
            finishAgentExecTask(execTask, "stopped", "Stopped.");
            await updateAgentExecResponse({
              client,
              respond,
              progressMessage,
              text: formatAgentExecResponseMessage(execTask, {
                statusText: "Stopped."
              })
            });
            return;
          }
          const failureText = formatAgentExecFailureMessage(error);
          finishAgentExecTask(execTask, "failed", failureText);
          await updateAgentExecResponse({
            client,
            respond,
            progressMessage,
            text: formatAgentExecResponseMessage(execTask, {
              statusText: "Failed.",
              responseText: failureText
            })
          });
        }
        return;
      }

      await ack(buildAgentCommandHelpResponse());
    } catch (error) {
      logger.error(formatLogError(error));
      await ack({
        response_type: "ephemeral",
        text: "I could not open agent controls."
      });
    }
  });

  app.command("/agent-status", async ({ ack, body, logger, respond }) => {
    try {
      logger.info(
        withUtcTimestamp(`Received /agent-status from ${body.user_id}`)
      );
      await ack(buildAgentStatusLoadingResponse());
      try {
        const runtime = await getOrStartAgentStatusRuntime({
          config,
          store,
          runtimeFactory,
          workspaceId: body.team_id ?? "",
          slackUserId: body.user_id
        });

        await respond({
          ...buildAgentStatusResponse({ config, runtime }),
          replace_original: true
        });
      } catch (error) {
        logger.error(formatLogError(error));
        await respond({
          response_type: "ephemeral",
          replace_original: true,
          text: formatAgentStatusFailureMessage(error)
        });
      }
    } catch (error) {
      logger.error(formatLogError(error));
      await ack({
        response_type: "ephemeral",
        text: "I could not open agent status."
      });
    }
  });

  app.command("/agent-config", async ({ ack, body, logger, respond }) => {
    try {
      logger.info(
        withUtcTimestamp(`Received /agent-config from ${body.user_id}`)
      );
      await ack(buildAgentConfigLoadingResponse());
      try {
        const runtime = await getOrStartAgentStatusRuntime({
          config,
          store,
          runtimeFactory,
          workspaceId: body.team_id ?? "",
          slackUserId: body.user_id
        });
        const configFile = await readAgentConfigFile(runtime, { runtimeFactory });

        await respond({
          ...buildAgentConfigResponse({ runtime, configFile }),
          replace_original: true
        });
      } catch (error) {
        logger.error(formatLogError(error));
        await respond({
          response_type: "ephemeral",
          replace_original: true,
          text: formatAgentConfigFailureMessage(error)
        });
      }
    } catch (error) {
      logger.error(formatLogError(error));
      await ack({
        response_type: "ephemeral",
        text: "I could not open agent configuration."
      });
    }
  });

  return {
    app,
    ...(runtimeFactory ? { runtimeFactory } : {}),
    getSlackEmail,
    close() {
      schedulerTimer?.stop();
      scheduledRunAuditMaintenanceLoop.stop();
      workflowOracleLoop?.stop();
      workflowReconcileLoop?.stop();
      workflowMaintenanceLoop?.stop();
      workflowShadowDatabase?.close();
    }
  };
}

export async function getOrStartAgentStatusRuntime(input: {
  config: Config;
  store: TokenStore;
  runtimeFactory?: RuntimeFactory;
  workspaceId: string;
  slackUserId: string;
}): Promise<AgentRuntimeRecord | null> {
  if (input.config.agentRuntime !== "burble-runtime") {
    return null;
  }

  const principal = {
    workspaceId: input.workspaceId,
    slackUserId: input.slackUserId
  };
  await input.runtimeFactory?.getOrCreateRuntime(principal);
  const selection = resolveRuntimeEngineForPrincipal({
    config: input.config,
    store: input.store,
    principal
  });

  return input.store.getAgentRuntimeForPrincipal({
    ...principal,
    engine: selection.effectiveEngine
  });
}

export type AgentConfigFileRead = {
  path: string | null;
  rawText: string | null;
  redactedText: string | null;
  topLevelKeys: string[];
  error: string | null;
};

export async function readAgentConfigFile(
  runtime: AgentRuntimeRecord | null,
  source:
    | ((path: string) => Promise<string>)
    | {
        runtimeFactory?: RuntimeFactory;
        readText?: (path: string) => Promise<string>;
      } = {}
): Promise<AgentConfigFileRead> {
  if (!runtime) {
    return {
      path: null,
      rawText: null,
      redactedText: null,
      topLevelKeys: [],
      error: "No runtime record exists yet."
    };
  }

  try {
    const readText =
      typeof source === "function"
        ? source
        : (source.readText ?? ((path: string) => readFile(path, "utf8")));
    const configRead =
      typeof source === "function"
        ? { path: runtime.configPath, text: await readText(runtime.configPath) }
        : source.runtimeFactory?.readRuntimeConfig
          ? await source.runtimeFactory.readRuntimeConfig(runtime.id)
          : { path: runtime.configPath, text: await readText(runtime.configPath) };
    const rawText = configRead.text;
    const parsed = JSON.parse(rawText) as unknown;
    const redacted = redactConfigValue(parsed);
    return {
      path: configRead.path,
      rawText,
      redactedText: JSON.stringify(redacted, null, 2),
      topLevelKeys:
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? Object.keys(parsed as Record<string, unknown>)
          : [],
      error: null
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    return {
      path: runtime.configPath,
      rawText: null,
      redactedText: null,
      topLevelKeys: [],
      error: detail
    };
  }
}

export function createManagedRuntimeFactory(
  config: Config,
  store: TokenStore,
  runtimeJwtIssuer?: RuntimeJwtIssuer,
  options: SlackRuntimeOptions = {}
): RuntimeFactory | undefined {
  if (config.agentRuntime !== "burble-runtime") {
    return undefined;
  }

  if (
    (config.agentRuntimeFactory === "docker" ||
      config.agentRuntimeFactory === "sandbox") &&
    !config.agentRuntimeTokenSecret
  ) {
    throw new Error(
      "AGENT_RUNTIME_TOKEN_SECRET or INTERNAL_API_TOKEN is required for managed runtime factories"
    );
  }
  if (config.agentRuntimeFactory === "sandbox") {
    if (!options.sandboxProvider) {
      throw new Error(
        "AGENT_RUNTIME_FACTORY=sandbox requires an injected SandboxProvider"
      );
    }
  }
  if (config.agentRuntimeFactory === "static" && !config.managedRuntimeUrl) {
    return undefined;
  }

  const delegates = new Map<AgentRuntimeEngine, RuntimeFactory>();
  const delegateForEngine = (engine: AgentRuntimeEngine): RuntimeFactory => {
    const existing = delegates.get(engine);
    if (existing) {
      return existing;
    }
    const buildManifest = (principal: { workspaceId: string; slackUserId: string }) =>
      buildRuntimeManifestForPrincipal({
        config,
        store,
        principal,
        engine
      });
    const delegate =
      config.agentRuntimeFactory === "docker"
        ? createDockerRuntimeFactory({
            store,
            engine,
            image: runtimeImageForEngine(config, engine),
            dataRoot: config.agentRuntimeDataRoot,
            dockerNetwork: config.agentRuntimeDockerNetwork,
            toolGatewayUrl: config.agentRuntimeToolGatewayUrl,
            inferenceBaseUrl: config.agentRuntimeInferenceBaseUrl,
            mcpGatewayUrl: config.agentRuntimeMcpGatewayUrl,
            mcpAudience: config.agentRuntimeMcpAudience,
            runtimeJwtIssuer,
            runtimeJwtTtlSeconds: config.agentRuntimeJwtTtlSeconds,
            runtimeTokenSecret: config.agentRuntimeTokenSecret ?? "",
            openClawConfigPatchPath: config.openClawConfigPatchHostPath,
            idleTtlMs: config.agentRuntimeIdleTtlMs,
            env: Bun.env,
            buildManifest
          })
        : config.agentRuntimeFactory === "sandbox"
          ? createSandboxRuntimeFactory({
              store,
              sandboxProvider: options.sandboxProvider!,
              engine,
              image: runtimeImageForEngine(config, engine),
              toolGatewayUrl: config.agentRuntimeToolGatewayUrl,
              mcpGatewayUrl: config.agentRuntimeMcpGatewayUrl,
              mcpAudience: config.agentRuntimeMcpAudience,
              inferenceBaseUrl: config.agentRuntimeInferenceBaseUrl,
              modelProviderUrls:
                options.sandboxModelProviderUrls ??
                modelProviderUrlsForRuntimeModel(config.aiModel, Bun.env, {
                  inferenceBaseUrl: config.agentRuntimeInferenceBaseUrl
                }),
              runtimeJwtIssuer,
              runtimeJwtTtlSeconds: config.agentRuntimeJwtTtlSeconds,
              runtimeTokenSecret: config.agentRuntimeTokenSecret ?? "",
              idleTtlMs: config.agentRuntimeIdleTtlMs,
              startCommand:
                options.sandboxStartCommand ??
                defaultAgentRuntimeSandboxStartCommand(engine),
              fetch: options.sandboxFetch,
              openShellDialHost: config.agentRuntimeOpenShellDialHost,
              env: Bun.env,
              buildManifest
            })
        : createStaticRuntimeFactory({
            store,
            engine,
            endpointUrl: config.managedRuntimeUrl ?? "",
            authToken: config.internalApiToken ?? "",
            dataRoot: config.agentRuntimeDataRoot,
            buildManifest
          });
    delegates.set(engine, delegate);
    return delegate;
  };
  const resolveEngine = (
    principal: { workspaceId: string; slackUserId: string },
    requirements?: Parameters<RuntimeFactory["getOrCreateRuntime"]>[1]
  ) =>
    resolveRuntimeEngineForPrincipal({
      config,
      store,
      principal,
      requirements
    }).effectiveEngine;
  const stopOtherActiveRuntimes = async (
    principal: { workspaceId: string; slackUserId: string },
    selectedEngine: ReturnType<typeof resolveEngine>
  ) => {
    for (const runtime of store.listAgentRuntimesForPrincipal(principal)) {
      if (
        runtime.engine === selectedEngine ||
        !isActiveAgentRuntime(runtime)
      ) {
        continue;
      }
      await delegateForEngine(runtime.engine).stopRuntime(runtime.id);
    }
  };

  return {
    async getOrCreateRuntime(principal, requirements) {
      const engine = resolveEngine(principal, requirements);
      await stopOtherActiveRuntimes(principal, engine);
      return delegateForEngine(engine).getOrCreateRuntime(
        principal,
        requirements
      );
    },

    async syncRuntimeStatus(runtimeId) {
      const runtime = store.getAgentRuntime(runtimeId);
      return runtime
        ? (await delegateForEngine(runtime.engine).syncRuntimeStatus?.(runtimeId)) ??
            store.getAgentRuntime(runtimeId)
        : null;
    },

    async readRuntimeConfig(runtimeId) {
      const runtime = store.getAgentRuntime(runtimeId);
      if (!runtime) {
        throw new Error(`Runtime ${runtimeId} was not found`);
      }
      return delegateForEngine(runtime.engine).readRuntimeConfig?.(runtimeId) ??
        Promise.reject(new Error("Runtime config reads are not supported"));
    },

    async stopRuntime(runtimeId) {
      const runtime = store.getAgentRuntime(runtimeId);
      if (runtime) {
        await delegateForEngine(runtime.engine).stopRuntime(runtimeId);
      }
    },

    async reapIdleRuntimes(now) {
      for (const engine of agentRuntimeEngines) {
        await delegateForEngine(engine).reapIdleRuntimes(now);
      }
    },

    recordRuntimeEvent(runtimeId, event) {
      const runtime = store.getAgentRuntime(runtimeId);
      if (runtime) {
        delegateForEngine(runtime.engine).recordRuntimeEvent?.(runtimeId, event);
      } else {
        store.recordAgentRuntimeEvent({
          runtimeId,
          eventType: event.eventType,
          summary: event.summary
        });
      }
    },

    async captureRuntimeDiagnostics(runtimeId, input) {
      const runtime = store.getAgentRuntime(runtimeId);
      if (!runtime) {
        return null;
      }
      return delegateForEngine(runtime.engine).captureRuntimeDiagnostics?.(
        runtimeId,
        input
      ) ?? null;
    }
  };
}

export function runtimeImageForEngine(
  config: Config,
  engine: AgentRuntimeEngine
): string {
  const configuredImageIsDefault = isDefaultAgentRuntimeImage(
    config.agentRuntimeEngine,
    config.agentRuntimeImage
  );
  return engine === config.agentRuntimeEngine || !configuredImageIsDefault
    ? config.agentRuntimeImage
    : defaultAgentRuntimeImage(engine);
}

function buildRuntimeManifestForEffectiveEngine(input: {
  config: Config;
  store: TokenStore;
  principal: { workspaceId: string; slackUserId: string };
  engine?: AgentRuntimeEngine;
}) {
  const engine =
    input.engine ?? resolveRuntimeEngineForPrincipal(input).effectiveEngine;
  return buildRuntimeManifestForPrincipal({
    ...input,
    engine
  });
}

async function createSlackConversationRoute(input: {
  store: TokenStore;
  principal: {
    workspaceId: string;
    slackUserId: string;
  };
  channelId: string;
  isDirectMessage: boolean;
  rootId: string;
  threadTs?: string;
}) {
  return input.store.upsertConversationRoute({
    workspaceId: input.principal.workspaceId,
    slackUserId: input.principal.slackUserId,
    transport: "slack",
    destination: {
      channelId: input.channelId,
      isDirectMessage: input.isDirectMessage,
      rootId: input.rootId,
      ...(input.threadTs ? { threadTs: input.threadTs } : {})
    }
  });
}

export function createSlackDestinationGrantRoute(input: {
  store: TokenStore;
  principal: {
    workspaceId: string;
    slackUserId: string;
  };
  channelId: string;
  isPrivateChannel?: boolean;
  threadTs?: string;
  expiresAt?: string | null;
  binding?: Record<string, unknown> | null;
  now?: Date;
}) {
  if (input.channelId.startsWith("D")) {
    throw new Error("Destination grants must target a Slack channel");
  }

  return input.store.upsertConversationRoute({
    workspaceId: input.principal.workspaceId,
    slackUserId: input.principal.slackUserId,
    transport: "slack",
    destination: slackDestinationGrantDestination(input),
    kind: "grant",
    grantedBySlackUserId: input.principal.slackUserId,
    expiresAt: input.expiresAt ?? null,
    binding: input.binding ?? null,
    ...(input.now ? { now: input.now } : {})
  });
}

export function revokeSlackDestinationGrantRoutes(input: {
  store: TokenStore;
  principal: {
    workspaceId: string;
    slackUserId: string;
  };
  channelId: string;
  threadTs?: string;
  now?: Date;
}): number {
  const baseDestination = slackDestinationGrantDestination(input);
  const revokedLegacyAndPublic = input.store.revokeConversationRoutesForDestination({
    workspaceId: input.principal.workspaceId,
    transport: "slack",
    destination: baseDestination,
    kind: "grant",
    ...(input.now ? { now: input.now } : {})
  });
  const privateDestination = slackDestinationGrantDestination({
    ...input,
    isPrivateChannel: true
  });
  const revokedPrivate = input.store.revokeConversationRoutesForDestination({
    workspaceId: input.principal.workspaceId,
    transport: "slack",
    destination: privateDestination,
    kind: "grant",
    ...(input.now ? { now: input.now } : {})
  });
  return revokedLegacyAndPublic + revokedPrivate;
}

export function applySlackDestinationGrantRevoke(input: {
  store: TokenStore;
  principal: {
    workspaceId: string;
    slackUserId: string;
  };
  channelId: string;
  threadTs?: string;
  now?: Date;
}) {
  const revokedCount = revokeSlackDestinationGrantRoutes(input);
  return buildAgentDestinationGrantRevokedResponse(revokedCount);
}

function slackDestinationGrantDestination(input: {
  channelId: string;
  isPrivateChannel?: boolean;
  threadTs?: string;
}): Record<string, unknown> {
  return {
    channelId: input.channelId,
    isDirectMessage: false,
    rootId: input.threadTs
      ? buildConversationRootIdForSlack({
          isDirectMessage: false,
          channelId: input.channelId,
          messageTs: input.threadTs,
          threadTs: input.threadTs
        })
      : `channel:${input.channelId}`,
    ...(input.isPrivateChannel === true ? { isPrivateChannel: true } : {}),
    ...(input.threadTs ? { threadTs: input.threadTs } : {})
  };
}

function buildConversationRootIdForSlack(input: {
  isDirectMessage: boolean;
  channelId: string;
  messageTs: string;
  threadTs?: string;
}): string {
  if (input.isDirectMessage) {
    return input.threadTs
      ? `dm:${input.channelId}:thread:${input.threadTs}`
      : `dm:${input.channelId}`;
  }

  return `channel:${input.channelId}:thread:${input.threadTs ?? input.messageTs}`;
}

export type AuthCommand =
  | { kind: "connections" }
  | { kind: "github" }
  | { kind: "google" }
  | { kind: "hubspot" }
  | { kind: "jira" }
  | { kind: "slack" }
  | { kind: "unknown"; value: string };

export function parseAuthCommand(text: string): AuthCommand {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (
    normalized === "" ||
    normalized === "connections" ||
    normalized === "connection" ||
    normalized === "connect"
  ) {
    return { kind: "connections" };
  }

  if (normalized === "github" || normalized === "connect github") {
    return { kind: "github" };
  }

  if (normalized === "google" || normalized === "connect google") {
    return { kind: "google" };
  }

  if (
    normalized === "hubspot" ||
    normalized === "hub spot" ||
    normalized === "connect hubspot" ||
    normalized === "connect hub spot"
  ) {
    return { kind: "hubspot" };
  }

  if (
    normalized === "jira" ||
    normalized === "atlassian" ||
    normalized === "connect jira" ||
    normalized === "connect atlassian"
  ) {
    return { kind: "jira" };
  }

  if (normalized === "slack" || normalized === "connect slack") {
    return { kind: "slack" };
  }

  return { kind: "unknown", value: normalized };
}

export type AgentCommand =
  | { kind: "help" }
  | { kind: "status" }
  | { kind: "config" }
  | { kind: "destination_grant" }
  | { kind: "destination_revoke" }
  | { kind: "config_get"; key?: string }
  | { kind: "config_set"; key: string; value: string }
  | { kind: "exec_list" }
  | { kind: "exec_inspect"; taskId: string }
  | { kind: "exec_stop"; taskId: string }
  | { kind: "exec"; task: string };

export function parseAgentCommand(text: string): AgentCommand {
  const trimmed = text.trim();
  const normalized = trimmed.toLowerCase().replace(/\s+/g, " ");
  if (normalized === "" || normalized === "help") {
    return { kind: "help" };
  }

  if (normalized === "status" || normalized === "runtime status") {
    return { kind: "status" };
  }

  if (
    normalized === "destination grant" ||
    normalized === "grant destination" ||
    normalized === "grant here"
  ) {
    return { kind: "destination_grant" };
  }

  if (
    normalized === "destination revoke" ||
    normalized === "revoke destination" ||
    normalized === "revoke here" ||
    normalized === "ungrant here"
  ) {
    return { kind: "destination_revoke" };
  }

  if (
    normalized === "config" ||
    normalized === "configuration" ||
    normalized === "runtime config"
  ) {
    return { kind: "config" };
  }

  const configGetMatch = /^(?:config\s+get|get)(?:\s+([\s\S]*))?$/i.exec(
    trimmed
  );
  if (configGetMatch) {
    const key = configGetMatch[1]?.trim();
    return key ? { kind: "config_get", key } : { kind: "config_get" };
  }

  const configSetMatch = /^(?:config\s+set|set)\s+(\S+)(?:\s+([\s\S]*))?$/i.exec(
    trimmed
  );
  if (configSetMatch) {
    return {
      kind: "config_set",
      key: configSetMatch[1],
      value: configSetMatch[2]?.trim() ?? ""
    };
  }

  const execMatch = /^exec(?:ute)?(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (execMatch) {
    const task = execMatch[1]?.trim() ?? "";
    if (!task) {
      return { kind: "exec_list" };
    }

    const inspectMatch =
      /^(?:(?:inspect|show)\s+([A-Za-z0-9_-]+)|([A-Za-z0-9_-]+)\s+(?:inspect|show))$/i.exec(
        task
      );
    if (inspectMatch) {
      return { kind: "exec_inspect", taskId: inspectMatch[1] ?? inspectMatch[2] };
    }

    const stopMatch =
      /^(?:(?:stop|cancel)\s+([A-Za-z0-9_-]+)|([A-Za-z0-9_-]+)\s+(?:stop|cancel))$/i.exec(
        task
      );
    if (stopMatch) {
      return { kind: "exec_stop", taskId: stopMatch[1] ?? stopMatch[2] };
    }

    return { kind: "exec", task };
  }

  return { kind: "help" };
}

export type TaskSlashCommand =
  | { kind: "help" }
  | { kind: "list" }
  | { kind: "show"; taskId: string }
  | { kind: "validate"; taskId: string }
  | { kind: "create"; description: string }
  | { kind: "run"; taskId?: string }
  | { kind: "pause"; taskId: string }
  | { kind: "resume"; taskId: string }
  | { kind: "delete"; taskId: string }
  | { kind: "set_schedule"; taskId: string; schedule: string }
  | { kind: "set_prompt"; taskId: string; prompt: string };

export type JobSlashCommand =
  | { kind: "help" }
  | { kind: "list"; taskId?: string }
  | { kind: "status"; taskId?: string };

export function parseTaskSlashCommand(text: string): TaskSlashCommand {
  const trimmed = text.trim();
  if (!trimmed || trimmed === "help") {
    return { kind: "help" };
  }

  const [command = "", ...rest] = trimmed.split(/\s+/);
  const args = rest.join(" ").trim();
  switch (command.toLowerCase()) {
    case "list":
      return { kind: "list" };
    case "show":
      return args ? { kind: "show", taskId: args } : { kind: "help" };
    case "validate":
      return args ? { kind: "validate", taskId: args } : { kind: "help" };
    case "create":
      return args ? { kind: "create", description: args } : { kind: "help" };
    case "run":
    case "trigger":
      return args ? { kind: "run", taskId: args } : { kind: "run" };
    case "pause":
      return args ? { kind: "pause", taskId: args } : { kind: "help" };
    case "resume":
    case "unpause":
      return args ? { kind: "resume", taskId: args } : { kind: "help" };
    case "delete":
    case "remove":
      return args ? { kind: "delete", taskId: args } : { kind: "help" };
    case "schedule": {
      const parsed = parseTaskSlashIdAndValue(args);
      return parsed
        ? { kind: "set_schedule", taskId: parsed.id, schedule: parsed.value }
        : { kind: "help" };
    }
    case "prompt": {
      const parsed = parseTaskSlashIdAndValue(args);
      return parsed
        ? { kind: "set_prompt", taskId: parsed.id, prompt: parsed.value }
        : { kind: "help" };
    }
    default:
      return { kind: "help" };
  }
}

export function parseJobSlashCommand(text: string): JobSlashCommand {
  const trimmed = text.trim();
  if (!trimmed || trimmed === "help") {
    return { kind: "help" };
  }

  const [command = "", ...rest] = trimmed.split(/\s+/);
  const args = rest.join(" ").trim();
  switch (command.toLowerCase()) {
    case "list":
      return args ? { kind: "list", taskId: args } : { kind: "list" };
    case "status":
    case "latest":
      return args ? { kind: "status", taskId: args } : { kind: "status" };
    default:
      return { kind: "help" };
  }
}

function parseTaskSlashIdAndValue(
  text: string
): { id: string; value: string } | null {
  const [id = "", ...rest] = text.trim().split(/\s+/);
  const value = rest.join(" ").trim();
  return id && value ? { id, value } : null;
}

type SchedulerSlashCommandBody = {
  team_id?: string;
  user_id: string;
  channel_id?: string;
  text?: string;
};

async function handleTaskSlashCommand(input: {
  action: TaskSlashCommand;
  body: SchedulerSlashCommandBody;
  config: Config;
  store: TokenStore;
  schedulerControl: SchedulerControlPlane;
  schedulerIntentResolver?: SchedulerIntentResolver;
  schedulerRunExecutor?: { executeRun(runId: string): Promise<void> };
}): Promise<string> {
  const principal = readSchedulerSlashCommandPrincipal(input.body);
  if (!principal) {
    return "I could not identify the Slack workspace for this task command.";
  }

  switch (input.action.kind) {
    case "help":
      return formatTaskSlashHelp();
    case "list": {
      const tasks = input.schedulerControl.listTasks
        ? await input.schedulerControl.listTasks(principal)
        : (await input.schedulerControl.listJobs(principal)).map((job) => ({
            ...job,
            taskId: job.jobId
          }));
      return formatScheduledJobList(tasks);
    }
    case "show":
      return formatScheduledTaskDetailResult(
        input.schedulerControl.showTask
          ? await input.schedulerControl.showTask({
              ...principal,
              taskId: input.action.taskId
            })
          : { ok: false, reason: "not_found", tasks: [] }
      );
    case "validate":
      return formatScheduledTaskValidationResult(
        input.schedulerControl.validateTask
          ? await input.schedulerControl.validateTask({
              ...principal,
              taskId: input.action.taskId
            })
          : { ok: false, reason: "not_found", tasks: [] }
      );
    case "create":
      return createScheduledTaskFromSlashDescription({
        ...input,
        principal,
        description: input.action.description
      });
    case "run": {
      if (!input.schedulerControl.triggerJob) {
        return "Scheduled task runs are not available in this environment.";
      }
      const result = await input.schedulerControl.triggerJob({
        ...principal,
        jobId: input.action.taskId ?? null
      });
      if (result.ok) {
        void input.schedulerRunExecutor
          ?.executeRun(result.run.runId)
          .catch(() => undefined);
      }
      return formatScheduledJobTriggerResult(result);
    }
    case "pause":
      return formatScheduledJobMutationResult(
        "Paused",
        input.schedulerControl.pauseJob
          ? await input.schedulerControl.pauseJob({
              ...principal,
              jobId: input.action.taskId
            })
          : { ok: false, reason: "not_found", jobs: [] }
      );
    case "resume":
      return formatScheduledJobMutationResult(
        "Resumed",
        input.schedulerControl.resumeJob
          ? await input.schedulerControl.resumeJob({
              ...principal,
              jobId: input.action.taskId
            })
          : { ok: false, reason: "not_found", jobs: [] }
      );
    case "delete":
      return formatScheduledJobDeleteResult(
        input.schedulerControl.deleteJob
          ? await input.schedulerControl.deleteJob({
              ...principal,
              jobId: input.action.taskId
            })
          : { ok: false, reason: "not_found", jobs: [] }
      );
    case "set_schedule":
      return formatScheduledJobScheduleUpdateResult(
        input.schedulerControl.updateJobSchedule
          ? await input.schedulerControl.updateJobSchedule({
              ...principal,
              jobId: input.action.taskId,
              schedule: parseExplicitCronSchedule(input.action.schedule)
            })
          : { ok: false, reason: "not_found", jobs: [] }
      );
    case "set_prompt":
      return formatScheduledJobPromptUpdateResult(
        input.schedulerControl.updateJobPrompt
          ? await input.schedulerControl.updateJobPrompt({
              ...principal,
              jobId: input.action.taskId,
              prompt: input.action.prompt
            })
          : { ok: false, reason: "not_found", jobs: [] }
      );
  }
}

async function createScheduledTaskFromSlashDescription(input: {
  description: string;
  body: SchedulerSlashCommandBody;
  principal: { workspaceId: string; slackUserId: string };
  config: Config;
  store: TokenStore;
  schedulerControl: SchedulerControlPlane;
  schedulerIntentResolver?: SchedulerIntentResolver;
}): Promise<string> {
  if (!input.schedulerControl.createJob) {
    return "Scheduled task creation is not available in this environment.";
  }
  if (!input.schedulerIntentResolver) {
    return "Scheduled task creation needs the semantic task resolver to be enabled.";
  }

  const jobs = await input.schedulerControl.listJobs(input.principal);
  const resolved = await input.schedulerIntentResolver({
    text: input.description,
    recentMessages: [],
    jobs
  });
  if (
    resolved.intent !== "create_job" ||
    resolved.confidence < 0.7 ||
    !resolved.create
  ) {
    return [
      "I could not resolve a complete scheduled task spec.",
      "Use `/tasks create <what to do, schedule, and delivery>` with enough detail."
    ].join("\n");
  }

  const route = input.body.channel_id
    ? await createSlackConversationRoute({
        store: input.store,
        principal: input.principal,
        channelId: input.body.channel_id,
        isDirectMessage: input.body.channel_id.startsWith("D"),
        rootId: `slash-tasks:${randomUUID()}`
      })
    : null;
  const runtimeType = resolveRuntimeEngineForPrincipal({
    config: input.config,
    store: input.store,
    principal: input.principal
  }).effectiveEngine;

  return formatScheduledJobCreateResult(
    await input.schedulerControl.createJob({
      ...input.principal,
      title: resolved.create.title,
      prompt: resolved.create.prompt,
      schedule: resolved.create.schedule,
      routeId: route?.id ?? null,
      runtimeType
    })
  );
}

async function handleJobSlashCommand(input: {
  action: JobSlashCommand;
  body: SchedulerSlashCommandBody;
  schedulerControl: SchedulerControlPlane;
}): Promise<string> {
  const principal = readSchedulerSlashCommandPrincipal(input.body);
  if (!principal) {
    return "I could not identify the Slack workspace for this job command.";
  }

  switch (input.action.kind) {
    case "help":
      return formatJobSlashHelp();
    case "list":
      return formatScheduledJobRunList(
        input.schedulerControl.listJobRuns
          ? (
              await input.schedulerControl.listJobRuns({
                ...principal,
                jobId: input.action.taskId ?? null,
                limit: 10
              })
            ).runs
          : []
      );
    case "status":
      return formatScheduledRunStatusResult(
        input.schedulerControl.getLatestRunStatus
          ? await input.schedulerControl.getLatestRunStatus({
              ...principal,
              jobId: input.action.taskId ?? null
            })
          : { ok: false, reason: "no_runs" }
      );
  }
}

function readSchedulerSlashCommandPrincipal(
  body: SchedulerSlashCommandBody
): { workspaceId: string; slackUserId: string } | null {
  const workspaceId = body.team_id ?? "";
  const slackUserId = body.user_id;
  return workspaceId && slackUserId ? { workspaceId, slackUserId } : null;
}

function parseExplicitCronSchedule(expression: string): {
  kind: "cron";
  expression: string;
  timezone: "UTC";
} {
  return {
    kind: "cron",
    expression: expression.trim().replace(/\s+/g, " "),
    timezone: "UTC"
  };
}

function formatTaskSlashHelp(): string {
  return [
    "Task commands",
    "- `/tasks list`",
    "- `/tasks show <task_id>`",
    "- `/tasks validate <task_id>`",
    "- `/tasks create <task description, schedule, and delivery>`",
    "- `/tasks run [task_id]`",
    "- `/tasks pause <task_id>`",
    "- `/tasks resume <task_id>`",
    "- `/tasks delete <task_id>`",
    "- `/tasks schedule <task_id> <cron expression>`",
    "- `/tasks prompt <task_id> <new prompt>`"
  ].join("\n");
}

function formatJobSlashHelp(): string {
  return [
    "Job commands",
    "- `/jobs list [task_id]`",
    "- `/jobs status [task_id]`"
  ].join("\n");
}

const MAX_HOME_TASKS = 5;
const MAX_HOME_RUNS_PER_TASK = 5;

type ProviderConnectionViewInput = {
  githubUrl: string;
  googleUrl: string | null;
  hubspotUrl: string | null;
  jiraUrl: string | null;
  slackUrl: string | null;
  googleMcpGw?: {
    status: McpGwGoogleAuthStatus | null;
  };
  connections?: {
    [provider in Provider]?: ProviderConnection | null;
  };
  agentSettings?: AgentHomeSettingsView;
  scheduledTasks?: ScheduledTaskHomeView;
};

type SlackViewsClient = {
  views: {
    publish(input: { user_id: string; view: View }): Promise<unknown>;
    open?(input: { trigger_id: string; view: View }): Promise<unknown>;
  };
};

type SlackViewsPublishClient = SlackViewsClient;

type AgentHomeSettingsView = {
  model: string;
  userMemory: "on" | "off";
  streaming: AgentRuntimeStreamingMode;
  disabledTools: string[];
  enabledSkills: string[];
  policyHash: string;
    runtime: {
      id: string | null;
      sandboxId: string | null;
      status: string;
      factory: string;
      engine: string;
    configuredEngine: string;
    preferredEngine: string | null;
    allowedEngines: string[];
    selectableEngines: string[];
    compatibility: Array<{
      engine: string;
      selectable: boolean;
      reasons: string[];
    }>;
    endpointUrl: string | null;
    createdAt: string | null;
    lastUsedAt: string | null;
  };
};

type ScheduledTaskHomeView = {
  items: ScheduledTaskHomeItem[];
  totalTasks: number;
};

type ScheduledTaskHomeItem = {
  task: SchedulerTaskSummary;
  latestRun: SchedulerRunStatusResult | null;
};

function providerConnectionsForUser(
  store: TokenStore,
  slackUserId: string
): ProviderConnectionViewInput["connections"] {
  return Object.fromEntries(
    connectedProviderIds.map((provider) => [
      provider,
      store.getConnectionForSlackUser(provider, slackUserId)
    ])
  ) as ProviderConnectionViewInput["connections"];
}

async function buildScheduledTaskHomeView(input: {
  schedulerControl: SchedulerControlPlane;
  workspaceId: string;
  slackUserId: string;
}): Promise<ScheduledTaskHomeView> {
  const tasks = input.schedulerControl.listTasks
    ? await input.schedulerControl.listTasks(input)
    : (await input.schedulerControl.listJobs(input)).map((job) => ({
        ...job,
        taskId: job.jobId
      }));
  const visibleTasks = tasks.slice(0, MAX_HOME_TASKS);
  const items: ScheduledTaskHomeItem[] = [];
  for (const task of visibleTasks) {
    const latestRun = input.schedulerControl.getLatestRunStatus
      ? await input.schedulerControl.getLatestRunStatus({
          workspaceId: input.workspaceId,
          slackUserId: input.slackUserId,
          jobId: task.taskId
        })
      : null;
    items.push({
      task,
      latestRun
    });
  }
  return {
    items,
    totalTasks: tasks.length
  };
}

export function buildAppHomeView(input: ProviderConnectionViewInput): View {
  return {
    type: "home" as const,
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "Burble"
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: buildAppHomeIntroText(input)
        }
      },
      ...buildScheduledTaskHomeBlocks(input.scheduledTasks),
      ...buildAgentRuntimeHomeBlocks(input.agentSettings),
      {
        type: "divider"
      },
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "User auth"
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Connect provider accounts so Burble can use your GitHub, Google Workspace, HubSpot, Jira, and Slack identity on your behalf."
        }
      },
      ...buildProviderConnectionBlocks(input),
      {
        type: "divider"
      },
      buildAppHomeShortcutContext()
    ]
  };
}

function buildAppHomeIntroText(input: ProviderConnectionViewInput): string {
  const connectedCount = connectedProviderIds.filter((provider) =>
    provider === "google" && input.googleMcpGw
      ? input.googleMcpGw.status?.connected === true
      : Boolean(input.connections?.[provider])
  ).length;
  if (connectedCount === 0 && !input.agentSettings?.runtime.id) {
    return [
      "Start by connecting the provider accounts you want Burble to use.",
      "You can also message Burble directly; if a task needs a missing account, Burble will send you back here to connect it."
    ].join(" ");
  }

  return "Manage your personal Burble runtime, provider connections, and agent preferences.";
}

export function buildAuthResponse(input: ProviderConnectionViewInput) {
  return {
    response_type: "ephemeral" as const,
    text: "Burble connections: GitHub, Google Workspace, HubSpot, Jira, and Slack search.",
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "Connections"
        }
      },
      ...buildProviderConnectionBlocks(input),
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "Shortcuts: `/auth`, `/auth github`, `/auth google`, `/auth hubspot`, `/auth jira`, `/auth slack`, `/help`"
          }
        ]
      }
    ]
  } as const;
}

function buildScheduledTaskHomeBlocks(input?: ScheduledTaskHomeView): View["blocks"] {
  if (!input) {
    return [];
  }

  const blocks: unknown[] = [
    {
      type: "divider"
    },
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "Scheduled tasks"
      }
    }
  ];

  if (input.items.length === 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          "No scheduled tasks are configured yet.",
          "Open the *Messages* tab and ask Burble to create one, for example: `create task every weekday at 9 AM to summarize my GitHub PRs and Jira issues`."
        ].join(" ")
      }
    });
    return blocks as View["blocks"];
  }

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text:
          input.totalTasks > input.items.length
            ? `Showing ${input.items.length} of ${input.totalTasks} tasks. Use \`/tasks list\` for the full list.`
            : "Manage task execution and recent runs."
      }
    ]
  });

  for (const item of input.items) {
    blocks.push(
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: formatScheduledTaskHomeSummary(item)
        }
      },
      ...buildScheduledTaskHomeActionBlocks(item.task)
    );
  }

  return blocks as View["blocks"];
}

function buildScheduledTaskHomeActionBlocks(task: SchedulerTaskSummary) {
  const actions = buildScheduledTaskHomeActions(task);
  return [
    {
      type: "actions",
      elements: actions.slice(0, 5)
    },
    {
      type: "actions",
      elements: actions.slice(5)
    }
  ];
}

function buildScheduledTaskHomeActions(task: SchedulerTaskSummary) {
  const isPaused = task.state === "paused";
  return [
    {
      type: "button",
      text: {
        type: "plain_text",
        text: "Run now"
      },
      style: "primary",
      action_id: "scheduled_task_run",
      value: task.taskId
    },
    {
      type: "button",
      text: {
        type: "plain_text",
        text: isPaused ? "Resume" : "Pause"
      },
      ...(isPaused ? { style: "primary" } : {}),
      action_id: isPaused ? "scheduled_task_resume" : "scheduled_task_pause",
      value: task.taskId,
      confirm: {
        title: {
          type: "plain_text",
          text: isPaused ? "Resume task?" : "Pause task?"
        },
        text: {
          type: "mrkdwn",
          text: isPaused
            ? "This allows the task to run on its schedule again."
            : "This stops future scheduled dispatches until resumed."
        },
        confirm: {
          type: "plain_text",
          text: isPaused ? "Resume" : "Pause"
        },
        deny: {
          type: "plain_text",
          text: "Cancel"
        }
      }
    },
    {
      type: "button",
      text: {
        type: "plain_text",
        text: "Details"
      },
      action_id: "scheduled_task_details",
      value: task.taskId
    },
    {
      type: "button",
      text: {
        type: "plain_text",
        text: "Validate"
      },
      action_id: "scheduled_task_validate",
      value: task.taskId
    },
    {
      type: "button",
      text: {
        type: "plain_text",
        text: "Runs"
      },
      action_id: "scheduled_task_runs",
      value: task.taskId
    },
    {
      type: "button",
      text: {
        type: "plain_text",
        text: "Delete"
      },
      style: "danger",
      action_id: "scheduled_task_delete",
      value: task.taskId,
      confirm: {
        title: {
          type: "plain_text",
          text: "Delete task?"
        },
        text: {
          type: "mrkdwn",
          text: "This removes the scheduled task. Existing run history remains."
        },
        confirm: {
          type: "plain_text",
          text: "Delete"
        },
        deny: {
          type: "plain_text",
          text: "Cancel"
        }
      }
    }
  ];
}

function formatScheduledTaskHomeSummary(item: ScheduledTaskHomeItem): string {
  const task = item.task;
  const title = task.title?.trim() || task.taskId;
  const latest = item.latestRun?.ok
    ? `latest: \`${item.latestRun.run.status}\` ${formatRelativeIsoTime(item.latestRun.run.updatedAt)}`
    : "latest: no runs";
  return [
    `*${escapeSlackMrkdwn(truncateSlackText(title, 120))}*`,
    `\`${task.state}\` · ${formatScheduleForHome(task.schedule)} · ${latest}`,
    `id: \`${task.taskId}\`${task.routeId ? ` · route: \`${task.routeId}\`` : ""}`
  ].join("\n");
}

function buildScheduledTaskValidationModalView(
  result: SchedulerValidateTaskResult
): View {
  const text = formatScheduledTaskValidationResult(result);
  return {
    type: "modal",
    title: {
      type: "plain_text",
      text: "Task validation"
    },
    close: {
      type: "plain_text",
      text: "Close"
    },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: truncateSlackText(escapeSlackMrkdwn(text), 2900)
        }
      }
    ]
  };
}

export function buildScheduledTaskDetailsModalView(
  result: SchedulerShowTaskResult
): View {
  const text = formatScheduledTaskDetailsModalText(result);
  return {
    type: "modal",
    title: {
      type: "plain_text",
      text: "Task details"
    },
    close: {
      type: "plain_text",
      text: "Close"
    },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: truncateSlackText(escapeSlackMrkdwn(text), 2900)
        }
      }
    ]
  };
}

function formatScheduledTaskDetailsModalText(
  result: SchedulerShowTaskResult
): string {
  if (!result.ok) {
    return formatScheduledTaskDetailResult(result);
  }

  const task = result.task;
  const validation = result.validation;
  const title = task.title?.trim() || task.taskId;
  const lines = [
    `*${title}*`,
    "*Task steps*",
    "1. Run scheduled agent prompt",
    task.prompt?.trim()
      ? `   prompt: ${task.prompt.trim()}`
      : "   prompt: none",
    validation.expectedTools.length
      ? `   expected tools: ${validation.expectedTools.join(", ")}`
      : "   expected tools: none",
    task.requiredTools.length
      ? `   granted tools: ${task.requiredTools.join(", ")}`
      : "   granted tools: none",
    `   validation: ${validation.ok ? "passed" : "failed"}`,
    "",
    "*Task metadata*",
    `task: ${task.taskId}`,
    task.schedule ? `schedule: ${formatScheduleForHome(task.schedule)}` : null,
    `state: ${task.state}`,
    task.runtimeType ? `runtime: ${task.runtimeType}` : null,
    task.routeId ? `route: ${task.routeId}` : null,
    `updated: ${task.updatedAt}`
  ].filter((line): line is string => line !== null);

  if (validation.errors.length) {
    lines.push("", "*Errors*");
    for (const issue of validation.errors) {
      lines.push(`- ${issue.code}: ${issue.message}`);
    }
  }

  if (validation.warnings.length) {
    lines.push("", "*Warnings*");
    for (const issue of validation.warnings) {
      lines.push(`- ${issue.code}: ${issue.message}`);
    }
  }

  return lines.join("\n");
}

export function buildScheduledTaskRunsModalView(input: {
  jobId: string;
  runs: AgentJobRunRecord[];
}): View {
  return {
    type: "modal",
    title: {
      type: "plain_text",
      text: "Task runs"
    },
    close: {
      type: "plain_text",
      text: "Close"
    },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: formatScheduledTaskRunsModalText(input)
        }
      }
    ]
  };
}

function formatScheduledTaskRunsModalText(input: {
  jobId: string;
  runs: AgentJobRunRecord[];
}): string {
  if (input.runs.length === 0) {
    return `No runs recorded for \`${input.jobId}\`.`;
  }

  return [
    `Recent runs for \`${input.jobId}\``,
    ...input.runs.slice(0, MAX_HOME_RUNS_PER_TASK).map((run) => {
      const failure = run.failureReason
        ? ` · failure: ${escapeSlackMrkdwn(truncateSlackText(run.failureReason, 180))}`
        : "";
      return `• \`${run.runId}\` · \`${run.status}\` · ${run.triggerSource} · ${formatRelativeIsoTime(run.updatedAt)}${failure}`;
    })
  ].join("\n");
}

function buildProviderConnectionBlocks(input: ProviderConnectionViewInput) {
  return connectedProviderDescriptors
    .map((descriptor) => {
      const url = input[descriptor.authUrlInputKey];
      const connection = input.connections?.[descriptor.id] ?? null;
      if (descriptor.id === "google" && input.googleMcpGw) {
        const status = input.googleMcpGw.status;
        const accountPresent = Boolean(status?.connected || status?.email);
        return buildProviderConnectionBlock({
          provider: descriptor.id,
          title: descriptor.connectionTitle,
          status: formatMcpGwGoogleConnectionStatus(status),
          configured: true,
          url,
          connected: status?.connected === true,
          reconnect: accountPresent || Boolean(status?.missingScopes.length),
          disconnectable: accountPresent,
          actionId: `connect_${descriptor.authCommand}`,
          usage: descriptor.usage
        });
      }
      return buildProviderConnectionBlock({
        provider: descriptor.id,
        title: descriptor.connectionTitle,
        status: url
          ? formatConnectionStatus(connection, descriptor.id)
          : descriptor.oauthNotConfiguredText,
        configured: Boolean(url),
        url,
        connected: Boolean(connection),
        actionId: `connect_${descriptor.authCommand}`,
        usage: descriptor.usage
      });
    })
    .flat();
}

export function buildAgentHomeSettings(input: {
  config: Config;
  store: TokenStore;
  workspaceId: string;
  slackUserId: string;
}): AgentHomeSettingsView {
  const principal = {
    workspaceId: input.workspaceId,
    slackUserId: input.slackUserId
  };
  const selection = resolveRuntimeEngineForPrincipal({
    config: input.config,
    store: input.store,
    principal
  });
  const manifest = buildRuntimeManifestForPrincipal({
    config: input.config,
    store: input.store,
    principal,
    engine: selection.effectiveEngine
  });
  const runtime = input.store.getAgentRuntimeForPrincipal({
    workspaceId: input.workspaceId,
    slackUserId: input.slackUserId,
    engine: selection.effectiveEngine
  });

  return {
    model: `${manifest.model.provider}:${manifest.model.model}`,
    userMemory: manifest.memory.userMemoryEnabled ? "on" : "off",
    streaming: resolveSlackStreamingMode({
      config: input.config,
      store: input.store,
      workspaceId: input.workspaceId,
      slackUserId: input.slackUserId
    }),
    disabledTools: manifest.disabledTools,
    enabledSkills: manifest.skills.map((skill) => `${skill.id}@${skill.version}`),
    policyHash: manifest.policyHash,
    runtime: runtime
      ? {
          id: runtime.id,
          sandboxId: runtime.sandboxId,
          status: runtime.status,
          factory: input.config.agentRuntimeFactory,
          engine: runtime.engine,
          configuredEngine: selection.configuredEngine,
          preferredEngine: selection.preferredEngine,
          allowedEngines: selection.allowedEngines,
          selectableEngines: selection.selectableEngines,
          compatibility: selection.compatibility,
          endpointUrl: runtime.endpointUrl,
          createdAt: runtime.createdAt,
          lastUsedAt: runtime.lastUsedAt
        }
      : {
          id: null,
          sandboxId: null,
          status: "not provisioned",
          factory: input.config.agentRuntimeFactory,
          engine: selection.effectiveEngine,
          configuredEngine: selection.configuredEngine,
          preferredEngine: selection.preferredEngine,
          allowedEngines: selection.allowedEngines,
          selectableEngines: selection.selectableEngines,
          compatibility: selection.compatibility,
          endpointUrl: null,
          createdAt: null,
          lastUsedAt: null
      }
  };
}

function resolveSlackStreamingMode(input: {
  config: Config;
  store: TokenStore;
  workspaceId: string;
  slackUserId: string;
}): AgentRuntimeStreamingMode {
  return parseSlackStreamingModePreference(
    input.store.getUserPreference(
      input.workspaceId,
      input.slackUserId,
      "runtime.streaming"
    )?.value,
    input.config.agentRuntimeStreaming ?? "native"
  );
}

function parseSlackStreamingModePreference(
  value: unknown,
  fallback: AgentRuntimeStreamingMode
): AgentRuntimeStreamingMode {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "basic" || normalized === "native" || normalized === "off") {
      return normalized;
    }
    if (normalized === "on" || normalized === "true" || normalized === "yes") {
      return "native";
    }
    if (normalized === "false" || normalized === "no") {
      return "off";
    }
  }
  if (typeof value === "boolean") {
    return value ? "native" : "off";
  }
  if (value && typeof value === "object" && "enabled" in value) {
    const enabled = (value as { enabled?: unknown }).enabled;
    if (typeof enabled === "boolean") {
      return enabled ? "native" : "off";
    }
  }
  return fallback;
}

export async function buildSyncedAgentHomeSettings(input: {
  config: Config;
  store: TokenStore;
  runtimeFactory?: RuntimeFactory;
  workspaceId: string;
  slackUserId: string;
}): Promise<AgentHomeSettingsView> {
  const principal = {
    workspaceId: input.workspaceId,
    slackUserId: input.slackUserId
  };
  const selection = resolveRuntimeEngineForPrincipal({
    config: input.config,
    store: input.store,
    principal
  });
  const runtime = input.store.getAgentRuntimeForPrincipal({
    ...principal,
    engine: selection.effectiveEngine
  });
  if (runtime && input.runtimeFactory?.syncRuntimeStatus) {
    try {
      await input.runtimeFactory.syncRuntimeStatus(runtime.id);
    } catch (error) {
      console.warn(
        `Runtime status sync failed runtimeId=${runtime.id} error=${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  return buildAgentHomeSettings(input);
}

function buildAgentRuntimeHomeBlocks(settings?: AgentHomeSettingsView) {
  if (!settings) {
    return [];
  }

  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "Agent runtime"
      }
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: formatRuntimeHomeSummary(settings)
      },
    },
    {
      type: "actions",
      elements: buildAgentRuntimeActionElements(settings)
    },
    ...buildAgentSettingsHomeBlocks(settings)
  ];
}

function buildAgentRuntimeActionElements(settings: AgentHomeSettingsView) {
  const elements = [];
  if (settings.runtime.selectableEngines.length > 1) {
    elements.push({
      type: "static_select",
      action_id: "agent_runtime_engine_select",
      placeholder: {
        type: "plain_text",
        text: "Choose runtime"
      },
      initial_option: agentConfigRuntimeEngineOption(
        settings.runtime.engine as AgentRuntimeEngine
      ),
      options: runtimeEngineHomeOptions(settings).map((engine) =>
        agentConfigRuntimeEngineOption(engine as AgentRuntimeEngine)
      )
    });
  }

  if (!isRuntimeLifecycleManagedByBurble(settings.runtime.factory)) {
    // Static runtimes are shared externally managed services, so Burble cannot
    // safely expose per-user lifecycle actions for them.
  } else if (isRuntimeStartable(settings.runtime.status)) {
    elements.push({
      type: "button",
      text: {
        type: "plain_text",
        text: "Start"
      },
      style: "primary",
      action_id: "agent_runtime_start"
    });
  } else {
    elements.push(
      {
        type: "button",
        text: {
          type: "plain_text",
          text: "Pause"
        },
        style: "danger",
        action_id: "agent_runtime_pause",
        confirm: {
          title: {
            type: "plain_text",
            text: "Pause runtime?"
          },
          text: {
            type: "mrkdwn",
            text: "This stops the current runtime instance and may interrupt active autonomous work."
          },
          confirm: {
            type: "plain_text",
            text: "Pause"
          },
          deny: {
            type: "plain_text",
            text: "Cancel"
          }
        }
      },
      {
        type: "button",
        text: {
          type: "plain_text",
          text: "Restart"
        },
        action_id: "agent_runtime_restart",
        confirm: {
          title: {
            type: "plain_text",
            text: "Restart runtime?"
          },
          text: {
            type: "mrkdwn",
            text: "This stops the current runtime and starts it again with the latest configuration."
          },
          confirm: {
            type: "plain_text",
            text: "Restart"
          },
          deny: {
            type: "plain_text",
            text: "Cancel"
          }
        }
      }
    );
  }
  elements.push({
    type: "button",
    text: {
      type: "plain_text",
      text: "Details"
    },
    action_id: "agent_runtime_manage"
  });
  elements.push({
    type: "button",
    text: {
      type: "plain_text",
      text: "Refresh"
    },
    action_id: "agent_runtime_refresh"
  });
  return elements;
}

function runtimeEngineHomeOptions(settings: AgentHomeSettingsView): string[] {
  return settings.runtime.selectableEngines.includes(settings.runtime.engine)
    ? settings.runtime.selectableEngines
    : [settings.runtime.engine, ...settings.runtime.selectableEngines];
}

function isRuntimeStartable(status: string): boolean {
  return status === "not provisioned" || status === "stopped" || status === "failed";
}

function isRuntimeLifecycleManagedByBurble(factory: string): boolean {
  return factory === "docker" || factory === "sandbox";
}

function formatRuntimeHomeSummary(settings: AgentHomeSettingsView): string {
  const runtimeId = settings.runtime.id
    ? `\`${settings.runtime.id}\``
    : "`not provisioned yet`";
  const sandboxId = settings.runtime.sandboxId
    ? `\`${settings.runtime.sandboxId}\``
    : "`none`";
  const lastUsed = settings.runtime.lastUsedAt ?? "never";
  return [
    `Status: \`${settings.runtime.status}\``,
    `Factory: \`${settings.runtime.factory}\``,
    `Engine: \`${settings.runtime.engine}\``,
    `Preferred engine: \`${settings.runtime.preferredEngine ?? "not set"}\``,
    `Selectable engines: \`${formatStringList(settings.runtime.selectableEngines)}\``,
    `Runtime ID: ${runtimeId}`,
    `Sandbox: ${sandboxId}`,
    `Last used: ${lastUsed}`
  ].join("\n");
}

function buildAgentSettingsHomeBlocks(settings?: AgentHomeSettingsView) {
  if (!settings) {
    return [];
  }

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Runtime settings*"
      },
      fields: [
        {
          type: "mrkdwn",
          text: `*Model*\n\`${settings.model}\``
        },
        {
          type: "mrkdwn",
          text: `*User memory*\n\`${settings.userMemory}\``
        },
        {
          type: "mrkdwn",
          text: `*Streaming*\n\`${settings.streaming}\``
        },
        {
          type: "mrkdwn",
          text: `*Runtime*\n\`${settings.runtime.status}\``
        },
        {
          type: "mrkdwn",
          text: `*Policy hash*\n\`${settings.policyHash.slice(0, 12)}\``
        },
        {
          type: "mrkdwn",
          text: `*Disabled tools*\n\`${formatStringList(settings.disabledTools)}\``
        },
        {
          type: "mrkdwn",
          text: `*Enabled skills*\n\`${formatStringList(settings.enabledSkills)}\``
        }
      ],
      accessory: {
        type: "button",
        text: {
          type: "plain_text",
          text: "Edit settings"
        },
        action_id: "agent_config_edit"
      }
    }
  ];
}

function buildAppHomeShortcutContext() {
  return {
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: "You can also manage connections with `/auth` and agent settings with `/agent config`."
      }
    ]
  };
}

export function buildAgentRuntimeManageModalView(input: {
  config: Config;
  store: TokenStore;
  workspaceId: string;
  slackUserId: string;
}): View {
  const settings = buildAgentHomeSettings(input);
  const runtimeLines = [
    `*Status:* \`${settings.runtime.status}\``,
    `*Runtime ID:* ${
      settings.runtime.id ? `\`${settings.runtime.id}\`` : "`not provisioned yet`"
    }`,
    `*Factory:* \`${settings.runtime.factory}\``,
    `*Effective engine:* \`${settings.runtime.engine}\``,
    `*Configured engine:* \`${settings.runtime.configuredEngine}\``,
    `*Preferred engine:* \`${settings.runtime.preferredEngine ?? "not set"}\``,
    `*Allowed engines:* \`${formatStringList(settings.runtime.allowedEngines)}\``,
    `*Selectable engines:* \`${formatStringList(settings.runtime.selectableEngines)}\``,
    `*Endpoint:* ${
      settings.runtime.endpointUrl ? `\`${settings.runtime.endpointUrl}\`` : "`none`"
    }`,
    `*Created:* ${settings.runtime.createdAt ?? "never"}`,
    `*Last used:* ${settings.runtime.lastUsedAt ?? "never"}`,
    `*Policy hash:* \`${settings.policyHash}\``
  ];

  return {
    type: "modal",
    title: {
      type: "plain_text",
      text: "Agent runtime"
    },
    close: {
      type: "plain_text",
      text: "Close"
    },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: runtimeLines.join("\n")
        }
      },
      {
        type: "divider"
      },
      {
        type: "section",
        fields: [
          {
            type: "mrkdwn",
            text: `*Model*\n\`${settings.model}\``
          },
          {
            type: "mrkdwn",
            text: `*User memory*\n\`${settings.userMemory}\``
          },
          {
            type: "mrkdwn",
            text: `*Streaming*\n\`${settings.streaming}\``
          },
          {
            type: "mrkdwn",
            text: `*Disabled tools*\n\`${formatStringList(settings.disabledTools)}\``
          },
          {
            type: "mrkdwn",
            text: `*Enabled skills*\n\`${formatStringList(settings.enabledSkills)}\``
          }
        ]
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "Changing agent settings restarts a live runtime and brings it back with the updated manifest."
          }
        ]
      }
    ]
  };
}

type AgentRuntimeControlAction = "start" | "pause" | "restart";

export function markAgentRuntimeControlInProgress(input: {
  config: Config;
  store: TokenStore;
  workspaceId: string;
  slackUserId: string;
}): string | null {
  if (input.config.agentRuntime !== "burble-runtime") {
    return null;
  }
  const principal = {
    workspaceId: input.workspaceId,
    slackUserId: input.slackUserId
  };
  const selection = resolveRuntimeEngineForPrincipal({
    config: input.config,
    store: input.store,
    principal
  });
  const existing = input.store.getAgentRuntimeForPrincipal({
    workspaceId: input.workspaceId,
    slackUserId: input.slackUserId,
    engine: selection.effectiveEngine
  });
  if (!existing) {
    return null;
  }
  input.store.updateAgentRuntimeStatus(existing.id, {
    status: "provisioning"
  });
  input.store.touchAgentRuntime(existing.id);
  return existing.id;
}

export async function applyAgentRuntimeControl(input: {
  config: Config;
  store: TokenStore;
  runtimeFactory?: RuntimeFactory;
  workspaceId: string;
  slackUserId: string;
  action: AgentRuntimeControlAction;
}): Promise<{
  action: AgentRuntimeControlAction;
  runtimeId: string | null;
  status: AgentRuntimeStatus | "not provisioned";
}> {
  if (input.config.agentRuntime !== "burble-runtime" || !input.runtimeFactory) {
    return {
      action: input.action,
      runtimeId: null,
      status: "not provisioned"
    };
  }

  const principal = {
    workspaceId: input.workspaceId,
    slackUserId: input.slackUserId
  };
  const selection = resolveRuntimeEngineForPrincipal({
    config: input.config,
    store: input.store,
    principal
  });
  const existing = input.store.getAgentRuntimeForPrincipal({
    workspaceId: input.workspaceId,
    slackUserId: input.slackUserId,
    engine: selection.effectiveEngine
  });

  if (input.action === "pause") {
    if (!existing || isRuntimeStartable(existing.status)) {
      return {
        action: input.action,
        runtimeId: existing?.id ?? null,
        status: existing?.status ?? "not provisioned"
      };
    }
    await input.runtimeFactory.stopRuntime(existing.id);
    return {
      action: input.action,
      runtimeId: existing.id,
      status: "stopped"
    };
  }

  if (input.action === "restart" && existing && !isRuntimeStartable(existing.status)) {
    await input.runtimeFactory.stopRuntime(existing.id);
  }

  const runtime = await input.runtimeFactory.getOrCreateRuntime(principal);
  return {
    action: input.action,
    runtimeId: runtime.id,
    status: runtime.status
  };
}

function buildProviderConnectionBlock(input: {
  provider: Provider;
  title: string;
  status: string;
  configured: boolean;
  url: string | null;
  connected: boolean;
  reconnect?: boolean;
  disconnectable?: boolean;
  actionId: string;
  usage: string;
}) {
  const actions = [];
  if (input.configured && input.url) {
    actions.push({
      type: "button",
      text: {
        type: "plain_text",
        text: input.connected || input.reconnect ? "Reconnect" : "Connect"
      },
      url: input.url,
      action_id: input.actionId
    });
  }
  if (input.disconnectable ?? input.connected) {
    actions.push({
      type: "button",
      text: {
        type: "plain_text",
        text: "Disconnect"
      },
      style: "danger",
      action_id: "provider_disconnect",
      value: input.provider,
      confirm: {
        title: {
          type: "plain_text",
          text: `Disconnect ${input.title}?`
        },
        text: {
          type: "mrkdwn",
          text: `Burble and your agent runtime will stop using this ${input.title} connection.`
        },
        confirm: {
          type: "plain_text",
          text: "Disconnect"
        },
        deny: {
          type: "plain_text",
          text: "Cancel"
        }
      }
    });
  }

  const section = {
    type: "section",
    fields: [
      {
        type: "mrkdwn",
        text: `*${input.title}*\n${input.status}`
      },
      {
        type: "mrkdwn",
        text: `*Used for*\n${input.usage}`
      }
    ]
  };
  return actions.length
    ? [
        section,
        {
          type: "actions",
          elements: actions
        }
      ]
    : [section];
}

export function buildHelpResponse() {
  return {
    response_type: "ephemeral" as const,
    text: "Burble help",
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "Burble help"
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: [
            "Ask Burble in a DM or mention Burble in a channel.",
            "",
            "*Examples*",
            "• `what are my open Jira tickets?`",
            "• `assign DM-12 to me`",
            "• `what is my last open GitHub PR?`",
            "• `search Slack for what I said about runtime JWTs`"
          ].join("\n")
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: [
            "*Commands*",
            "• `/auth` - view and connect accounts",
            "• `/auth github` - connect or reconnect GitHub",
            "• `/auth google` - connect or reconnect Google Workspace",
            "• `/auth hubspot` - connect or reconnect HubSpot",
            "• `/auth jira` - connect or reconnect Jira",
            "• `/auth slack` - connect or reconnect Slack search",
            "• `/agent status` - show and power up your current agent runtime",
            "• `/agent config` - inspect your current agent config file",
            "• `/agent grant here` - authorize this channel for scheduled job output",
            "• `/agent ungrant here` - revoke this channel's scheduled job destination grants; any channel member can clean them up",
            "• `/agent exec <task>` - send an explicit task to your private agent runtime",
            "• `/tasks list` - list scheduled task specs",
            "• `/tasks create <description>` - create a scheduled task from a complete description",
            "• `/tasks run [task_id]` - queue a task run",
            "• `/jobs status [task_id]` - inspect the latest scheduled run",
            "• `/agent-status` - legacy alias for agent status",
            "• `/agent-config` - legacy alias for agent config",
            "• `/help` - show this help"
          ].join("\n")
        }
      }
    ]
  };
}

export function buildAgentCommandHelpResponse() {
  return {
    response_type: "ephemeral" as const,
    text: "Agent controls",
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "Agent controls"
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: [
            "Use one of:",
            "• `/agent status` - show and power up your current agent runtime",
            "• `/agent config` - inspect your current agent config file",
            "• `/agent config get [key]` - inspect your user runtime preferences",
            "• `/agent config set <key> <value>` - update an allowed user preference",
            "• `/agent grant here` - authorize this channel for scheduled job output",
            "• `/agent ungrant here` - revoke this channel's scheduled job destination grants; any channel member can clean them up",
            "• `/agent exec` - list active agent tasks",
            "• `/agent exec <task>` - send an explicit task to your private agent runtime",
            "• `/agent exec <id> inspect` - inspect an active or recent task",
            "• `/agent exec <id> stop` - stop an active task"
          ].join("\n")
        }
      }
    ]
  };
}

export function buildAgentDestinationGrantResponse(
  route: ConversationRouteRecord
) {
  const destination = readSlackDestinationGrantResponseTarget(route);
  const destinationText = destination
    ? `When you schedule a public job, ask Burble to post results to <#${destination.channelId}>.`
    : "When you schedule a public job, ask Burble to post results to this channel.";
  return {
    response_type: "ephemeral" as const,
    text: [
      "Authorized this channel as a destination for scheduled jobs.",
      "",
      destinationText,
      "",
      `Route id: \`${route.id}\``,
      "",
      "The route id is kept for debugging; you usually do not need to copy it."
    ].join("\n")
  };
}

function readSlackDestinationGrantResponseTarget(
  route: ConversationRouteRecord
): { channelId: string } | null {
  try {
    const parsed = JSON.parse(route.destinationJson) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    const channelId = (parsed as Record<string, unknown>).channelId;
    return typeof channelId === "string" && channelId.trim()
      ? { channelId: channelId.trim() }
      : null;
  } catch {
    return null;
  }
}

export function buildAgentDestinationGrantLoadingResponse(
  text = "Checking channel permissions..."
) {
  return {
    response_type: "ephemeral" as const,
    text
  };
}

export function buildAgentDestinationGrantDirectMessageResponse() {
  return {
    response_type: "ephemeral" as const,
    text: [
      "Destination grants must be created from the target channel.",
      "",
      "Run `/agent grant here` in the channel where scheduled jobs should post."
    ].join("\n")
  };
}

export function buildAgentDestinationGrantWorkspaceMissingResponse() {
  return {
    response_type: "ephemeral" as const,
    text: "I could not identify this Slack workspace, so I cannot create a scheduled job destination grant here."
  };
}

export type SlackDestinationGrantPreflightFailureReason =
  | "not_in_channel"
  | "archived"
  | "unsupported"
  | "unverified";

export type SlackDestinationGrantPreflightResult =
  | { ok: true; isPrivateChannel: boolean }
  | {
      ok: false;
      reason: SlackDestinationGrantPreflightFailureReason;
      detail?: string;
    };

export function buildAgentDestinationGrantPreflightFailureResponse(
  preflight: Exclude<SlackDestinationGrantPreflightResult, { ok: true }>
) {
  const text =
    preflight.reason === "not_in_channel"
      ? "I cannot authorize this channel yet because Burble is not a member. Please invite me to this channel, then run `/agent grant here` again."
      : preflight.reason === "archived"
        ? "I cannot authorize an archived Slack channel for scheduled job output."
        : preflight.reason === "unsupported"
          ? "Destination grants can only target Slack channels, not direct messages or group DMs."
          : "I could not verify that Burble can post in this channel. Invite Burble to the channel or reconnect Slack, then try `/agent grant here` again.";
  return {
    response_type: "ephemeral" as const,
    text: preflight.detail ? `${text}\n\nSlack detail: \`${preflight.detail}\`` : text
  };
}

export function buildAgentDestinationGrantRevokedResponse(
  revokedCount: number
) {
  return {
    response_type: "ephemeral" as const,
    text: revokedCount > 0
      ? `Revoked ${revokedCount === 1 ? "this channel's scheduled job destination grant" : `${revokedCount} scheduled job destination grants for this channel`}.`
      : "No active scheduled job destination grant exists for this channel."
  };
}

export async function verifySlackDestinationGrantChannel(input: {
  client: App["client"];
  channelId: string;
}): Promise<SlackDestinationGrantPreflightResult> {
  try {
    const response = await input.client.conversations.info({
      channel: input.channelId
    });
    const channel = (response as { channel?: Record<string, unknown> }).channel;
    if (!channel || channel.is_im === true || channel.is_mpim === true) {
      return { ok: false, reason: "unsupported" };
    }
    if (channel.is_archived === true) {
      return { ok: false, reason: "archived" };
    }
    if (channel.is_member !== true) {
      return { ok: false, reason: "not_in_channel" };
    }
    return { ok: true, isPrivateChannel: channel.is_private === true };
  } catch (error) {
    const detail = formatSlackApiErrorDetail(error);
    if (detail === "not_in_channel" || detail === "channel_not_found") {
      return { ok: false, reason: "not_in_channel", detail };
    }
    return {
      ok: false,
      reason: "unverified",
      detail
    };
  }
}

function formatSlackApiErrorDetail(error: unknown): string {
  if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data?: { error?: unknown } }).data;
    if (typeof data?.error === "string" && data.error.trim()) {
      return data.error.trim();
    }
  }
  return error instanceof Error ? error.message : String(error);
}

async function updateAgentExecResponse(input: {
  client: App["client"];
  respond: (message: {
    response_type: "in_channel";
    replace_original?: boolean;
    text: string;
  }) => Promise<unknown>;
  progressMessage?: SlackProgressMessage;
  text: string;
}): Promise<void> {
  if (input.progressMessage) {
    input.progressMessage.text = input.text;
    await input.client.chat.update({
      channel: input.progressMessage.channel,
      ts: input.progressMessage.ts,
      text: input.text
    });
    return;
  }

  await input.respond({
    response_type: "in_channel",
    replace_original: true,
    text: input.text
  });
}

async function postAgentExecResponseMessage(input: {
  client: App["client"];
  channel: string;
  text: string;
}): Promise<SlackProgressMessage | undefined> {
  const result = await input.client.chat.postMessage({
    channel: input.channel,
    text: input.text
  });

  return result.ts
    ? {
        channel: input.channel,
        ts: result.ts,
        text: input.text,
        startedAtMs: Date.now(),
        toolStartedAtMs: {},
        toolLinesByCallId: {},
        toolCallOrder: []
      }
    : undefined;
}

function createAgentExecTask(input: {
  workspaceId: string;
  slackUserId: string;
  channelId: string;
  task: string;
}): AgentExecTask {
  const now = Date.now();
  return {
    id: randomUUID().slice(0, 8),
    workspaceId: input.workspaceId,
    slackUserId: input.slackUserId,
    channelId: input.channelId,
    task: input.task,
    status: "running",
    createdAtMs: now,
    updatedAtMs: now,
    progressText: "Starting agent runtime..."
  };
}

function finishAgentExecTask(
  task: AgentExecTask,
  status: Exclude<AgentExecTaskStatus, "running" | "stopping">,
  finalText = ""
): void {
  task.status = status;
  task.updatedAtMs = Date.now();
  if (status === "failed") {
    task.failureText = finalText;
  } else {
    task.finalText = finalText;
  }
}

function listAgentExecTasks(
  tasks: Map<string, AgentExecTask>,
  workspaceId: string,
  slackUserId: string
): AgentExecTask[] {
  return [...tasks.values()]
    .filter(
      (task) =>
        task.workspaceId === workspaceId &&
        task.slackUserId === slackUserId &&
        (task.status === "running" || task.status === "stopping")
    )
    .sort((left, right) => left.createdAtMs - right.createdAtMs);
}

function findAgentExecTask(
  tasks: Map<string, AgentExecTask>,
  workspaceId: string,
  slackUserId: string,
  taskId: string
): AgentExecTask | null {
  const task = tasks.get(taskId);
  return task?.workspaceId === workspaceId && task.slackUserId === slackUserId
    ? task
    : null;
}

async function stopAgentExecTask(input: {
  task: AgentExecTask;
  runtimeFactory?: RuntimeFactory;
  client: App["client"];
  stoppedBy: string;
}): Promise<void> {
  const { task } = input;
  if (task.status !== "running" && task.status !== "stopping") {
    return;
  }

  task.stopRequested = true;
  task.status = "stopping";
  task.updatedAtMs = Date.now();
  if (task.message) {
    await input.client.chat.update({
      channel: task.message.channel,
      ts: task.message.ts,
      text: formatAgentExecResponseMessage(
        task,
        { statusText: `Stopping task at <@${input.stoppedBy}>'s request...` }
      )
    });
  }

  if (!input.runtimeFactory || !task.runtimeId) {
    return;
  }

  await input.runtimeFactory.stopRuntime(task.runtimeId);
  finishAgentExecTask(task, "stopped", `Stopped by <@${input.stoppedBy}>.`);
  if (task.message) {
    await input.client.chat.update({
      channel: task.message.channel,
      ts: task.message.ts,
      text: formatAgentExecResponseMessage(task, {
        statusText: "Stopped.",
        responseText: task.finalText
      })
    });
  }
}

function buildAgentExecLoadingText(_task: string): string {
  return "Agent task: Preparing agent runtime...";
}

export function buildAgentExecToolGroups(
  task: string
): RuntimeToolGroupSelection {
  return selectRuntimeToolGroups({ text: task });
}

function formatAgentExecResponseMessage(
  task: AgentExecTask,
  input: { statusText: string; responseText?: string }
): string {
  const statusLines = input.statusText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const currentStatus = statusLines.at(-1) ?? "Working...";
  const responseText = input.responseText?.trim();
  return [
    `Agent task (\`${task.id}\`): ${currentStatus}`,
    ...(responseText ? ["", responseText] : [])
  ].join("\n");
}

export function buildAgentExecLoadingResponse(
  task: string,
  responseType: "ephemeral" | "in_channel" = "in_channel"
) {
  return {
    response_type: responseType,
    text: buildAgentExecLoadingText(task)
  };
}

export function buildAgentExecMissingTaskResponse() {
  return {
    response_type: "ephemeral" as const,
    text: "Usage: `/agent exec <task>`. Use `/agent exec` to list active tasks."
  };
}

export function buildAgentExecTaskListResponse(tasks: AgentExecTask[]) {
  return {
    response_type: "ephemeral" as const,
    text:
      tasks.length === 0
        ? "No active agent tasks."
        : [
            "*Active agent tasks*",
            ...tasks.map(
              (task) =>
                `• \`${task.id}\` ${formatAgentExecAge(task)} ${truncateSlackConfigValue(task.task, 120)}\n  Inspect: \`/agent exec ${task.id} inspect\`  Stop: \`/agent exec ${task.id} stop\``
            )
          ].join("\n")
  };
}

export function buildAgentExecTaskInspectResponse(task: AgentExecTask | null) {
  if (!task) {
    return {
      response_type: "ephemeral" as const,
      text: "Agent task not found."
    };
  }

  return {
    response_type: "ephemeral" as const,
    text: [
      `*Agent task* \`${task.id}\``,
      `• Status: \`${task.status}\``,
      `• Age: ${formatAgentExecAge(task)}`,
      `• Runtime: \`${task.runtimeId ?? "not assigned yet"}\``,
      `• Task: \`${truncateSlackConfigValue(task.task, 300)}\``,
      task.finalText
        ? `• Result: ${truncateSlackConfigValue(task.finalText.replace(/\s+/g, " "), 300)}`
        : "",
      task.failureText
        ? `• Failure: ${truncateSlackConfigValue(task.failureText, 300)}`
        : "",
      task.status === "running" || task.status === "stopping"
        ? `• Stop: \`/agent exec ${task.id} stop\``
        : ""
    ]
      .filter(Boolean)
      .join("\n")
  };
}

function buildAgentExecStopLoadingResponse(task: AgentExecTask | null) {
  return {
    response_type: "ephemeral" as const,
    text: task ? `Stopping agent task \`${task.id}\`...` : "Agent task not found."
  };
}

function buildAgentExecStopResponse(task: AgentExecTask | null) {
  if (!task) {
    return {
      response_type: "ephemeral" as const,
      text: "Agent task not found."
    };
  }

  if (task.status === "stopped") {
    return {
      response_type: "ephemeral" as const,
      text: `Stopped agent task \`${task.id}\`.`
    };
  }

  if (task.status !== "running" && task.status !== "stopping") {
    return {
      response_type: "ephemeral" as const,
      text: `Agent task \`${task.id}\` is already \`${task.status}\`; nothing to stop.`
    };
  }

  return {
    response_type: "ephemeral" as const,
    text: task.runtimeId
      ? `Stop requested for agent task \`${task.id}\`.`
      : `Stop requested for agent task \`${task.id}\`; it has not attached to a runtime yet.`
  };
}

function formatAgentExecAge(task: AgentExecTask): string {
  return `${formatElapsedMs(Date.now() - task.createdAtMs)} old`;
}

export function buildAgentConfigResponse(input: {
  runtime: AgentRuntimeRecord | null;
  configFile: AgentConfigFileRead;
}) {
  const configPreview = input.configFile.redactedText
    ? truncateSlackCodeBlock(input.configFile.redactedText, 2400)
    : null;

  return {
    response_type: "ephemeral" as const,
    text: "Agent configuration",
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "Agent configuration"
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: [
            "*Agent config file*",
            `• Runtime: \`${input.runtime?.id ?? "not ready"}\``,
            `• Path: \`${input.configFile.path ?? "not available"}\``,
            input.configFile.topLevelKeys.length > 0
              ? `• Top-level keys: \`${input.configFile.topLevelKeys.join("`, `")}\``
              : "• Top-level keys: `not available`"
          ].join("\n")
        }
      },
      ...(input.configFile.error
        ? [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `Could not read or parse the config file: \`${truncateSlackConfigValue(input.configFile.error, 240)}\``
              }
            }
          ]
        : []),
      ...(configPreview
        ? [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: ["*Redacted JSON preview*", "```", configPreview, "```"].join(
                  "\n"
                )
              }
            }
          ]
        : [])
    ]
  };
}

export function buildAgentConfigLoadingResponse() {
  return {
    response_type: "ephemeral" as const,
    text: "Powering up agent runtime and reading configuration..."
  };
}

type AgentUserConfigKey =
  | "runtime.engine"
  | "runtime.model"
  | "runtime.streaming"
  | "memory.user"
  | "tools.disabled"
  | "skills.enabled";

type AgentUserConfigSetResult = {
  response_type: "ephemeral" | "in_channel";
  text: string;
};

type SlackSlashCommandVisibilityBody = {
  channel_id?: string;
  channel_name?: string;
};

function withDirectMessageSlashCommandVisibility<
  T extends { response_type?: "ephemeral" | "in_channel" }
>(response: T, body: SlackSlashCommandVisibilityBody): T {
  if (!isDirectMessageSlashCommand(body)) {
    return response;
  }
  return {
    ...response,
    response_type: "in_channel"
  };
}

export function isDirectMessageSlashCommand(
  body: SlackSlashCommandVisibilityBody
): boolean {
  return (
    body.channel_name === "directmessage" ||
    body.channel_id?.startsWith("D") === true
  );
}

export function isDestinationGrantSlashCommandChannel(
  body: SlackSlashCommandVisibilityBody
): body is SlackSlashCommandVisibilityBody & { channel_id: string } {
  return Boolean(body.channel_id) && !isDirectMessageSlashCommand(body);
}

type AgentConfigModalValues = {
  model: string;
  runtimeEngine: AgentRuntimeEngine;
  memory: "on" | "off";
  streaming: AgentRuntimeStreamingMode;
  disabledTools: string[];
  enabledSkills: string[];
};

export function buildAgentConfigModalView(input: {
  config: Config;
  store: TokenStore;
  workspaceId: string;
  slackUserId: string;
}): View {
  const settings = buildAgentHomeSettings(input);
  const metadata = JSON.stringify({
    workspaceId: input.workspaceId,
    slackUserId: input.slackUserId
  });
  return {
    type: "modal" as const,
    callback_id: "agent_config_submit",
    title: {
      type: "plain_text",
      text: "Agent settings"
    },
    submit: {
      type: "plain_text",
      text: "Save"
    },
    close: {
      type: "plain_text",
      text: "Cancel"
    },
    private_metadata: metadata,
    blocks: [
      {
        type: "input",
        block_id: "agent_config_model",
        label: {
          type: "plain_text",
          text: "Model"
        },
        element: {
          type: "plain_text_input",
          action_id: "value",
          initial_value: settings.model
        }
      },
      {
        type: "input",
        block_id: "agent_config_runtime_engine",
        label: {
          type: "plain_text",
          text: "Runtime engine"
        },
        element: {
          type: "static_select",
          action_id: "value",
          initial_option: agentConfigRuntimeEngineOption(
            settings.runtime.engine as AgentRuntimeEngine
          ),
          options: runtimeEngineModalOptions(settings).map((engine) =>
            agentConfigRuntimeEngineOption(engine as AgentRuntimeEngine)
          )
        }
      },
      {
        type: "input",
        block_id: "agent_config_memory",
        label: {
          type: "plain_text",
          text: "User memory"
        },
        element: {
          type: "static_select",
          action_id: "value",
          initial_option: agentConfigOnOffOption(settings.userMemory),
          options: [
            agentConfigOnOffOption("on"),
            agentConfigOnOffOption("off")
          ]
        }
      },
      {
        type: "input",
        block_id: "agent_config_streaming",
        label: {
          type: "plain_text",
          text: "Streaming"
        },
        element: {
          type: "static_select",
          action_id: "value",
          initial_option: agentConfigStreamingOption(settings.streaming),
          options: [
            agentConfigStreamingOption("native"),
            agentConfigStreamingOption("basic"),
            agentConfigStreamingOption("off")
          ]
        }
      },
      {
        type: "input",
        block_id: "agent_config_disabled_tools",
        optional: true,
        label: {
          type: "plain_text",
          text: "Disabled tools"
        },
        element: {
          type: "plain_text_input",
          action_id: "value",
          initial_value: settings.disabledTools.join(", "),
          placeholder: {
            type: "plain_text",
            text: "github_create_pr, jira_create_issue"
          }
        }
      },
      {
        type: "input",
        block_id: "agent_config_enabled_skills",
        optional: true,
        label: {
          type: "plain_text",
          text: "Enabled skills"
        },
        element: {
          type: "plain_text_input",
          action_id: "value",
          initial_value: settings.enabledSkills
            .map((skill) => skill.split("@")[0])
            .join(", "),
          placeholder: {
            type: "plain_text",
            text: "core, github, atlassian-jira"
          }
        }
      }
    ]
  };
}

function agentConfigOnOffOption(value: "on" | "off") {
  return {
    text: {
      type: "plain_text",
      text: value === "on" ? "On" : "Off"
    },
    value
  } as const;
}

function agentConfigStreamingOption(value: AgentRuntimeStreamingMode) {
  const label =
    value === "native" ? "Native" : value === "basic" ? "Basic" : "Off";
  return {
    text: {
      type: "plain_text",
      text: label
    },
    value
  } as const;
}

function agentConfigRuntimeEngineOption(value: AgentRuntimeEngine) {
  return {
    text: {
      type: "plain_text",
      text: value
    },
    value
  } as const;
}

function runtimeEngineModalOptions(settings: AgentHomeSettingsView): string[] {
  return settings.runtime.selectableEngines.length > 0
    ? settings.runtime.selectableEngines
    : [settings.runtime.engine];
}

function isAgentRuntimeEngine(value: string): value is AgentRuntimeEngine {
  return agentRuntimeEngines.includes(value as AgentRuntimeEngine);
}

function isAgentRuntimeStreamingMode(
  value: string
): value is AgentRuntimeStreamingMode {
  return value === "off" || value === "basic" || value === "native";
}

export function buildAgentConfigSavedModalView(policyChanged: boolean): View {
  return {
    type: "modal" as const,
    title: {
      type: "plain_text",
      text: "Agent settings"
    },
    close: {
      type: "plain_text",
      text: "Close"
    },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: policyChanged
            ? "*Saved.* Your current agent runtime will restart so the new settings apply cleanly on the next run."
            : "*Saved.* No runtime restart was needed."
        }
      }
    ]
  };
}

function parseAgentConfigModalSubmission(
  body: unknown,
  selection: RuntimeEngineSelection
):
  | { ok: true; values: AgentConfigModalValues }
  | { ok: false; errors: Record<string, string> } {
  const model = readSlackModalPlainTextValue(
    body,
    "agent_config_model",
    "value"
  );
  const memory = readSlackModalSelectedValue(
    body,
    "agent_config_memory",
    "value"
  );
  const streaming = readSlackModalSelectedValue(
    body,
    "agent_config_streaming",
    "value"
  );
  const runtimeEngine = readSlackModalSelectedValue(
    body,
    "agent_config_runtime_engine",
    "value"
  );
  const disabledTools = readSlackModalPlainTextValue(
    body,
    "agent_config_disabled_tools",
    "value"
  );
  const enabledSkills = readSlackModalPlainTextValue(
    body,
    "agent_config_enabled_skills",
    "value"
  );
  const errors: Record<string, string> = {};

  const modelValue = model.trim();
  const modelId = modelValue.includes(":") ? modelValue : `openai:${modelValue}`;
  try {
    validateAgentModelId(modelId);
  } catch (error) {
    errors.agent_config_model =
      error instanceof Error ? error.message : "Invalid model value.";
  }

  if (memory !== "on" && memory !== "off") {
    errors.agent_config_memory = "Choose whether user memory is on or off.";
  }
  if (!isAgentRuntimeStreamingMode(streaming)) {
    errors.agent_config_streaming = "Choose a supported streaming mode.";
  }
  if (!isAgentRuntimeEngine(runtimeEngine)) {
    errors.agent_config_runtime_engine = "Choose a supported runtime engine.";
  } else {
    const validation = validateAgentRuntimeEngineSelection(
      selection,
      runtimeEngine
    );
    if (validation) {
      errors.agent_config_runtime_engine = validation.modalError;
    }
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }
  const memoryValue = memory === "on" ? "on" : "off";
  const streamingValue = streaming as AgentRuntimeStreamingMode;

  return {
    ok: true,
    values: {
      model: modelId,
      runtimeEngine: runtimeEngine as AgentRuntimeEngine,
      memory: memoryValue,
      streaming: streamingValue,
      disabledTools: parseStringListConfigValue(disabledTools),
      enabledSkills: parseStringListConfigValue(enabledSkills)
    }
  };
}

function applyAgentConfigModalValues(input: {
  store: TokenStore;
  principal: { workspaceId: string; slackUserId: string };
  selection: RuntimeEngineSelection;
  values: AgentConfigModalValues;
}): void {
  const runtimeEngineValidation = validateAgentRuntimeEngineSelection(
    input.selection,
    input.values.runtimeEngine
  );
  if (runtimeEngineValidation) {
    throw new Error(runtimeEngineValidation.modalError);
  }

  input.store.upsertUserPreference({
    workspaceId: input.principal.workspaceId,
    slackUserId: input.principal.slackUserId,
    key: "runtime.model",
    value: input.values.model
  });
  input.store.upsertUserPreference({
    workspaceId: input.principal.workspaceId,
    slackUserId: input.principal.slackUserId,
    key: "runtime.engine",
    value: input.values.runtimeEngine
  });
  input.store.upsertUserPreference({
    workspaceId: input.principal.workspaceId,
    slackUserId: input.principal.slackUserId,
    key: "memory.user",
    value: { enabled: input.values.memory === "on" }
  });
  input.store.upsertUserPreference({
    workspaceId: input.principal.workspaceId,
    slackUserId: input.principal.slackUserId,
    key: "runtime.streaming",
    value: input.values.streaming
  });
  input.store.upsertUserPreference({
    workspaceId: input.principal.workspaceId,
    slackUserId: input.principal.slackUserId,
    key: "tools.disabled",
    value: input.values.disabledTools
  });
  input.store.upsertUserPreference({
    workspaceId: input.principal.workspaceId,
    slackUserId: input.principal.slackUserId,
    key: "skills.enabled",
    value: input.values.enabledSkills.map((skill) => ({
      id: skill.includes("@") ? skill.split("@")[0] : skill,
      version: skill.includes("@") ? skill.split("@").slice(1).join("@") : "1"
    }))
  });
}

function readSlackModalPlainTextValue(
  body: unknown,
  blockId: string,
  actionId: string
): string {
  const values = slackModalStateValues(body);
  const field = values?.[blockId]?.[actionId];
  return typeof field?.value === "string" ? field.value : "";
}

function readSlackModalSelectedValue(
  body: unknown,
  blockId: string,
  actionId: string
): string {
  const values = slackModalStateValues(body);
  const field = values?.[blockId]?.[actionId];
  return typeof field?.selected_option?.value === "string"
    ? field.selected_option.value
    : "";
}

function readSlackActionSelectedValue(body: unknown): string {
  if (!body || typeof body !== "object") {
    return "";
  }
  const actions = (body as { actions?: unknown }).actions;
  if (!Array.isArray(actions)) {
    return "";
  }
  const action = actions[0];
  if (!action || typeof action !== "object") {
    return "";
  }
  const selectedValue = (action as { selected_option?: { value?: unknown } })
    .selected_option?.value;
  if (typeof selectedValue === "string") {
    return selectedValue;
  }
  const buttonValue = (action as { value?: unknown }).value;
  return typeof buttonValue === "string" ? buttonValue : "";
}

function slackModalStateValues(body: unknown):
  | Record<string, Record<string, { value?: string; selected_option?: { value?: string } }>>
  | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }
  const view = (body as { view?: unknown }).view;
  if (!view || typeof view !== "object") {
    return undefined;
  }
  const state = (view as { state?: unknown }).state;
  if (!state || typeof state !== "object") {
    return undefined;
  }
  const values = (state as { values?: unknown }).values;
  return values && typeof values === "object"
    ? (values as Record<
        string,
        Record<string, { value?: string; selected_option?: { value?: string } }>
      >)
    : undefined;
}

function slackInteractionContext(
  body: unknown
): { workspaceId: string; slackUserId: string; triggerId?: string } | null {
  if (!body || typeof body !== "object") {
    return null;
  }
  const slackUserId = slackUserIdFromBody(body);
  if (!slackUserId) {
    return null;
  }
  return {
    workspaceId: slackWorkspaceIdFromBody(body),
    slackUserId,
    triggerId: (body as { trigger_id?: string }).trigger_id
  };
}

function slackViewSubmissionContext(
  body: unknown
): { workspaceId: string; slackUserId: string } | null {
  if (!body || typeof body !== "object") {
    return null;
  }
  const metadata = slackViewPrivateMetadata(body);
  if (metadata?.workspaceId && metadata.slackUserId) {
    return metadata;
  }
  const slackUserId = slackUserIdFromBody(body);
  if (!slackUserId) {
    return null;
  }
  return {
    workspaceId: slackWorkspaceIdFromBody(body),
    slackUserId
  };
}

function slackViewPrivateMetadata(
  body: unknown
): { workspaceId: string; slackUserId: string } | null {
  if (!body || typeof body !== "object") {
    return null;
  }
  const view = (body as { view?: unknown }).view;
  const privateMetadata =
    view && typeof view === "object"
      ? (view as { private_metadata?: string }).private_metadata
      : undefined;
  if (!privateMetadata) {
    return null;
  }
  try {
    const parsed = JSON.parse(privateMetadata) as {
      workspaceId?: unknown;
      slackUserId?: unknown;
    };
    return typeof parsed.workspaceId === "string" &&
      typeof parsed.slackUserId === "string"
      ? {
          workspaceId: parsed.workspaceId,
          slackUserId: parsed.slackUserId
        }
      : null;
  } catch {
    return null;
  }
}

function slackWorkspaceIdFromBody(body: unknown): string {
  if (!body || typeof body !== "object") {
    return "";
  }
  const direct = (body as { team_id?: unknown }).team_id;
  if (typeof direct === "string") {
    return direct;
  }
  const team = (body as { team?: unknown }).team;
  return team && typeof team === "object" &&
    typeof (team as { id?: unknown }).id === "string"
    ? ((team as { id: string }).id)
    : "";
}

function slackUserIdFromBody(body: unknown): string | null {
  if (!body || typeof body !== "object") {
    return null;
  }
  const direct = (body as { user_id?: unknown }).user_id;
  if (typeof direct === "string") {
    return direct;
  }
  const user = (body as { user?: unknown }).user;
  return user && typeof user === "object" &&
    typeof (user as { id?: unknown }).id === "string"
    ? ((user as { id: string }).id)
    : null;
}

export function buildAgentUserConfigGetResponse(input: {
  config: Config;
  store: TokenStore;
  workspaceId: string;
  slackUserId: string;
  key?: string;
}): AgentUserConfigSetResult {
  const principal = {
    workspaceId: input.workspaceId,
    slackUserId: input.slackUserId
  };
  const selection = resolveRuntimeEngineForPrincipal({
    config: input.config,
    store: input.store,
    principal
  });
  const manifest = buildRuntimeManifestForPrincipal({
    config: input.config,
    store: input.store,
    principal,
    engine: selection.effectiveEngine
  });
  const streamingMode = resolveSlackStreamingMode({
    config: input.config,
    store: input.store,
    workspaceId: input.workspaceId,
    slackUserId: input.slackUserId
  });
  const key = input.key ? normalizeAgentUserConfigKey(input.key) : null;

  if (input.key && !key) {
    return {
      response_type: "ephemeral",
      text: formatUnknownAgentUserConfigKey(input.key)
    };
  }

  const lines = key
    ? formatAgentUserConfigKeyLines({
        store: input.store,
        principal,
        manifest,
        streamingMode,
        key
      })
    : [
        "*Agent user config*",
        `• Runtime engine: \`${selection.effectiveEngine}\``,
        `• Model: \`${manifest.model.provider}:${manifest.model.model}\``,
        `• User memory: \`${manifest.memory.userMemoryEnabled ? "on" : "off"}\``,
        `• Streaming: \`${streamingMode}\``,
        `• Disabled tools: \`${formatStringList(manifest.disabledTools)}\``,
        `• Enabled skills: \`${formatStringList(manifest.skills.map((skill) => `${skill.id}@${skill.version}`))}\``,
        `• Policy hash: \`${manifest.policyHash}\``,
        "",
        "*Settable keys*",
        "• `runtime.engine`",
        "• `model`",
        "• `streaming`",
        "• `memory`",
        "• `tools.disabled`",
        "• `skills.enabled`"
      ];

  return {
    response_type: "ephemeral",
    text: lines.join("\n")
  };
}

export function applyAgentUserConfigSet(input: {
  config: Config;
  store: TokenStore;
  workspaceId: string;
  slackUserId: string;
  key: string;
  value: string;
}): AgentUserConfigSetResult {
  const principal = {
    workspaceId: input.workspaceId,
    slackUserId: input.slackUserId
  };
  const specialResult = applyAgentUserConfigSpecialSet({ ...input, principal });
  if (specialResult) {
    return specialResult;
  }

  const key = normalizeAgentUserConfigKey(input.key);
  if (!key) {
    return {
      response_type: "ephemeral",
      text: formatUnknownAgentUserConfigKey(input.key)
    };
  }

  const parsed = parseAgentUserConfigValue(key, input.value);
  if (!parsed.ok) {
    return {
      response_type: "ephemeral",
      text: parsed.error
    };
  }
  const beforeSelection = resolveRuntimeEngineForPrincipal({
    config: input.config,
    store: input.store,
    principal
  });
  if (key === "runtime.engine") {
    const validation = validateAgentRuntimeEngineSelection(
      beforeSelection,
      parsed.value as AgentRuntimeEngine
    );
    if (validation) {
      return {
        response_type: "ephemeral",
        text: validation.text
      };
    }
  }

  input.store.upsertUserPreference({
    workspaceId: input.workspaceId,
    slackUserId: input.slackUserId,
    key,
    value: parsed.value
  });
  const selection = resolveRuntimeEngineForPrincipal({
    config: input.config,
    store: input.store,
    principal
  });

  return {
    response_type: "ephemeral",
    text: [
      `Updated \`${displayAgentUserConfigKey(key)}\`.`,
      "",
      ...formatAgentUserConfigKeyLines({
        store: input.store,
        principal,
        manifest: buildRuntimeManifestForPrincipal({
          config: input.config,
          store: input.store,
          principal,
          engine: selection.effectiveEngine
        }),
        streamingMode: resolveSlackStreamingMode({
          config: input.config,
          store: input.store,
          workspaceId: input.workspaceId,
          slackUserId: input.slackUserId
        }),
        key
      })
    ].join("\n")
  };
}

export function validateAgentRuntimeEngineSelection(
  selection: RuntimeEngineSelection,
  engine: AgentRuntimeEngine
): { text: string; modalError: string } | null {
  if (!selection.allowedEngines.includes(engine)) {
    const text = [
      `Runtime engine \`${engine}\` is not allowed in this workspace.`,
      `Allowed engines: \`${formatStringList(selection.allowedEngines)}\`.`
    ].join("\n");
    return {
      text,
      modalError: `Runtime engine ${engine} is no longer allowed in this workspace.`
    };
  }

  if (!selection.selectableEngines.includes(engine)) {
    const compatibility = selection.compatibility.find(
      (entry) => entry.engine === engine
    );
    const reasons = compatibility?.reasons ?? ["unknown"];
    const text = [
      `Runtime engine \`${engine}\` is not selectable yet because it does not meet the required runtime contract.`,
      `Reason: \`${formatStringList(reasons)}\`.`
    ].join("\n");
    return {
      text,
      modalError: `Runtime engine ${engine} is not selectable: ${formatStringList(
        reasons
      )}.`
    };
  }

  return null;
}

export async function applyAgentRuntimeEngineSelection(input: {
  config: Config;
  store: TokenStore;
  runtimeFactory?: RuntimeFactory;
  principal: { workspaceId: string; slackUserId: string };
  engine: AgentRuntimeEngine;
  afterPreferenceSaved?: () => void | Promise<void>;
}): Promise<{ policyChanged: boolean; restart: Awaited<ReturnType<typeof restartAgentRuntimeIfConfigChanged>> }> {
  const previousSelection = resolveRuntimeEngineForPrincipal({
    config: input.config,
    store: input.store,
    principal: input.principal
  });
  const validation = validateAgentRuntimeEngineSelection(
    previousSelection,
    input.engine
  );
  if (validation) {
    throw new Error(validation.modalError);
  }

  const previousPolicyHash = buildRuntimeManifestForEffectiveEngine({
    config: input.config,
    store: input.store,
    principal: input.principal
  }).policyHash;
  input.store.upsertUserPreference({
    workspaceId: input.principal.workspaceId,
    slackUserId: input.principal.slackUserId,
    key: "runtime.engine",
    value: input.engine
  });
  const nextPolicyHash = buildRuntimeManifestForEffectiveEngine({
    config: input.config,
    store: input.store,
    principal: input.principal,
    engine: input.engine
  }).policyHash;
  try {
    await input.afterPreferenceSaved?.();
  } catch {
    // The final publish after restart will still refresh App Home; a transient
    // publish failure should not prevent applying the selected runtime.
  }

  return {
    policyChanged: previousPolicyHash !== nextPolicyHash,
    restart: await restartAgentRuntimeIfConfigChanged({
      config: input.config,
      store: input.store,
      runtimeFactory: input.runtimeFactory,
      principal: input.principal,
      previousPolicyHash,
      nextPolicyHash,
      previousEngine: previousSelection.effectiveEngine
    })
  };
}

function isDisconnectableProvider(value: unknown): value is Provider {
  return typeof value === "string" && isConnectedProviderId(value);
}

export async function restartAgentRuntimeIfConfigChanged(input: {
  config: Config;
  store: TokenStore;
  runtimeFactory?: RuntimeFactory;
  principal: { workspaceId: string; slackUserId: string };
  previousPolicyHash: string;
  nextPolicyHash: string;
  previousEngine?: AgentRuntimeEngine;
}): Promise<{ stoppedRuntimeId: string; startedRuntimeId: string } | null> {
  if (input.previousPolicyHash === input.nextPolicyHash) {
    return null;
  }
  if (input.config.agentRuntime !== "burble-runtime" || !input.runtimeFactory) {
    return null;
  }

  const runtime = input.store.getAgentRuntimeForPrincipal({
    workspaceId: input.principal.workspaceId,
    slackUserId: input.principal.slackUserId,
    engine:
      input.previousEngine ??
      resolveRuntimeEngineForPrincipal({
        config: input.config,
        store: input.store,
        principal: input.principal
      }).effectiveEngine
  });
  if (
    !runtime ||
    runtime.status === "stopping" ||
    runtime.status === "stopped" ||
    runtime.status === "failed"
  ) {
    return null;
  }

  await input.runtimeFactory.stopRuntime(runtime.id);
  const freshRuntime = await input.runtimeFactory.getOrCreateRuntime(input.principal);
  return {
    stoppedRuntimeId: runtime.id,
    startedRuntimeId: freshRuntime.id
  };
}

function addAgentConfigRuntimeRestartNotice(
  response: AgentUserConfigSetResult,
  policyChanged: boolean
): AgentUserConfigSetResult {
  if (!policyChanged) {
    return response;
  }
  return {
    ...response,
    text: [
      response.text,
      "",
      "_Your current agent runtime will restart so the new config applies cleanly on the next run._"
    ].join("\n")
  };
}

export function buildAgentConfigRuntimeRestartResponse(
  restart: { stoppedRuntimeId: string; startedRuntimeId: string } | null
): AgentUserConfigSetResult {
  return {
    response_type: "ephemeral",
    text: restart
      ? `Agent runtime restarted with updated config. Runtime: \`${restart.startedRuntimeId}\`.`
      : "Config saved. No live agent runtime needed a restart; the next agent request will start with the updated config."
  };
}

export function buildAgentConfigRuntimeRestartFailureResponse(
  error: unknown
): AgentUserConfigSetResult {
  return {
    response_type: "ephemeral",
    text: [
      "Config saved, but I could not restart the current agent runtime automatically.",
      "",
      `Error: \`${formatAgentConfigRestartErrorMessage(error)}\``,
      "",
      "The new config will still be sent with future runs; if the old runtime keeps behaving incorrectly, restart it manually."
    ].join("\n")
  };
}

function formatAgentConfigRestartErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function applyAgentUserConfigSpecialSet(input: {
  config: Config;
  store: TokenStore;
  workspaceId: string;
  slackUserId: string;
  key: string;
  value: string;
  principal: { workspaceId: string; slackUserId: string };
}): AgentUserConfigSetResult | null {
  const key = input.key.toLowerCase();
  if (key !== "disable-tool" && key !== "enable-tool") {
    return null;
  }

  const tool = input.value.trim();
  if (!tool) {
    return {
      response_type: "ephemeral",
      text: `Usage: \`/agent config set ${key} <tool_name>\`.`
    };
  }

  const existing = readUserPreferenceStringList(
    input.store,
    input.principal,
    "tools.disabled"
  );
  const next =
    key === "disable-tool"
      ? [...new Set([...existing, tool])].sort()
      : existing.filter((entry) => entry !== tool);
  input.store.upsertUserPreference({
    workspaceId: input.workspaceId,
    slackUserId: input.slackUserId,
    key: "tools.disabled",
    value: next
  });

  const manifest = buildRuntimeManifestForEffectiveEngine({
    config: input.config,
    store: input.store,
    principal: input.principal
  });
  return {
    response_type: "ephemeral",
    text: [
      key === "disable-tool"
        ? `Disabled tool \`${tool}\` for your agent runtime.`
        : `Enabled tool \`${tool}\` for your agent runtime.`,
      "",
      ...formatAgentUserConfigKeyLines({
        store: input.store,
        principal: input.principal,
        manifest,
        streamingMode: resolveSlackStreamingMode({
          config: input.config,
          store: input.store,
          workspaceId: input.principal.workspaceId,
          slackUserId: input.principal.slackUserId
        }),
        key: "tools.disabled"
      })
    ].join("\n")
  };
}

function parseAgentUserConfigValue(
  key: AgentUserConfigKey,
  value: string
): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = value.trim();
  if (!trimmed) {
    return {
      ok: false,
      error: `Usage: \`/agent config set ${displayAgentUserConfigKey(key)} <value>\`.`
    };
  }

  if (key === "runtime.model") {
    const modelId = trimmed.includes(":") ? trimmed : `openai:${trimmed}`;
    try {
      validateAgentModelId(modelId);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Invalid model value."
      };
    }
    return { ok: true, value: modelId };
  }

  if (key === "runtime.engine") {
    const normalized = trimmed.toLowerCase();
    if (!isAgentRuntimeEngine(normalized)) {
      return {
        ok: false,
        error: `Runtime engine must be one of ${agentRuntimeEngines.join(", ")}.`
      };
    }
    return { ok: true, value: normalized };
  }

  if (key === "memory.user") {
    const enabled = parseBooleanConfigValue(trimmed);
    if (enabled === null) {
      return {
        ok: false,
        error: "Memory must be `on`, `off`, `true`, or `false`."
      };
    }
    return { ok: true, value: { enabled } };
  }

  if (key === "runtime.streaming") {
    const mode = parseAgentRuntimeStreamingModeConfigValue(trimmed);
    if (!mode) {
      return {
        ok: false,
        error: "Streaming must be `native`, `basic`, `off`, `on`, `true`, or `false`."
      };
    }
    return { ok: true, value: mode };
  }

  const values = parseStringListConfigValue(trimmed);
  if (key === "skills.enabled") {
    return {
      ok: true,
      value: values.map((id) => ({ id, version: "1" }))
    };
  }
  return { ok: true, value: values };
}

function normalizeAgentUserConfigKey(key: string): AgentUserConfigKey | null {
  const normalized = key.trim().toLowerCase().replace(/[_\s-]+/g, ".");
  switch (normalized) {
    case "engine":
    case "runtime":
    case "runtime.engine":
      return "runtime.engine";
    case "model":
    case "runtime.model":
      return "runtime.model";
    case "streaming":
    case "runtime.streaming":
      return "runtime.streaming";
    case "memory":
    case "user.memory":
    case "memory.user":
      return "memory.user";
    case "tools":
    case "disabled.tools":
    case "tools.disabled":
      return "tools.disabled";
    case "skills":
    case "enabled.skills":
    case "skills.enabled":
      return "skills.enabled";
    default:
      return null;
  }
}

function displayAgentUserConfigKey(key: AgentUserConfigKey): string {
  switch (key) {
    case "runtime.engine":
      return "runtime.engine";
    case "runtime.model":
      return "model";
    case "runtime.streaming":
      return "streaming";
    case "memory.user":
      return "memory";
    default:
      return key;
  }
}

function formatUnknownAgentUserConfigKey(key: string): string {
  return [
    `Unknown user config key: \`${truncateSlackConfigValue(key, 80)}\`.`,
    "Allowed keys: `runtime.engine`, `model`, `streaming`, `memory`, `tools.disabled`, `skills.enabled`.",
    "Shortcuts: `disable-tool <tool_name>`, `enable-tool <tool_name>`."
  ].join("\n");
}

function formatAgentUserConfigKeyLines(input: {
  store: TokenStore;
  principal: { workspaceId: string; slackUserId: string };
  manifest: ReturnType<typeof buildRuntimeManifestForPrincipal>;
  streamingMode: AgentRuntimeStreamingMode;
  key: AgentUserConfigKey;
}): string[] {
  switch (input.key) {
    case "runtime.engine": {
      return [
        "*Runtime engine*",
        `• Effective: \`${input.manifest.runtime.engine}\``,
        `• Stored preference: \`${formatPreferenceValue(
          input.store.getUserPreference(
            input.principal.workspaceId,
            input.principal.slackUserId,
            "runtime.engine"
          )?.value
        )}\``
      ];
    }
    case "runtime.model":
      return [
        "*Model*",
        `• Effective: \`${input.manifest.model.provider}:${input.manifest.model.model}\``,
        `• Stored preference: \`${formatPreferenceValue(
          input.store.getUserPreference(
            input.principal.workspaceId,
            input.principal.slackUserId,
            "runtime.model"
          )?.value
        )}\``
      ];
    case "memory.user":
      return [
        "*User memory*",
        `• Effective: \`${input.manifest.memory.userMemoryEnabled ? "on" : "off"}\``,
        `• Stored preference: \`${formatPreferenceValue(
          input.store.getUserPreference(
            input.principal.workspaceId,
            input.principal.slackUserId,
            "memory.user"
          )?.value
        )}\``
      ];
    case "runtime.streaming":
      return [
        "*Streaming*",
        `• Effective: \`${input.streamingMode}\``,
        `• Runtime deltas: \`${input.manifest.streaming.messageDeltasEnabled ? "on" : "off"}\``,
        `• Stored preference: \`${formatPreferenceValue(
          input.store.getUserPreference(
            input.principal.workspaceId,
            input.principal.slackUserId,
            "runtime.streaming"
          )?.value
        )}\``
      ];
    case "tools.disabled":
      return [
        "*Disabled tools*",
        `• Effective: \`${formatStringList(input.manifest.disabledTools)}\``
      ];
    case "skills.enabled":
      return [
        "*Enabled skills*",
        `• Effective: \`${formatStringList(
          input.manifest.skills.map((skill) => `${skill.id}@${skill.version}`)
        )}\``
      ];
  }
}

function readUserPreferenceStringList(
  store: TokenStore,
  principal: { workspaceId: string; slackUserId: string },
  key: string
): string[] {
  const value = store.getUserPreference(
    principal.workspaceId,
    principal.slackUserId,
    key
  )?.value;
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function parseBooleanConfigValue(value: string): boolean | null {
  const normalized = value.toLowerCase();
  if (["on", "true", "yes", "enabled", "enable"].includes(normalized)) {
    return true;
  }
  if (["off", "false", "no", "disabled", "disable"].includes(normalized)) {
    return false;
  }
  return null;
}

function parseAgentRuntimeStreamingModeConfigValue(
  value: string
): AgentRuntimeStreamingMode | null {
  const normalized = value.trim().toLowerCase();
  if (isAgentRuntimeStreamingMode(normalized)) {
    return normalized;
  }
  const enabled = parseBooleanConfigValue(normalized);
  if (enabled === null) {
    return null;
  }
  return enabled ? "native" : "off";
}

function parseStringListConfigValue(value: string): string[] {
  return value
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function formatScheduleForHome(schedule: unknown): string {
  if (!schedule || typeof schedule !== "object") {
    return "`schedule unknown`";
  }
  const record = schedule as Record<string, unknown>;
  if (record.kind === "cron") {
    const expression =
      typeof record.expression === "string" && record.expression.trim()
        ? record.expression.trim().replace(/\s+/g, " ")
        : "unknown";
    const timezone =
      typeof record.timezone === "string" && record.timezone.trim()
        ? record.timezone.trim()
        : "UTC";
    return `\`cron ${expression} (${timezone})\``;
  }
  if (record.kind === "interval") {
    return "`interval`";
  }
  return `\`${String(record.kind ?? "schedule unknown")}\``;
}

function formatRelativeIsoTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return value;
  }
  const secondsAgo = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (secondsAgo < 60) {
    return `${secondsAgo}s ago`;
  }
  const minutesAgo = Math.floor(secondsAgo / 60);
  if (minutesAgo < 60) {
    return `${minutesAgo}m ago`;
  }
  const hoursAgo = Math.floor(minutesAgo / 60);
  if (hoursAgo < 48) {
    return `${hoursAgo}h ago`;
  }
  const daysAgo = Math.floor(hoursAgo / 24);
  return `${daysAgo}d ago`;
}

function escapeSlackMrkdwn(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncateSlackText(value: string, maxLength: number): string {
  const chars = Array.from(value);
  return chars.length > maxLength ? `${chars.slice(0, maxLength - 1).join("")}…` : value;
}

function formatStringList(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "none";
}

function formatPreferenceValue(value: unknown): string {
  if (value === undefined) {
    return "not set";
  }
  if (typeof value === "string") {
    return value;
  }
  return truncateSlackConfigValue(JSON.stringify(value), 160);
}

function formatAgentConfigFailureMessage(error: unknown): string {
  const detail = error instanceof Error ? ` ${error.message}` : "";
  return `I could not power up the agent runtime or read configuration.${detail}`;
}

export function buildAgentStatusResponse(input: {
  config: Config;
  runtime: AgentRuntimeRecord | null;
}) {
  return {
    response_type: "ephemeral" as const,
    text: "Agent status",
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "Agent status"
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: [
            "*Runtime*",
            `• Agent mode: \`${input.config.agentMode}\``,
            `• Runtime: \`${input.config.agentRuntime}\``,
            `• Runtime factory: \`${input.config.agentRuntimeFactory}\``,
            `• Runtime engine: \`${input.config.agentRuntimeEngine}\``,
            `• Model: \`${input.config.aiModel}\``
          ].join("\n")
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: [
            "*Provider tool path*",
            `• MCP gateway: \`${input.config.agentRuntimeMcpGatewayUrl ?? "not configured"}\``,
            `• MCP audience: \`${input.config.agentRuntimeMcpAudience ?? "not configured"}\``,
            `• Runtime JWT TTL: \`${input.config.agentRuntimeJwtTtlSeconds}s\``
          ].join("\n")
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: formatAgentRuntimeRecord(input.runtime)
        }
      }
    ]
  };
}

export function buildAgentStatusLoadingResponse() {
  return {
    response_type: "ephemeral" as const,
    text: "Powering up agent runtime and reading status..."
  };
}

function formatAgentStatusFailureMessage(error: unknown): string {
  const detail = error instanceof Error ? ` ${error.message}` : "";
  return `I could not power up the agent runtime or read status.${detail}`;
}

function redactConfigValue(value: unknown, key = ""): unknown {
  if (isSensitiveConfigKey(key)) {
    return "[redacted]";
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactConfigValue(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
        entryKey,
        redactConfigValue(entryValue, entryKey)
      ])
    );
  }

  if (typeof value === "string" && looksSensitiveConfigString(value)) {
    return "[redacted]";
  }

  return value;
}

function isSensitiveConfigKey(key: string): boolean {
  return /(?:api[_-]?key|token|secret|password|credential|authorization|private[_-]?key)/i.test(
    key
  );
}

function looksSensitiveConfigString(value: string): boolean {
  return /^(?:sk-[a-z0-9_-]{16,}|xox[a-z]-|gh[pousr]_|burble_rt_)/i.test(value);
}

function formatAgentRuntimeRecord(runtime: AgentRuntimeRecord | null): string {
  if (!runtime) {
    return [
      "*Your runtime*",
      "No runtime record exists yet for this workspace/user/engine."
    ].join("\n");
  }

  return [
    "*Your runtime*",
    `• ID: \`${runtime.id}\``,
    `• Engine: \`${runtime.engine}\``,
    `• Status: \`${runtime.status}\``,
    `• Endpoint: \`${runtime.endpointUrl}\``,
    `• Last used: \`${runtime.lastUsedAt}\``,
    `• Last seen: \`${runtime.lastSeenAt}\``,
    ...(runtime.failureReason
      ? [`• Failure: \`${truncateSlackConfigValue(runtime.failureReason, 160)}\``]
      : [])
  ].join("\n");
}

function truncateSlackConfigValue(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function truncateSlackCodeBlock(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 42)}\n... truncated for Slack preview ...`;
}

function formatConnectionStatus(
  connection: ProviderConnection | null | undefined,
  provider: "github" | "google" | "hubspot" | "jira" | "slack"
): string {
  if (!connection) {
    return "Not connected.";
  }

  if (provider === "slack") {
    return `Connected as <@${connection.providerLogin}>.`;
  }

  return `Connected as \`${connection.providerLogin}\`.`;
}

function formatMcpGwGoogleConnectionStatus(
  status: McpGwGoogleAuthStatus | null
): string {
  if (!status) {
    return "MCP-GW connection status unavailable.";
  }
  if (status.connected) {
    return status.email
      ? `Connected through MCP-GW as \`${status.email}\`.`
      : "Connected through MCP-GW.";
  }
  if (status.email || status.missingScopes.length > 0) {
    const account = status.email ? ` for \`${status.email}\`` : "";
    const missing = status.missingScopes.length
      ? ` Missing ${status.missingScopes.length} required Google Workspace scope${status.missingScopes.length === 1 ? "" : "s"}.`
      : "";
    return `Reconnect required through MCP-GW${account}.${missing}`;
  }
  return "Not connected through MCP-GW.";
}

async function resolveGoogleAuthView(input: {
  service?: McpGwGoogleAuthService;
  principal: { workspaceId: string; slackUserId: string };
  legacyUrl: string | null;
  includeStatus?: boolean;
  logWarn?: (message: string) => void;
}): Promise<{
  googleUrl: string | null;
  googleMcpGw?: { status: McpGwGoogleAuthStatus | null };
}> {
  if (!input.service) {
    return { googleUrl: input.legacyUrl };
  }

  let googleUrl: string | null = null;
  let status: McpGwGoogleAuthStatus | null = null;
  try {
    googleUrl = (await input.service.start(input.principal)).authorizationUrl;
  } catch (error) {
    input.logWarn?.(
      `Could not start MCP-GW Google auth: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (input.includeStatus !== false) {
    try {
      status = await input.service.status(input.principal);
    } catch (error) {
      input.logWarn?.(
        `Could not read MCP-GW Google auth status: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return { googleUrl, googleMcpGw: { status } };
}

function toBoltLogLevel(level: SlackLogLevel): LogLevel {
  switch (level) {
    case "debug":
      return LogLevel.DEBUG;
    case "warn":
      return LogLevel.WARN;
    case "error":
      return LogLevel.ERROR;
    case "info":
      return LogLevel.INFO;
  }
}

export function summarizeSlackPayload(body: unknown): string {
  const payload = body as {
    type?: string;
    command?: string;
    user_id?: string;
    channel_id?: string;
    team_id?: string;
    event?: {
      type?: string;
      user?: string;
      channel?: string;
    };
  };

  return [
    `type=${payload.type ?? "unknown"}`,
    `command=${payload.command ?? "none"}`,
    `event=${payload.event?.type ?? "none"}`,
    `user=${payload.user_id ?? payload.event?.user ?? "unknown"}`,
    `channel=${payload.channel_id ?? payload.event?.channel ?? "unknown"}`,
    `team=${payload.team_id ?? "unknown"}`
  ].join(" ");
}

export function shouldHandleDirectMessageEvent(
  event: SlackDirectMessageEvent
): event is Required<
  Pick<SlackDirectMessageEvent, "channel" | "user" | "ts">
> &
  SlackDirectMessageEvent {
  const hasText =
    typeof event.text === "string" && event.text.trim().length > 0;
  const hasFiles = Array.isArray(event.files) && event.files.length > 0;

  return (
    event.channel_type === "im" &&
    Boolean(event.channel) &&
    Boolean(event.user) &&
    (hasText || hasFiles) &&
    Boolean(event.ts) &&
    (!event.subtype || event.subtype === "file_share") &&
    !event.bot_id &&
    !(typeof event.text === "string" && event.text.trim().startsWith("/"))
  );
}

export function buildReplyThreadTs(input: {
  isDirectMessage: boolean;
  messageTs: string;
  threadTs?: string;
}): string | undefined {
  if (input.threadTs) {
    return input.threadTs;
  }

  return input.isDirectMessage ? undefined : input.messageTs;
}

async function readRecentSlackMessages(
  client: App["client"],
  input: {
    channel: string;
    latestTs: string;
    user: string;
    logWarn?: (message: string) => void;
  }
): Promise<SlackRecentMessageRead> {
  try {
    const result = await client.conversations.history({
      channel: input.channel,
      latest: input.latestTs,
      inclusive: false,
      limit: 50
    });
    const messages = ((result.messages ?? []) as SlackHistoryMessage[])
      .slice()
      .reverse();

    return {
      messages: messages.flatMap<SlackRecentMessage>((message) => {
        const text = sanitizeRecentSlackText(message.text);
        if (!text || isProgressOnlyMessage(text)) {
          return [];
        }

        if (message.user === input.user) {
          return [{ author: "user" as const, speaker: `<@${message.user}>`, text }];
        }

        if (message.bot_id) {
          return [{ author: "assistant" as const, text }];
        }

        if (message.user) {
          return [{ author: "user" as const, speaker: `<@${message.user}>`, text }];
        }

        return [];
      })
    };
  } catch (error) {
    const historyError = summarizeSlackHistoryError(error);
    input.logWarn?.(
      `Slack channel history unavailable channel=${input.channel} reason=${historyError}`
    );
    return {
      messages: [],
      historyError
    };
  }
}

function buildSlackRequestContext(input: {
  channelId: string;
  isDirectMessage: boolean;
  read: SlackRecentMessageRead;
}): NonNullable<ConversationRequest["context"]> {
  return {
    currentChannel: {
      id: input.channelId,
      isDirectMessage: input.isDirectMessage,
      historyAvailable: !input.read.historyError,
      ...(input.read.historyError ? { historyError: input.read.historyError } : {})
    },
    recentMessages: input.read.messages
  };
}

function buildConversationAttachments(
  files: SlackFileReference[] | undefined
): { attachments?: ConversationAttachment[] } {
  const attachments = (files ?? []).flatMap<ConversationAttachment>((file) => {
    if (!file.id) {
      return [];
    }

    const mimeType = normalizeSlackFileMimeType(file);
    return [
      {
        id: `slack:${file.id}`,
        externalId: file.id,
        source: "slack",
        kind: classifyAttachmentKind(mimeType),
        mimeType,
        ...(file.name || file.title ? { name: file.name ?? file.title } : {}),
        ...(typeof file.size === "number" && Number.isFinite(file.size)
          ? { sizeBytes: file.size }
          : {})
      }
    ];
  });

  return attachments.length > 0 ? { attachments } : {};
}

function normalizeSlackFileMimeType(file: SlackFileReference): string {
  if (file.mimetype?.trim()) {
    return file.mimetype.trim();
  }

  if (file.filetype?.trim()) {
    return `application/x-slack-${file.filetype.trim()}`;
  }

  return "application/octet-stream";
}

function classifyAttachmentKind(
  mimeType: string
): ConversationAttachment["kind"] {
  if (mimeType.startsWith("image/")) {
    return "image";
  }
  if (mimeType.startsWith("audio/")) {
    return "audio";
  }
  if (mimeType.startsWith("video/")) {
    return "video";
  }
  return "file";
}

function summarizeSlackHistoryError(error: unknown): string {
  if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data?: { error?: unknown } }).data;
    if (typeof data?.error === "string") {
      return data.error;
    }
  }

  if (error instanceof Error && error.message) {
    return error.message.replace(/\s+/g, "_").slice(0, 80);
  }

  return "unknown_error";
}

function sanitizeRecentSlackText(text: string | undefined): string {
  return text?.replace(/\s+/g, " ").trim() ?? "";
}

export function isProgressOnlyMessage(text: string): boolean {
  return isRuntimeProgressOnlyMessage(text);
}

export async function postConversationResponse(
  client: App["client"],
  input: {
    response: ConversationResponse;
    channel: string;
    user: string;
    progressMessage?: SlackProgressMessage;
    threadTs?: string;
  }
): Promise<void> {
  const responseBlocks = sanitizeConversationResponseBlocks(input.response.blocks);
  if (input.progressMessage && input.response.visibility !== "ephemeral") {
    const finalProgressLine = formatSlackFinalProgressLine(
      Date.now() - input.progressMessage.startedAtMs,
      input.response.usage
    );
    if (
      input.progressMessage.nativeStreamTs &&
      !input.progressMessage.nativeStreamFallbackReason
    ) {
      const pendingText = sanitizeRuntimeFinalProgressText(
        input.progressMessage.nativeStreamPendingText ?? ""
      );
      const finalStreamText = [pendingText, "", finalProgressLine].join("\n");
      try {
        await stopSlackNativeStream(client, input.progressMessage, {
          markdownText: finalStreamText,
          blocks: responseBlocks
        });
        const hasToolProgress = input.progressMessage.toolCallOrder.some((callId) =>
          Boolean(input.progressMessage?.toolLinesByCallId[callId]?.trim())
        );
        const finishedProgressText = hasToolProgress
          ? renderProgressLines(input.progressMessage)
          : renderProgressLines(input.progressMessage, [finalProgressLine]);
        input.progressMessage.text = finishedProgressText;
        await client.chat.update({
          channel: input.progressMessage.channel,
          ts: input.progressMessage.ts,
          text: finishedProgressText
        });
        return;
      } catch {
        input.progressMessage.streamingMode = "basic";
      }
    }
    if (input.progressMessage.streamedText?.trim()) {
      const responseText =
        renderConversationResponseText(input.response).trim() ||
        sanitizeRuntimeFinalProgressText(input.progressMessage.streamedText);
      const finishedText = renderFinalProgressMessage(
        input.progressMessage,
        responseText,
        finalProgressLine
      );
      input.progressMessage.text = finishedText;
      await client.chat.update({
        channel: input.progressMessage.channel,
        ts: input.progressMessage.ts,
        text: finishedText,
        ...(responseBlocks ? { blocks: responseBlocks } : {})
      });
      return;
    }

    const responseText = renderConversationResponseText(input.response).trim();
    if (responseText) {
      const finishedText = renderFinalProgressMessage(
        input.progressMessage,
        responseText,
        finalProgressLine
      );
      input.progressMessage.text = finishedText;
      await client.chat.update({
        channel: input.progressMessage.channel,
        ts: input.progressMessage.ts,
        text: finishedText,
        ...(responseBlocks ? { blocks: responseBlocks } : {})
      });
      return;
    }

    if (input.progressMessage.suppressedRuntimeControlNotice) {
      const finishedText = renderFinalProgressMessage(
        input.progressMessage,
        runtimeControlNoticeFallbackText(),
        finalProgressLine
      );
      input.progressMessage.text = finishedText;
      await client.chat.update({
        channel: input.progressMessage.channel,
        ts: input.progressMessage.ts,
        text: finishedText
      });
      return;
    }

    const finishedText = renderProgressLines(input.progressMessage, [
      finalProgressLine
    ]);
    input.progressMessage.text = finishedText;
    await client.chat.update({
      channel: input.progressMessage.channel,
      ts: input.progressMessage.ts,
      text: finishedText
    });
    if (!responseText && !responseBlocks) {
      return;
    }
    await client.chat.postMessage({
      channel: input.response.visibility === "dm" ? input.user : input.channel,
      ...(input.threadTs && input.response.visibility !== "dm"
        ? { thread_ts: input.threadTs }
        : {}),
      text: renderConversationResponseText(input.response),
      ...(responseBlocks ? { blocks: responseBlocks } : {})
    });
    return;
  }

  if (input.response.visibility === "ephemeral") {
    await client.chat.postEphemeral({
      channel: input.channel,
      user: input.user,
      text: renderConversationResponseText(input.response),
      ...(responseBlocks ? { blocks: responseBlocks } : {})
    });
    return;
  }

  if (input.response.visibility === "dm") {
    await client.chat.postMessage({
      channel: input.user,
      text: renderConversationResponseText(input.response),
      ...(responseBlocks ? { blocks: responseBlocks } : {})
    });
    return;
  }

  await client.chat.postMessage({
    channel: input.channel,
    ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
    text: renderConversationResponseText(input.response),
    ...(responseBlocks ? { blocks: responseBlocks } : {})
  });
}

function renderConversationResponseText(response: ConversationResponse): string {
  const responseText = markdownToSlackMrkdwn(
    sanitizeRuntimeFinalResponseText(sanitizeRuntimeStreamText(response.text))
  );
  if (!response.attachments || response.attachments.length === 0) {
    return responseText;
  }

  return [
    ...(responseText.trim() ? [responseText, ""] : []),
    "*Attachments:*",
    ...response.attachments.map((attachment) => {
      const label = attachment.name ?? attachment.id;
      return `- ${label} (${attachment.kind}, ${attachment.mimeType})`;
    })
  ].join("\n");
}

function sanitizeRuntimeFinalResponseText(text: string): string {
  if (!text.trim()) {
    return text;
  }

  const lines = text.split(/\r?\n/);
  const kept = lines.filter((line) => !isProgressOnlyMessage(line.trim()));
  if (kept.length === lines.length) {
    return text;
  }

  const cleaned = kept.join("\n").trim();
  if (cleaned) {
    return cleaned;
  }

  return runtimeControlNoticeFallbackText();
}

function sanitizeRuntimeFinalProgressText(text: string): string {
  return sanitizeRuntimeFinalResponseText(sanitizeRuntimeStreamText(text)).trim();
}

function sanitizeConversationResponseBlocks(blocks: unknown[] | undefined): unknown[] | undefined {
  if (!blocks) {
    return undefined;
  }

  return sanitizeRuntimeStreamValue(blocks) as unknown[];
}

function sanitizeRuntimeStreamValue(value: unknown): unknown {
  if (typeof value === "string") {
    return sanitizeRuntimeStreamText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeRuntimeStreamValue(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        sanitizeRuntimeStreamValue(entry)
      ])
    );
  }

  return value;
}

async function postMentionWorkingState(
  client: App["client"],
  input: {
    channel: string;
    user: string;
    isDirectMessage: boolean;
    threadTs?: string;
    streamThreadTs?: string;
    streamingMode: AgentRuntimeStreamingMode;
  }
): Promise<SlackProgressMessage | undefined> {
  const text = formatMentionWorkingMessage();

  if (input.isDirectMessage) {
    const progressStreamingMode = resolveSlackProgressStreamingMode({
      streamingMode: input.streamingMode,
      streamThreadTs: input.streamThreadTs
    });
    const result = await client.chat.postMessage({
      channel: input.channel,
      ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
      text
    });
    return result.ts
      ? {
          channel: input.channel,
          ts: result.ts,
          text,
          ...(input.streamThreadTs ? { threadTs: input.streamThreadTs } : {}),
          streamingMode: progressStreamingMode,
          startedAtMs: Date.now(),
          toolStartedAtMs: {},
          toolLinesByCallId: {},
          toolCallOrder: []
        }
      : undefined;
  }

  await client.chat.postEphemeral({
    channel: input.channel,
    user: input.user,
    ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
    text
  });
  return undefined;
}

function createLazyAgentProgressReporter(
  client: App["client"],
  input: {
    channel: string;
    user: string;
    isDirectMessage: boolean;
    threadTs?: string;
    streamThreadTs?: string;
    streamingMode: AgentRuntimeStreamingMode;
  }
): LazyAgentProgressReporter {
  let progressMessage: SlackProgressMessage | undefined;

  return {
    getProgressMessage: () => progressMessage,
    onAgentEvent: async (event) => {
      progressMessage ??= await postMentionWorkingState(client, input);
      if (!progressMessage) {
        return;
      }
      await updateAgentProgressMessage(client, progressMessage, event);
    }
  };
}

export function resolveSlackProgressStreamingMode(input: {
  streamingMode: AgentRuntimeStreamingMode;
  streamThreadTs?: string;
}): AgentRuntimeStreamingMode {
  if (input.streamingMode === "native" && !input.streamThreadTs) {
    return "basic";
  }

  return input.streamingMode;
}

export async function updateAgentProgressMessage(
  client: App["client"],
  progressMessage: SlackProgressMessage,
  event: AgentRunEvent
): Promise<void> {
  if (
    (event.type === "message_delta" || event.type === "message_replace") &&
    progressMessage.streamingMode === "native" &&
    !progressMessage.nativeStreamFallbackReason
  ) {
    const cleanedText = sanitizeRuntimeStreamText(event.text);
    if (isRuntimeControlNotice(cleanedText.trim())) {
      progressMessage.suppressedRuntimeControlNotice = true;
      return;
    }
    progressMessage.streamedText =
      event.type === "message_replace"
        ? cleanedText
        : appendSlackStreamedText(progressMessage.streamedText ?? "", cleanedText);
    if (!progressMessage.streamedText.trim()) {
      return;
    }
    try {
      await updateSlackNativeStream(client, progressMessage, {
        text: cleanedText,
        replace: event.type === "message_replace"
      });
      return;
    } catch (error) {
      progressMessage.streamingMode = "basic";
      progressMessage.nativeStreamFallbackReason = summarizeSlackStreamError(error);
      progressMessage.nativeStreamPendingText = undefined;
      progressMessage.nativeStreamTs = undefined;
      const text = progressMessage.streamedText.trim()
        ? renderProgressLines(progressMessage, [progressMessage.streamedText])
        : undefined;
      if (!text || text === progressMessage.text) {
        return;
      }
      progressMessage.text = text;
      progressMessage.updatedAtMs = Date.now();
      await client.chat.update({
        channel: progressMessage.channel,
        ts: progressMessage.ts,
        text
      });
      return;
    }
  }

  const hadStreamedText = Boolean(progressMessage.streamedText?.trim());
  const text = formatAgentProgressMessage(event, progressMessage);
  if (!text || text === progressMessage.text) {
    return;
  }

  const now = Date.now();
  if (
    shouldThrottleSlackProgressUpdate({
      event,
      hadStreamedText,
      progressMessage,
      now
    })
  ) {
    return;
  }

  progressMessage.text = text;
  progressMessage.updatedAtMs = now;
  await client.chat.update({
    channel: progressMessage.channel,
    ts: progressMessage.ts,
    text
  });
}

export async function failAgentProgressMessage(
  client: App["client"],
  progressMessage: SlackProgressMessage,
  text: string
): Promise<void> {
  if (progressMessage.nativeStreamTs) {
    try {
      await stopSlackNativeStream(client, progressMessage, {
        markdownText: ["", "", text].join("\n")
      });
    } catch {
      progressMessage.streamingMode = "basic";
    }
  }
  progressMessage.text = text;
  await client.chat.update({
    channel: progressMessage.channel,
    ts: progressMessage.ts,
    text
  });
}

async function updateSlackNativeStream(
  client: App["client"],
  progressMessage: SlackProgressMessage,
  input: {
    text: string;
    replace: boolean;
  }
): Promise<void> {
  if (!input.text.trim() || progressMessage.nativeStreamStopped) {
    return;
  }

  const chat = client.chat as App["client"]["chat"] & SlackNativeStreamChatClient;
  if (input.replace && progressMessage.nativeStreamTs) {
    await stopSlackNativeStream(client, progressMessage, {
      markdownText: slackNativeStreamReplacementFallbackText
    });
    throw new Error("slack_native_stream_replace_unsupported");
  }

  if (!progressMessage.nativeStreamTs) {
    if (!progressMessage.threadTs) {
      throw new Error("slack_native_stream_unthreaded");
    }
    if (!chat.startStream) {
      throw new Error("slack_native_stream_unavailable");
    }
    const result = await chat.startStream({
      channel: progressMessage.channel,
      thread_ts: progressMessage.threadTs,
      markdown_text: input.text.trimStart()
    });
    if (!result.ts) {
      throw new Error("slack_native_stream_missing_ts");
    }
    progressMessage.nativeStreamTs = result.ts;
    progressMessage.nativeStreamUpdatedAtMs = Date.now();
    progressMessage.nativeStreamPendingText = "";
    return;
  }

  progressMessage.nativeStreamPendingText = `${
    progressMessage.nativeStreamPendingText ?? ""
  }${input.text}`;
  const now = Date.now();
  if (
    typeof progressMessage.nativeStreamUpdatedAtMs === "number" &&
    now - progressMessage.nativeStreamUpdatedAtMs <
      minSlackNativeStreamAppendIntervalMs
  ) {
    return;
  }

  await flushSlackNativeStreamPendingText(client, progressMessage, now);
}

async function flushSlackNativeStreamPendingText(
  client: App["client"],
  progressMessage: SlackProgressMessage,
  now = Date.now()
): Promise<void> {
  const pendingText = progressMessage.nativeStreamPendingText;
  if (
    !pendingText ||
    !progressMessage.nativeStreamTs ||
    progressMessage.nativeStreamStopped
  ) {
    return;
  }

  const chat = client.chat as App["client"]["chat"] & SlackNativeStreamChatClient;
  if (!chat.appendStream) {
    throw new Error("slack_native_stream_append_unavailable");
  }
  progressMessage.nativeStreamPendingText = "";
  await chat.appendStream({
    channel: progressMessage.channel,
    ts: progressMessage.nativeStreamTs,
    markdown_text: pendingText
  });
  progressMessage.nativeStreamUpdatedAtMs = now;
}

async function stopSlackNativeStream(
  client: App["client"],
  progressMessage: SlackProgressMessage,
  input: {
    markdownText: string;
    blocks?: unknown[];
  }
): Promise<void> {
  if (!progressMessage.nativeStreamTs || progressMessage.nativeStreamStopped) {
    return;
  }

  const chat = client.chat as App["client"]["chat"] & SlackNativeStreamChatClient;
  if (!chat.stopStream) {
    throw new Error("slack_native_stream_stop_unavailable");
  }
  await chat.stopStream({
    channel: progressMessage.channel,
    ts: progressMessage.nativeStreamTs,
    markdown_text: input.markdownText,
    ...(input.blocks ? { blocks: input.blocks } : {})
  });
  progressMessage.nativeStreamStopped = true;
  progressMessage.nativeStreamPendingText = "";
}

function summarizeSlackStreamError(error: unknown): string {
  if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data?: { error?: unknown } }).data;
    if (typeof data?.error === "string") {
      return data.error;
    }
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "unknown_error";
}

function shouldThrottleSlackProgressUpdate(input: {
  event: AgentRunEvent;
  hadStreamedText: boolean;
  progressMessage: SlackProgressMessage;
  now: number;
}): boolean {
  if (
    input.event.type !== "message_delta" &&
    input.event.type !== "message_replace"
  ) {
    return false;
  }
  if (!input.hadStreamedText) {
    return false;
  }
  if (typeof input.progressMessage.updatedAtMs !== "number") {
    return false;
  }

  return (
    input.now - input.progressMessage.updatedAtMs <
    minSlackProgressStreamUpdateIntervalMs
  );
}

export function formatAgentProgressEvent(
  event: AgentRunEvent,
  currentText = ""
): string | undefined {
  switch (event.type) {
    case "status":
      return normalizeAgentStatus(event.text);
    case "tool_call":
      return replaceOrAppendProgressLine(
        currentText,
        "",
        `Calling ${formatAgentToolName(event.toolName)}...`
      );
    case "tool_result":
      return replaceOrAppendProgressLine(
        currentText,
        "",
        `${formatAgentToolName(event.toolName)} completed (${formatToolClassification(event.classification)} result).`
      );
    case "message_delta": {
      return appendSlackStreamedText(
        isAgentProgressPlaceholder(currentText) ? "" : currentText,
        event.text
      ) || undefined;
    }
    case "message_replace":
      return sanitizeRuntimeStreamText(event.text).trim() || undefined;
    case "final":
    case "error":
      return undefined;
  }
}

export function formatConversationFailureMessage(
  error: unknown,
  target: "mention" | "message"
): string {
  const message = error instanceof Error ? error.message : String(error);
  if (isRuntimeMcpAuthFailure(message)) {
    return [
      "Agent runtime auth failed before I could call tools.",
      "The runtime JWT expired or was rejected; this is not an expired GitHub/Jira token.",
      "Restart the runtime container or check `AGENT_RUNTIME_JWT_TTL_SECONDS` / MCP gateway routing."
    ].join(" ");
  }
  if (isRuntimeFinalizationFailure(message)) {
    return [
      "Agent runtime started but did not return a final answer.",
      "The runtime may still be stuck after tool or model calls.",
      `Runtime detail: ${sanitizeRuntimeFailureDetail(message)}`
    ].join(" ");
  }
  if (isRuntimeRunFailure(message)) {
    return [
      "Agent runtime failed while handling that message.",
      `Runtime detail: ${sanitizeRuntimeFailureDetail(message)}`
    ].join(" ");
  }
  if (
    error instanceof RuntimeEngineSelectionError &&
    message.includes("missing attachment support")
  ) {
    return [
      "I could not use the attached file with the currently allowed runtimes.",
      "No selectable runtime advertises attachment support for this workspace.",
      "Enable an attachment-capable runtime, such as `openclaw`, or switch your runtime policy before retrying."
    ].join(" ");
  }

  return `I could not handle that ${target}.`;
}

function isRuntimeFinalizationFailure(message: string): boolean {
  return /Managed runtime did not produce a final response|Runtime run finished without a final response|Runtime event socket closed before final/i.test(
    message
  );
}

function isRuntimeRunFailure(message: string): boolean {
  return /Managed runtime returned HTTP \d+|Managed runtime final response leaked tool-call protocol text|Runtime run failed:|Hermes returned a provider tool progress marker/i.test(
    message
  );
}

function sanitizeRuntimeFailureDetail(message: string): string {
  return message.replace(/\s+/g, " ").slice(0, 240);
}

function formatAgentExecResult(statusText: string, responseText: string): string {
  return [statusText, "", responseText].join("\n");
}

function formatAgentExecFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (isRuntimeMcpAuthFailure(message)) {
    return formatConversationFailureMessage(error, "message");
  }

  const detail = sanitizeAgentExecFailureDetail(message);
  return detail
    ? `I could not run that agent task: ${detail}`
    : "I could not run that agent task.";
}

function sanitizeAgentExecFailureDetail(message: string): string {
  const normalized = message
    .replace(/\s+/g, " ")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted-openai-key]")
    .trim();

  if (!normalized) {
    return "";
  }

  return truncateSlackConfigValue(normalized, 240);
}

function isRuntimeMcpAuthFailure(message: string): boolean {
  return (
    /Burble MCP .*HTTP 401/i.test(message) ||
    /JWT token required/i.test(message) ||
    /runtime JWT/i.test(message) ||
    /OpenClaw\/NemoClaw runtime returned HTTP 401/i.test(message)
  );
}

export function formatAgentProgressMessage(
  event: AgentRunEvent,
  progressMessage: SlackProgressMessage
): string | undefined {
  if (event.type === "tool_call") {
    progressMessage.toolStartedAtMs[event.callId] = Date.now();
    progressMessage.toolLinesByCallId[event.callId] =
      `Calling ${formatAgentToolName(event.toolName)}...`;
    if (!progressMessage.toolCallOrder.includes(event.callId)) {
      progressMessage.toolCallOrder.push(event.callId);
    }
    return renderProgressLines(progressMessage);
  }

  if (event.type === "tool_result") {
    const startedAt = progressMessage.toolStartedAtMs[event.callId];
    const elapsed =
      typeof startedAt === "number" ? ` in ${formatElapsedMs(Date.now() - startedAt)}` : "";
    delete progressMessage.toolStartedAtMs[event.callId];
    progressMessage.toolLinesByCallId[event.callId] =
      `${formatAgentToolName(event.toolName)} completed${elapsed} (${formatToolClassification(event.classification)} result).`;
    if (!progressMessage.toolCallOrder.includes(event.callId)) {
      progressMessage.toolCallOrder.push(event.callId);
    }
    return renderProgressLines(progressMessage);
  }

  if (event.type === "status") {
    if (progressMessage.streamedText?.trim()) {
      return renderProgressLines(progressMessage, [progressMessage.streamedText]);
    }
    return renderProgressLines(progressMessage, [
      normalizeAgentStatus(event.text)
    ]);
  }

  if (event.type === "message_delta" || event.type === "message_replace") {
    const cleanedText = sanitizeRuntimeStreamText(event.text);
    if (isRuntimeControlNotice(cleanedText.trim())) {
      progressMessage.suppressedRuntimeControlNotice = true;
      return undefined;
    }
    progressMessage.streamedText =
      event.type === "message_replace"
        ? cleanedText
        : appendSlackStreamedText(progressMessage.streamedText ?? "", cleanedText);
    return progressMessage.streamedText.trim()
      ? renderProgressLines(progressMessage, [progressMessage.streamedText])
      : undefined;
  }

  return undefined;
}

function appendSlackStreamedText(currentText: string, delta: string): string {
  const cleanedDelta = sanitizeRuntimeStreamText(delta);
  if (!cleanedDelta.trim() || isRuntimeControlNotice(cleanedDelta.trim())) {
    return currentText;
  }

  return currentText ? `${currentText}${cleanedDelta}` : cleanedDelta.trimStart();
}

const hermesRuntimeStreamCursorPattern =
  /(?:[ \t]*\[\[BURBLE_STREAM_CURSOR\]\]|[ \t]*[\u2063▉■])/g;

function sanitizeRuntimeStreamText(text: string): string {
  hermesRuntimeStreamCursorPattern.lastIndex = 0;
  const hasHermesCursor = hermesRuntimeStreamCursorPattern.test(text);
  let sanitized = stripRuntimeToolCallProtocolFragments(text);
  sanitized = stripRuntimeProviderProgressMarkers(sanitized);
  if (hasHermesCursor) {
    hermesRuntimeStreamCursorPattern.lastIndex = 0;
    sanitized = sanitized
      .replace(hermesRuntimeStreamCursorPattern, "")
      .replace(/([^\n])\n+([,.;:!?])/g, "$1$2")
      .replace(/(\d+\.)[ \t]*\n+(?=\S)/g, "$1 ");
  }

  return normalizeSlackMrkdwnLinks(sanitized);
}

function stripRuntimeProviderProgressMarkers(text: string): string {
  const lines = text.split(/\r?\n/);
  let removed = false;
  const kept = lines.filter((line) => {
    const marker = isRuntimeProviderProgressMarker(line);
    removed ||= marker;
    return !marker;
  });
  return removed ? kept.join("\n").trim() : text;
}

function isRuntimeProviderProgressMarker(text: string): boolean {
  const normalized = text.trim().replace(/\s+/g, " ");
  return /^(?::gear:|⚙️?|gear:)?\s*(?:burble_provider_call|(?:github|google|gmail|hubspot|jira|slack|atlassian|scheduled_job|conversation)_[a-z0-9_]+)(?:\.{3}|…)?$/i.test(normalized);
}

function normalizeSlackMrkdwnLinks(text: string): string {
  return text.replace(
    /<((?:https?:\/\/)[^>|]*)(\|[^>]*)?>/gi,
    (_match, url: string, label: string | undefined) =>
      `<${url.replace(/\s+/g, "")}${label ?? ""}>`
  );
}

function isAgentProgressPlaceholder(text: string): boolean {
  const trimmed = text.trim();
  return (
    !trimmed ||
    trimmed === "Starting agent runtime..." ||
    trimmed === "Agent is responding..." ||
    trimmed === "Agent is thinking..." ||
    /^Agent has thought for \d+s\.{0,3}$/.test(trimmed)
  );
}

function normalizeAgentStatus(text: string): string {
  const trimmed = text.trim();
  if (isRuntimeControlNotice(trimmed)) {
    return "Agent is thinking...";
  }
  const thoughtMatch = /(?:still running|agent has thought for)\s+(?:agent|openclaw)?\.{0,3}\s*(\d+)s/i.exec(
    trimmed
  );
  if (thoughtMatch) {
    return `Agent has thought for ${thoughtMatch[1]}s...`;
  }

  if (/running\s+(openclaw\/nemoclaw|agent)/i.test(trimmed)) {
    return "Agent is thinking...";
  }

  return trimmed
    .replace(/OpenClaw\/NemoClaw/gi, "agent")
    .replace(/OpenClaw/gi, "agent")
    .replace(/\bagent agent\b/gi, "agent");
}

function renderProgressLines(
  progressMessage: SlackProgressMessage,
  fallbackLines: string[] = []
): string {
  const toolLines = progressMessage.toolCallOrder
    .map((callId) => progressMessage.toolLinesByCallId[callId])
    .filter((line): line is string => Boolean(line?.trim()));
  const lines =
    toolLines.length > 0 ? [...toolLines, ...fallbackLines] : fallbackLines;
  const rendered = lines
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n");
  return rendered || progressMessage.text;
}

function renderFinalProgressMessage(
  progressMessage: SlackProgressMessage,
  responseText: string,
  finalProgressLine: string
): string {
  const toolLines = progressMessage.toolCallOrder
    .map((callId) => progressMessage.toolLinesByCallId[callId])
    .filter((line): line is string => Boolean(line?.trim()));
  return [
    ...(toolLines.length ? [toolLines.map((line) => line.trim()).join("\n")] : []),
    responseText.trim(),
    finalProgressLine.trim()
  ]
    .filter(Boolean)
    .join("\n\n");
}

function replaceOrAppendProgressLine(
  currentText: string,
  previousLine: string,
  nextLine: string
): string {
  const trimmedNext = nextLine.trim();
  if (!trimmedNext) {
    return currentText;
  }

  const lines = currentText
    .split(/\r?\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  const previousIndex = previousLine
    ? lines.findIndex((line) => line === previousLine.trim())
    : -1;
  if (previousIndex >= 0) {
    lines[previousIndex] = trimmedNext;
    return lines.join("\n");
  }
  return [...lines, trimmedNext].join("\n");
}

function formatElapsedMs(ms: number): string {
  if (ms < 1_000) {
    return `${Math.max(0, ms)}ms`;
  }

  return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

function formatToolClassification(classification: ToolClassification): string {
  return String(classification).replace(/_/g, "-");
}

export function formatFinalProgressLine(elapsedMs: number, usage?: AgentUsage): string {
  const usageText = formatUsageSummary(usage);
  return `Final result in ${formatElapsedMs(elapsedMs)}${usageText ? ` (${usageText})` : ""}.`;
}

function formatSlackFinalProgressLine(
  elapsedMs: number,
  usage?: AgentUsage
): string {
  return `_${formatFinalProgressLine(elapsedMs, usage)}_`;
}

function formatUsageSummary(usage?: AgentUsage): string | null {
  if (!usage) {
    return null;
  }

  const totalTokens =
    usage.totalTokens ??
    (typeof usage.inputTokens === "number" && typeof usage.outputTokens === "number"
      ? usage.inputTokens + usage.outputTokens
      : undefined);
  if (typeof totalTokens !== "number") {
    return null;
  }

  const parts: string[] = [];
  if (typeof usage.cachedInputTokens === "number" && usage.cachedInputTokens > 0) {
    const freshTokens = Math.max(0, totalTokens - usage.cachedInputTokens);
    parts.push(
      `${totalTokens} tokens: ${freshTokens} fresh`,
      `${usage.cachedInputTokens} cached`
    );
  } else {
    parts.push(`${totalTokens} tokens`);
  }
  if (typeof usage.reasoningTokens === "number" && usage.reasoningTokens > 0) {
    parts.push(`${usage.reasoningTokens} reasoning`);
  }
  if (usage.usageSource === "estimate-only") {
    parts.push("estimated");
  }
  return parts.join(", ");
}

function formatAgentToolName(toolName: string): string {
  const labels: Record<string, string> = {
    "github.getAuthenticatedUser": "GitHub identity",
    "github.listAssignedIssues": "GitHub assigned issues",
    "github.searchIssues": "GitHub search",
    "github.listMyPullRequests": "GitHub pull requests",
    "jira.getAuthenticatedUser": "Jira identity",
    "hubspot.getAuthenticatedUser": "HubSpot identity",
    "hubspot.searchContacts": "HubSpot contact search",
    "hubspot.searchCompanies": "HubSpot company search",
    "hubspot.searchDeals": "HubSpot deal search",
    "hubspot.searchCrmObjects": "HubSpot CRM object search",
    "hubspot.listOwners": "HubSpot owner list",
    "hubspot.listUsers": "HubSpot user list",
    "hubspot.readApiResource": "HubSpot API read",
    "jira.searchUsers": "Jira user search",
    "jira.createIssue": "Jira issue create",
    "jira.editIssue": "Jira issue edit",
    "jira.listAssignedIssues": "Jira assigned issues",
    "jira.searchIssues": "Jira search",
    "atlassian.listMcpTools": "Atlassian MCP tools",
    "atlassian.callMcpTool": "Atlassian MCP tool"
  };
  const known = labels[toolName];
  if (known) {
    return known;
  }

  return titleCaseProviderToolName(toolName);
}

function titleCaseProviderToolName(toolName: string): string {
  return toolName
    .replace(/[._]/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\bmcp\b/gi, "MCP")
    .replace(/\bapi\b/gi, "API")
    .replace(/\bgithub\b/gi, "GitHub")
    .replace(/\bhubspot\b/gi, "HubSpot")
    .replace(/\bjira\b/gi, "Jira")
    .replace(/\batlassian\b/gi, "Atlassian")
    .replace(/\s+/g, " ")
    .trim();
}

function tryBuildJiraOAuthUrl(config: Config, state: string): string | null {
  try {
    return buildJiraOAuthUrl(config, state);
  } catch (error) {
    if (error instanceof Error && error.message === "Jira OAuth is not configured") {
      return null;
    }

    throw error;
  }
}

function tryBuildGoogleOAuthUrl(config: Config, state: string): string | null {
  try {
    return buildGoogleOAuthUrl(config, state);
  } catch (error) {
    if (error instanceof Error && error.message === "Google OAuth is not configured") {
      return null;
    }

    throw error;
  }
}

function tryBuildHubSpotOAuthUrl(config: Config, state: string): string | null {
  try {
    return buildHubSpotOAuthUrl(config, state);
  } catch (error) {
    if (error instanceof Error && error.message === "HubSpot OAuth is not configured") {
      return null;
    }

    throw error;
  }
}

function tryBuildSlackOAuthUrl(config: Config, state: string): string | null {
  try {
    return buildSlackOAuthUrl(config, state);
  } catch (error) {
    if (error instanceof Error && error.message === "Slack OAuth is not configured") {
      return null;
    }

    throw error;
  }
}
