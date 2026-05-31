import { App, LogLevel } from "@slack/bolt";
import type { View } from "@slack/types";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Config } from "./config";
import type { SlackLogLevel } from "./config";
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
  createGoogleDriveTextFile,
  getGoogleUser,
  refreshGoogleAccessToken,
  searchGoogleCalendarEvents,
  searchGoogleDriveFiles,
  searchGoogleMailMessages
} from "./providers/google/client";
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
import type {
  AgentRuntimeRecord,
  AgentRuntimeStatus,
  ProviderConnection,
  TokenStore
} from "./db";
import { handleConversation } from "./conversation/orchestrator";
import { normalizeMentionText } from "./conversation/normalize";
import type {
  ConversationAttachment,
  ConversationRequest,
  ConversationResponse,
  ToolClassification
} from "./conversation/types";
import { createConfiguredAgentRunner } from "./agent/runtime";
import {
  collectAgentRun,
  type AgentRunEvent,
  type AgentUsage
} from "./agent/types";
import { validateAgentModelId } from "./agent/providers";
import { createDockerRuntimeFactory } from "./agent/container-runtime-factory";
import { buildRuntimeManifestForPrincipal } from "./agent/runtime-policy";
import { createStaticRuntimeFactory } from "./agent/runtime-factory";
import type { RuntimeFactory } from "./agent/runtime-factory";
import { createGitHubTools } from "./tools/github";
import { createGoogleTools } from "./tools/google";
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
};

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
  startedAtMs: number;
  toolStartedAtMs: Record<string, number>;
  toolLinesByCallId: Record<string, string>;
  toolCallOrder: string[];
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
  observability: ObservabilitySink = createNoopObservabilitySink()
): SlackRuntime {
  const app = new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    socketMode: true,
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
    createGoogleDriveTextFile,
    searchGoogleCalendarEvents,
    searchGoogleMailMessages,
    refreshGoogleAccessToken: (refreshToken) =>
      refreshGoogleAccessToken(config, refreshToken),
    saveGoogleConnection: (connection) => store.upsertProviderConnection(connection)
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
  const runtimeFactory = createOpenClawRuntimeFactory(
    config,
    store,
    runtimeJwtIssuer
  );
  const agentRunner =
    config.agentMode === "llm"
      ? createConfiguredAgentRunner({
          runtime: config.agentRuntime,
          model: config.aiModel,
          githubTools,
          googleTools,
          slackTools,
          jiraTools,
          openClawNemoClawUrl: config.openClawNemoClawUrl,
          ...(runtimeFactory ? { runtimeFactory } : {}),
          observability,
          logInfo: (message) => app.logger.info(withUtcTimestamp(message))
        })
      : undefined;
  const agentExecTasks = new Map<string, AgentExecTask>();

  const resolveAgentExecutionMode = (): "openclaw-native" | undefined =>
    config.agentRuntime === "burble-runtime" ? "openclaw-native" : undefined;

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
    return buildAppHomeView({
      githubUrl: buildGitHubOAuthUrl(
        config,
        store.createOAuthState(input.slackUserId)
      ),
      googleUrl: tryBuildGoogleOAuthUrl(
        config,
        store.createOAuthState(input.slackUserId)
      ),
      jiraUrl: tryBuildJiraOAuthUrl(
        config,
        store.createOAuthState(input.slackUserId)
      ),
      slackUrl: tryBuildSlackOAuthUrl(
        config,
        store.createOAuthState(input.slackUserId)
      ),
      connections: {
        github: store.getConnectionForSlackUser("github", input.slackUserId),
        google: store.getConnectionForSlackUser("google", input.slackUserId),
        jira: store.getConnectionForSlackUser("jira", input.slackUserId),
        slack: store.getConnectionForSlackUser("slack", input.slackUserId)
      },
      agentSettings
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
      await applyAgentRuntimeControl({
        config,
        store,
        runtimeFactory,
        workspaceId: context.workspaceId,
        slackUserId: context.slackUserId,
        action
      });
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

    const parsed = parseAgentConfigModalSubmission(body);
    if (!parsed.ok) {
      await ack({
        response_action: "errors",
        errors: parsed.errors
      });
      return;
    }

    const principal = {
      workspaceId: context.workspaceId,
      slackUserId: context.slackUserId
    };
    const previousPolicyHash = buildRuntimeManifestForPrincipal({
      config,
      store,
      principal,
      engine: config.agentRuntimeEngine
    }).policyHash;
    applyAgentConfigModalValues({
      store,
      principal,
      values: parsed.values
    });
    const nextPolicyHash = buildRuntimeManifestForPrincipal({
      config,
      store,
      principal,
      engine: config.agentRuntimeEngine
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
        nextPolicyHash
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
    try {
      if (config.agentMode === "llm") {
        progressMessage = await postMentionWorkingState(client, {
          channel: mention.channel,
          user: mention.user,
          isDirectMessage:
            mention.channel_type === "im" || mention.channel.startsWith("D"),
          threadTs: buildReplyThreadTs({
            isDirectMessage:
              mention.channel_type === "im" || mention.channel.startsWith("D"),
            messageTs: mention.ts,
            threadTs: mention.thread_ts
          })
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

      const activeProgressMessage = progressMessage;
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
          ...(config.googleClientId && config.googleClientSecret
            ? {
                createGoogleOAuthUrl: (slackUserId: string) =>
                  buildGoogleOAuthUrl(config, store.createOAuthState(slackUserId))
              }
            : {}),
          ...(config.jiraClientId && config.jiraClientSecret
            ? {
                createJiraOAuthUrl: (slackUserId: string) =>
                  buildJiraOAuthUrl(config, store.createOAuthState(slackUserId))
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
            jira: jiraTools,
            slack: slackTools
          },
          agentMode: config.agentMode,
          agentFastTrack: config.agentFastTrack,
          observability,
          ...(resolveAgentExecutionMode()
            ? { agentExecutionMode: resolveAgentExecutionMode() }
            : {}),
          ...(agentRunner ? { agentRunner } : {}),
          ...(activeProgressMessage
            ? {
                onAgentEvent: (event) => {
                  return updateAgentProgressMessage(
                    client,
                    activeProgressMessage,
                    event
                  ).catch((error) => {
                    logger.warn(formatLogError(error));
                  });
                }
              }
            : {})
        }
      );

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
        await client.chat.update({
          channel: progressMessage.channel,
          ts: progressMessage.ts,
          text
        });
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
    try {
      if (config.agentMode === "llm") {
        progressMessage = await postMentionWorkingState(client, {
          channel: directMessage.channel,
          user: directMessage.user,
          isDirectMessage: true,
          threadTs: buildReplyThreadTs({
            isDirectMessage: true,
            messageTs: directMessage.ts,
            threadTs: directMessage.thread_ts
          })
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

      const activeProgressMessage = progressMessage;
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
          ...(config.googleClientId && config.googleClientSecret
            ? {
                createGoogleOAuthUrl: (slackUserId: string) =>
                  buildGoogleOAuthUrl(config, store.createOAuthState(slackUserId))
              }
            : {}),
          ...(config.jiraClientId && config.jiraClientSecret
            ? {
                createJiraOAuthUrl: (slackUserId: string) =>
                  buildJiraOAuthUrl(config, store.createOAuthState(slackUserId))
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
            jira: jiraTools,
            slack: slackTools
          },
          agentMode: config.agentMode,
          agentFastTrack: config.agentFastTrack,
          observability,
          ...(resolveAgentExecutionMode()
            ? { agentExecutionMode: resolveAgentExecutionMode() }
            : {}),
          ...(agentRunner ? { agentRunner } : {}),
          ...(activeProgressMessage
            ? {
                onAgentEvent: (event) => {
                  return updateAgentProgressMessage(
                    client,
                    activeProgressMessage,
                    event
                  ).catch((error) => {
                    logger.warn(formatLogError(error));
                  });
                }
              }
            : {})
        }
      );

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
        await client.chat.update({
          channel: progressMessage.channel,
          ts: progressMessage.ts,
          text
        });
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
          text: `Unknown auth target \`${action.value}\`. Try \`/auth\`, \`/auth github\`, \`/auth google\`, \`/auth jira\`, or \`/auth slack\`.`
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
      const googleUrl = tryBuildGoogleOAuthUrl(
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
                    text: "Google OAuth is not configured."
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
                  jiraUrl,
                  slackUrl,
                  connections: {
                    github: store.getConnectionForSlackUser(
                      "github",
                      body.user_id
                    ),
                    google: store.getConnectionForSlackUser(
                      "google",
                      body.user_id
                    ),
                    jira: store.getConnectionForSlackUser("jira", body.user_id),
                    slack: store.getConnectionForSlackUser(
                      "slack",
                      body.user_id
                    )
                  }
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
        const previousPolicyHash = buildRuntimeManifestForPrincipal({
          config,
          store,
          principal,
          engine: config.agentRuntimeEngine
        }).policyHash;
        const response = applyAgentUserConfigSet({
          config,
          store,
          workspaceId: principal.workspaceId,
          slackUserId: principal.slackUserId,
          key: action.key,
          value: action.value
        });
        const nextPolicyHash = buildRuntimeManifestForPrincipal({
          config,
          store,
          principal,
          engine: config.agentRuntimeEngine
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
            nextPolicyHash
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
              executionMode: "openclaw-native",
              conversation: {
                routeId: conversationRoute.id,
                source: "slack",
                workspaceId: principal.workspaceId,
                channelId: body.channel_id,
                rootId: `slash-agent-exec:${execTask.id}`,
                isDirectMessage: body.channel_id.startsWith("D")
              },
              text: action.task,
              connections: {
                github: store.getConnection("github", email),
                google: store.getConnection("google", email),
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
          const finalStatusText = formatFinalProgressLine(
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
    getSlackEmail
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

  return input.store.getAgentRuntimeForPrincipal({
    ...principal,
    engine: input.config.agentRuntimeEngine
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

function createOpenClawRuntimeFactory(
  config: Config,
  store: TokenStore,
  runtimeJwtIssuer?: RuntimeJwtIssuer
): RuntimeFactory | undefined {
  if (config.agentRuntime !== "burble-runtime") {
    return undefined;
  }

  if (config.agentRuntimeFactory === "docker") {
    if (!config.agentRuntimeTokenSecret) {
      throw new Error(
        "AGENT_RUNTIME_TOKEN_SECRET or INTERNAL_API_TOKEN is required for docker runtime factory"
      );
    }

    return createDockerRuntimeFactory({
      store,
      engine: config.agentRuntimeEngine,
      image: config.agentRuntimeImage,
      dataRoot: config.agentRuntimeDataRoot,
      dockerNetwork: config.agentRuntimeDockerNetwork,
      toolGatewayUrl: config.agentRuntimeToolGatewayUrl,
      mcpGatewayUrl: config.agentRuntimeMcpGatewayUrl,
      mcpAudience: config.agentRuntimeMcpAudience,
      runtimeJwtIssuer,
      runtimeJwtTtlSeconds: config.agentRuntimeJwtTtlSeconds,
      runtimeTokenSecret: config.agentRuntimeTokenSecret,
      openClawConfigPatchPath: config.openClawConfigPatchHostPath,
      idleTtlMs: config.agentRuntimeIdleTtlMs,
      env: Bun.env,
      buildManifest: (principal) =>
        buildRuntimeManifestForPrincipal({
          config,
          store,
          principal,
          engine: config.agentRuntimeEngine
        })
    });
  }

  if (!config.openClawNemoClawUrl) {
    return undefined;
  }

  return createStaticRuntimeFactory({
    store,
    engine: config.agentRuntimeEngine,
    endpointUrl: config.openClawNemoClawUrl,
    authToken: config.internalApiToken ?? "",
    dataRoot: config.agentRuntimeDataRoot,
    buildManifest: (principal) =>
      buildRuntimeManifestForPrincipal({
        config,
        store,
        principal,
        engine: config.agentRuntimeEngine
      })
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

type ProviderConnectionViewInput = {
  githubUrl: string;
  googleUrl: string | null;
  jiraUrl: string | null;
  slackUrl: string | null;
  connections?: {
    github: ProviderConnection | null;
    google: ProviderConnection | null;
    jira: ProviderConnection | null;
    slack: ProviderConnection | null;
  };
  agentSettings?: AgentHomeSettingsView;
};

type SlackViewsPublishClient = {
  views: {
    publish(input: { user_id: string; view: View }): Promise<unknown>;
  };
};

type AgentHomeSettingsView = {
  model: string;
  userMemory: "on" | "off";
  disabledTools: string[];
  enabledSkills: string[];
  policyHash: string;
  runtime: {
    id: string | null;
    status: string;
    factory: string;
    engine: string;
    endpointUrl: string | null;
    createdAt: string | null;
    lastUsedAt: string | null;
  };
};

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
          text: "Connect provider accounts so Burble and your agent runtime can use them on your behalf."
        }
      },
      ...buildAgentRuntimeHomeBlocks(input.agentSettings),
      {
        type: "divider"
      },
      ...buildProviderConnectionBlocks(input),
      {
        type: "divider"
      },
      ...buildAgentSettingsHomeBlocks(input.agentSettings),
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "You can also manage connections with `/auth` and agent settings with `/agent config`."
          }
        ]
      }
    ]
  };
}

export function buildAuthResponse(input: ProviderConnectionViewInput) {
  return {
    response_type: "ephemeral" as const,
    text: "Burble connections: GitHub, Google Workspace, Jira, and Slack search.",
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
            text: "Shortcuts: `/auth`, `/auth github`, `/auth google`, `/auth jira`, `/auth slack`, `/help`"
          }
        ]
      }
    ]
  } as const;
}

function buildProviderConnectionBlocks(input: ProviderConnectionViewInput) {
  return [
    buildProviderConnectionBlock({
      title: "GitHub",
      status: formatConnectionStatus(input.connections?.github, "github"),
      configured: true,
      url: input.githubUrl,
      connected: Boolean(input.connections?.github),
      actionId: "connect_github",
      usage: "Issues, pull requests, repository metadata and approved write actions"
    }),
    buildProviderConnectionBlock({
      title: "Google Workspace",
      status: input.googleUrl
        ? formatConnectionStatus(input.connections?.google, "google")
        : "Google OAuth is not configured.",
      configured: Boolean(input.googleUrl),
      url: input.googleUrl,
      connected: Boolean(input.connections?.google),
      actionId: "connect_google",
      usage: "Drive files, Calendar events, Gmail search and drafts"
    }),
    buildProviderConnectionBlock({
      title: "Atlassian Jira",
      status: input.jiraUrl
        ? formatConnectionStatus(input.connections?.jira, "jira")
        : "Jira OAuth is not configured.",
      configured: Boolean(input.jiraUrl),
      url: input.jiraUrl,
      connected: Boolean(input.connections?.jira),
      actionId: "connect_jira",
      usage: "Jira issues, projects, users, comments and approved workflow actions"
    }),
    buildProviderConnectionBlock({
      title: "Slack search",
      status: input.slackUrl
        ? formatConnectionStatus(input.connections?.slack, "slack")
        : "Slack OAuth is not configured.",
      configured: Boolean(input.slackUrl),
      url: input.slackUrl,
      connected: Boolean(input.connections?.slack),
      actionId: "connect_slack",
      usage: "User search and message search through your Slack identity"
    })
  ];
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
  const manifest = buildRuntimeManifestForPrincipal({
    config: input.config,
    store: input.store,
    principal,
    engine: input.config.agentRuntimeEngine
  });
  const runtime = input.store.getAgentRuntimeForPrincipal({
    workspaceId: input.workspaceId,
    slackUserId: input.slackUserId,
    engine: input.config.agentRuntimeEngine
  });

  return {
    model: `${manifest.model.provider}:${manifest.model.model}`,
    userMemory: manifest.memory.userMemoryEnabled ? "on" : "off",
    disabledTools: manifest.disabledTools,
    enabledSkills: manifest.skills.map((skill) => `${skill.id}@${skill.version}`),
    policyHash: manifest.policyHash,
    runtime: runtime
      ? {
          id: runtime.id,
          status: runtime.status,
          factory: input.config.agentRuntimeFactory,
          engine: runtime.engine,
          endpointUrl: runtime.endpointUrl,
          createdAt: runtime.createdAt,
          lastUsedAt: runtime.lastUsedAt
        }
      : {
          id: null,
          status: "not provisioned",
          factory: input.config.agentRuntimeFactory,
          engine: input.config.agentRuntimeEngine,
          endpointUrl: null,
          createdAt: null,
          lastUsedAt: null
      }
  };
}

async function buildSyncedAgentHomeSettings(input: {
  config: Config;
  store: TokenStore;
  runtimeFactory?: RuntimeFactory;
  workspaceId: string;
  slackUserId: string;
}): Promise<AgentHomeSettingsView> {
  const runtime = input.store.getAgentRuntimeForPrincipal({
    workspaceId: input.workspaceId,
    slackUserId: input.slackUserId,
    engine: input.config.agentRuntimeEngine
  });
  if (runtime && input.runtimeFactory?.syncRuntimeStatus) {
    await input.runtimeFactory.syncRuntimeStatus(runtime.id);
  }

  return buildAgentHomeSettings(input);
}

function buildAgentRuntimeHomeBlocks(settings?: AgentHomeSettingsView) {
  if (!settings) {
    return [];
  }

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: ["*Agent runtime*", formatRuntimeHomeSummary(settings)].join("\n")
      },
    },
    {
      type: "actions",
      elements: buildAgentRuntimeActionElements(settings)
    }
  ];
}

function buildAgentRuntimeActionElements(settings: AgentHomeSettingsView) {
  const elements = [];
  if (settings.runtime.factory !== "docker") {
    // Static runtimes are shared externally managed services, so Burble cannot
    // safely expose per-user container lifecycle actions for them.
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
            text: "This stops the current runtime container and may interrupt active autonomous work."
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
  return elements;
}

function isRuntimeStartable(status: string): boolean {
  return status === "not provisioned" || status === "stopped" || status === "failed";
}

function formatRuntimeHomeSummary(settings: AgentHomeSettingsView): string {
  const runtimeId = settings.runtime.id
    ? `\`${settings.runtime.id}\``
    : "`not provisioned yet`";
  const lastUsed = settings.runtime.lastUsedAt ?? "never";
  return [
    `Status: \`${settings.runtime.status}\``,
    `Factory: \`${settings.runtime.factory}\``,
    `Engine: \`${settings.runtime.engine}\``,
    `Runtime: ${runtimeId}`,
    `Last used: ${lastUsed}`
  ].join("\n");
}

function buildAgentSettingsHomeBlocks(settings?: AgentHomeSettingsView) {
  if (!settings) {
    return [];
  }

  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "Agent settings"
      }
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
    `*Engine:* \`${settings.runtime.engine}\``,
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
  const existing = input.store.getAgentRuntimeForPrincipal({
    workspaceId: input.workspaceId,
    slackUserId: input.slackUserId,
    engine: input.config.agentRuntimeEngine
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
  title: string;
  status: string;
  configured: boolean;
  url: string | null;
  connected: boolean;
  actionId: string;
  usage: string;
}) {
  return {
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
    ],
    ...(input.configured && input.url
      ? {
          accessory: {
            type: "button",
            text: {
              type: "plain_text",
              text: input.connected ? "Reconnect" : "Connect"
            },
            url: input.url,
            action_id: input.actionId
          }
        }
      : {})
  };
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
            "• `/auth jira` - connect or reconnect Jira",
            "• `/auth slack` - connect or reconnect Slack search",
            "• `/agent status` - show and power up your current agent runtime",
            "• `/agent config` - inspect your current agent config file",
            "• `/agent exec <task>` - send an explicit task to your private agent runtime",
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
  | "runtime.model"
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

type AgentConfigModalValues = {
  model: string;
  memory: "on" | "off";
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
        block_id: "agent_config_memory",
        label: {
          type: "plain_text",
          text: "User memory"
        },
        element: {
          type: "static_select",
          action_id: "value",
          initial_option: agentConfigMemoryOption(settings.userMemory),
          options: [
            agentConfigMemoryOption("on"),
            agentConfigMemoryOption("off")
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

function agentConfigMemoryOption(value: "on" | "off") {
  return {
    text: {
      type: "plain_text",
      text: value === "on" ? "On" : "Off"
    },
    value
  } as const;
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
  body: unknown
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

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }
  const memoryValue = memory === "on" ? "on" : "off";

  return {
    ok: true,
    values: {
      model: modelId,
      memory: memoryValue,
      disabledTools: parseStringListConfigValue(disabledTools),
      enabledSkills: parseStringListConfigValue(enabledSkills)
    }
  };
}

function applyAgentConfigModalValues(input: {
  store: TokenStore;
  principal: { workspaceId: string; slackUserId: string };
  values: AgentConfigModalValues;
}): void {
  input.store.upsertUserPreference({
    workspaceId: input.principal.workspaceId,
    slackUserId: input.principal.slackUserId,
    key: "runtime.model",
    value: input.values.model
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
  const manifest = buildRuntimeManifestForPrincipal({
    config: input.config,
    store: input.store,
    principal,
    engine: input.config.agentRuntimeEngine
  });
  const key = input.key ? normalizeAgentUserConfigKey(input.key) : null;

  if (input.key && !key) {
    return {
      response_type: "ephemeral",
      text: formatUnknownAgentUserConfigKey(input.key)
    };
  }

  const lines = key
    ? formatAgentUserConfigKeyLines({ store: input.store, principal, manifest, key })
    : [
        "*Agent user config*",
        `• Model: \`${manifest.model.provider}:${manifest.model.model}\``,
        `• User memory: \`${manifest.memory.userMemoryEnabled ? "on" : "off"}\``,
        `• Disabled tools: \`${formatStringList(manifest.disabledTools)}\``,
        `• Enabled skills: \`${formatStringList(manifest.skills.map((skill) => `${skill.id}@${skill.version}`))}\``,
        `• Policy hash: \`${manifest.policyHash}\``,
        "",
        "*Settable keys*",
        "• `model`",
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

  input.store.upsertUserPreference({
    workspaceId: input.workspaceId,
    slackUserId: input.slackUserId,
    key,
    value: parsed.value
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
          engine: input.config.agentRuntimeEngine
        }),
        key
      })
    ].join("\n")
  };
}

export async function restartAgentRuntimeIfConfigChanged(input: {
  config: Config;
  store: TokenStore;
  runtimeFactory?: RuntimeFactory;
  principal: { workspaceId: string; slackUserId: string };
  previousPolicyHash: string;
  nextPolicyHash: string;
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
    engine: input.config.agentRuntimeEngine
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

  const manifest = buildRuntimeManifestForPrincipal({
    config: input.config,
    store: input.store,
    principal: input.principal,
    engine: input.config.agentRuntimeEngine
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
    case "model":
    case "runtime.model":
      return "runtime.model";
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
    case "runtime.model":
      return "model";
    case "memory.user":
      return "memory";
    default:
      return key;
  }
}

function formatUnknownAgentUserConfigKey(key: string): string {
  return [
    `Unknown user config key: \`${truncateSlackConfigValue(key, 80)}\`.`,
    "Allowed keys: `model`, `memory`, `tools.disabled`, `skills.enabled`.",
    "Shortcuts: `disable-tool <tool_name>`, `enable-tool <tool_name>`."
  ].join("\n");
}

function formatAgentUserConfigKeyLines(input: {
  store: TokenStore;
  principal: { workspaceId: string; slackUserId: string };
  manifest: ReturnType<typeof buildRuntimeManifestForPrincipal>;
  key: AgentUserConfigKey;
}): string[] {
  switch (input.key) {
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

function parseStringListConfigValue(value: string): string[] {
  return value
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
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
  provider: "github" | "google" | "jira" | "slack"
): string {
  if (!connection) {
    return "Not connected.";
  }

  if (provider === "slack") {
    return `Connected as <@${connection.providerLogin}>.`;
  }

  return `Connected as \`${connection.providerLogin}\`.`;
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

function isProgressOnlyMessage(text: string): boolean {
  return (
    /^Starting agent runtime/i.test(text) ||
    /^Agent is /i.test(text) ||
    /^Calling /i.test(text) ||
    /^Final result in /i.test(text) ||
    /completed in \d+(?:ms|s).*\bresult\)/i.test(text)
  );
}

async function postConversationResponse(
  client: App["client"],
  input: {
    response: ConversationResponse;
    channel: string;
    user: string;
    progressMessage?: SlackProgressMessage;
    threadTs?: string;
  }
): Promise<void> {
  if (input.progressMessage && input.response.visibility !== "ephemeral") {
    const finishedText = renderProgressLines(input.progressMessage, [
      formatFinalProgressLine(
        Date.now() - input.progressMessage.startedAtMs,
        input.response.usage
      )
    ]);
    input.progressMessage.text = finishedText;
    await client.chat.update({
      channel: input.progressMessage.channel,
      ts: input.progressMessage.ts,
      text: finishedText
    });
    await client.chat.postMessage({
      channel: input.response.visibility === "dm" ? input.user : input.channel,
      ...(input.threadTs && input.response.visibility !== "dm"
        ? { thread_ts: input.threadTs }
        : {}),
      text: renderConversationResponseText(input.response),
      ...(input.response.blocks ? { blocks: input.response.blocks } : {})
    });
    return;
  }

  if (input.response.visibility === "ephemeral") {
    await client.chat.postEphemeral({
      channel: input.channel,
      user: input.user,
      text: renderConversationResponseText(input.response),
      ...(input.response.blocks ? { blocks: input.response.blocks } : {})
    });
    return;
  }

  if (input.response.visibility === "dm") {
    await client.chat.postMessage({
      channel: input.user,
      text: renderConversationResponseText(input.response),
      ...(input.response.blocks ? { blocks: input.response.blocks } : {})
    });
    return;
  }

  await client.chat.postMessage({
    channel: input.channel,
    ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
    text: renderConversationResponseText(input.response),
    ...(input.response.blocks ? { blocks: input.response.blocks } : {})
  });
}

function renderConversationResponseText(response: ConversationResponse): string {
  if (!response.attachments || response.attachments.length === 0) {
    return response.text;
  }

  return [
    ...(response.text.trim() ? [response.text, ""] : []),
    "*Attachments:*",
    ...response.attachments.map((attachment) => {
      const label = attachment.name ?? attachment.id;
      return `- ${label} (${attachment.kind}, ${attachment.mimeType})`;
    })
  ].join("\n");
}

async function postMentionWorkingState(
  client: App["client"],
  input: {
    channel: string;
    user: string;
    isDirectMessage: boolean;
    threadTs?: string;
  }
): Promise<SlackProgressMessage | undefined> {
  const text = formatMentionWorkingMessage();

  if (input.isDirectMessage) {
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

async function updateAgentProgressMessage(
  client: App["client"],
  progressMessage: SlackProgressMessage,
  event: AgentRunEvent
): Promise<void> {
  const text = formatAgentProgressMessage(event, progressMessage);
  if (!text || text === progressMessage.text) {
    return;
  }

  progressMessage.text = text;
  await client.chat.update({
    channel: progressMessage.channel,
    ts: progressMessage.ts,
    text
  });
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
      return event.text.trim() && !currentText.trim()
        ? "Agent is responding..."
        : undefined;
    }
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

  return `I could not handle that ${target}.`;
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

function formatAgentProgressMessage(
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
    return renderProgressLines(progressMessage, [
      normalizeAgentStatus(event.text)
    ]);
  }

  if (event.type === "message_delta") {
    return event.text.trim()
      ? renderProgressLines(progressMessage, ["Agent is responding..."])
      : undefined;
  }

  return undefined;
}

function normalizeAgentStatus(text: string): string {
  const trimmed = text.trim();
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

  const parts = [`${totalTokens} tokens`];
  if (typeof usage.cachedInputTokens === "number" && usage.cachedInputTokens > 0) {
    parts.push(`${usage.cachedInputTokens} cached`);
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
