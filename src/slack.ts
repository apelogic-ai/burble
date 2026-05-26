import { App, LogLevel } from "@slack/bolt";
import type { Config } from "./config";
import type { SlackLogLevel } from "./config";
import {
  buildGitHubOAuthUrl,
  getGitHubUser,
  listAssignedIssues,
  listMyPullRequests,
  searchIssues
} from "./github";
import {
  buildJiraOAuthUrl,
  getJiraUser,
  listAssignedJiraIssues,
  refreshJiraAccessToken,
  searchJiraIssues
} from "./jira";
import {
  buildSlackOAuthUrl,
  searchSlackMessages,
  searchSlackUsers
} from "./slack-api";
import type { TokenStore } from "./db";
import { handleConversation } from "./conversation/orchestrator";
import { normalizeMentionText } from "./conversation/normalize";
import type { ConversationResponse, ToolClassification } from "./conversation/types";
import { createConfiguredAgentRunner } from "./agent/runtime";
import type { AgentRunEvent, AgentUsage } from "./agent/types";
import { createDockerRuntimeFactory } from "./agent/container-runtime-factory";
import { createStaticRuntimeFactory } from "./agent/runtime-factory";
import type { RuntimeFactory } from "./agent/runtime-factory";
import { createGitHubTools } from "./tools/github";
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
};

type SlackRecentMessage = {
  author: "user" | "assistant";
  text: string;
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

export function createSlackRuntime(
  config: Config,
  store: TokenStore,
  runtimeJwtIssuer?: RuntimeJwtIssuer
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

  app.command("/connect-github", async ({ ack, body, logger }) => {
    try {
      logger.info(
        withUtcTimestamp(`Received /connect-github from ${body.user_id}`)
      );
      const userId = body.user_id;
      const state = store.createOAuthState(userId);
      const url = buildGitHubOAuthUrl(config, state);

      await ack({
        response_type: "ephemeral",
        text: formatConnectGitHubMessage(url)
      });
    } catch (error) {
      logger.error(formatLogError(error));
      await ack({
        response_type: "ephemeral",
        text: "I could not start the GitHub connection flow."
      });
    }
  });

  const githubTools = createGitHubTools({
    getGitHubUser,
    listAssignedIssues,
    searchIssues,
    listMyPullRequests
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
          slackTools,
          jiraTools,
          openClawNemoClawUrl: config.openClawNemoClawUrl,
          ...(runtimeFactory ? { runtimeFactory } : {}),
          logInfo: (message) => app.logger.info(withUtcTimestamp(message))
        })
      : undefined;

  app.event("app_mention", async ({ body, event, client, logger }) => {
    const mention = event as {
      user?: string;
      text?: string;
      channel?: string;
      ts?: string;
      thread_ts?: string;
      channel_type?: string;
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
      const email = await getSlackEmail(mention.user);
      const text = normalizeMentionText(mention.text ?? "");
      const isDirectMessage =
        mention.channel_type === "im" || mention.channel.startsWith("D");
      const recentMessages = isDirectMessage
        ? await readRecentSlackMessages(client, {
            channel: mention.channel,
            latestTs: mention.ts,
            user: mention.user
          })
        : [];
      if (config.agentMode === "llm") {
        progressMessage = await postMentionWorkingState(client, {
          channel: mention.channel,
          user: mention.user,
          isDirectMessage,
          threadTs: buildReplyThreadTs({
            isDirectMessage,
            messageTs: mention.ts,
            threadTs: mention.thread_ts
          })
        });
      }

      const activeProgressMessage = progressMessage;
      const response = await handleConversation(
        {
          source: "slack",
          workspaceId: body.team_id ?? "",
          channelId: mention.channel,
          threadTs: mention.thread_ts,
          messageTs: mention.ts,
          isDirectMessage,
          ...(recentMessages.length > 0
            ? { context: { recentMessages } }
            : {}),
          user: {
            slackUserId: mention.user,
            email
          },
          text
        },
        {
          createGitHubOAuthUrl: (slackUserId) =>
            buildGitHubOAuthUrl(config, store.createOAuthState(slackUserId)),
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
          githubTools,
          slackTools,
          agentMode: config.agentMode,
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
      if (progressMessage) {
        await client.chat.update({
          channel: progressMessage.channel,
          ts: progressMessage.ts,
          text: "I could not handle that mention."
        });
        return;
      }

      await client.chat.postEphemeral({
        channel: mention.channel,
        user: mention.user,
        text: "I could not handle that mention."
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
      const email = await getSlackEmail(directMessage.user);
      const recentMessages = await readRecentSlackMessages(client, {
        channel: directMessage.channel,
        latestTs: directMessage.ts,
        user: directMessage.user
      });
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

      const activeProgressMessage = progressMessage;
      const response = await handleConversation(
        {
          source: "slack",
          workspaceId: body.team_id ?? "",
          channelId: directMessage.channel,
          threadTs: directMessage.thread_ts,
          messageTs: directMessage.ts,
          isDirectMessage: true,
          ...(recentMessages.length > 0
            ? { context: { recentMessages } }
            : {}),
          user: {
            slackUserId: directMessage.user,
            email
          },
          text: directMessage.text.trim()
        },
        {
          createGitHubOAuthUrl: (slackUserId) =>
            buildGitHubOAuthUrl(config, store.createOAuthState(slackUserId)),
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
          githubTools,
          slackTools,
          agentMode: config.agentMode,
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
      if (progressMessage) {
        await client.chat.update({
          channel: progressMessage.channel,
          ts: progressMessage.ts,
          text: "I could not handle that message."
        });
        return;
      }

      await client.chat.postMessage({
        channel: directMessage.channel,
        text: "I could not handle that message."
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
          text: `Unknown auth target \`${action.value}\`. Try \`/auth connections\`, \`/auth github\`, \`/auth jira\`, or \`/auth slack\`.`
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
              : buildAuthResponse({ githubUrl, jiraUrl, slackUrl })
      );
    } catch (error) {
      logger.error(formatLogError(error));
      await ack({
        response_type: "ephemeral",
        text: "I could not open auth settings."
      });
    }
  });

  app.command("/issues", async ({ ack, body, respond, logger }) => {
    logger.info(withUtcTimestamp(`Received /issues from ${body.user_id}`));
    await ack({
      response_type: "ephemeral",
      text: formatWorkingMessage("/issues")
    });

    try {
      const email = await getSlackEmail(body.user_id);
      const user = store.getConnectedUserByEmail(email);

      if (!user) {
        await respond({
          response_type: "ephemeral",
          text: "Run `/connect-github` first."
        });
        return;
      }

      const issues = await listAssignedIssues(user.githubToken);

      await respond({
        response_type: "ephemeral",
        text: formatIssuesMessage(issues)
      });
    } catch (error) {
      logger.error(formatLogError(error));
      const text =
        error instanceof Error && error.message === "GITHUB_TOKEN_REJECTED"
          ? "GitHub token rejected. Run `/connect-github` to reconnect."
          : "I could not list your GitHub issues.";

      await respond({
        response_type: "ephemeral",
        text
      });
    }
  });

  app.command("/github-me", async ({ ack, body, respond, logger }) => {
    logger.info(withUtcTimestamp(`Received /github-me from ${body.user_id}`));
    await ack({
      response_type: "ephemeral",
      text: formatWorkingMessage("/github-me")
    });

    try {
      const email = await getSlackEmail(body.user_id);
      const user = store.getConnectedUserByEmail(email);

      if (!user) {
        await respond({
          response_type: "ephemeral",
          text: "Run `/connect-github` first."
        });
        return;
      }

      const githubUser = await getGitHubUser(user.githubToken);

      await respond({
        response_type: "ephemeral",
        text: formatGitHubIdentityMessage(githubUser.login, email)
      });
    } catch (error) {
      logger.error(formatLogError(error));
      const text =
        error instanceof Error && error.message === "GitHub user lookup failed with 401"
          ? "GitHub token rejected. Run `/connect-github` to reconnect."
          : "I could not verify your GitHub identity.";

      await respond({
        response_type: "ephemeral",
        text
      });
    }
  });

  return {
    app,
    ...(runtimeFactory ? { runtimeFactory } : {}),
    getSlackEmail
  };
}

function createOpenClawRuntimeFactory(
  config: Config,
  store: TokenStore,
  runtimeJwtIssuer?: RuntimeJwtIssuer
): RuntimeFactory | undefined {
  if (config.agentRuntime !== "openclaw-nemoclaw") {
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
      engine: config.openClawNemoClawEngine,
      image: config.agentRuntimeImage,
      dataRoot: config.agentRuntimeDataRoot,
      dockerNetwork: config.agentRuntimeDockerNetwork,
      toolGatewayUrl: config.agentRuntimeToolGatewayUrl,
      mcpGatewayUrl: config.agentRuntimeMcpGatewayUrl,
      mcpAudience: config.agentRuntimeMcpAudience,
      runtimeJwtIssuer,
      runtimeTokenSecret: config.agentRuntimeTokenSecret,
      openClawConfigPatchPath: config.openClawConfigPatchHostPath,
      idleTtlMs: config.agentRuntimeIdleTtlMs,
      env: Bun.env
    });
  }

  if (!config.openClawNemoClawUrl) {
    return undefined;
  }

  return createStaticRuntimeFactory({
    store,
    engine: config.openClawNemoClawEngine,
    endpointUrl: config.openClawNemoClawUrl,
    authToken: config.internalApiToken ?? "",
    dataRoot: config.agentRuntimeDataRoot
  });
}

export type AuthCommand =
  | { kind: "connections" }
  | { kind: "github" }
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

export function buildAuthResponse(input: {
  githubUrl: string;
  jiraUrl: string | null;
  slackUrl: string | null;
}) {
  return {
    response_type: "ephemeral" as const,
    text: "Connections: GitHub, Jira, and Slack search are available. Salesforce is coming later.",
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "Connections"
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*GitHub*\nConnect your GitHub identity for issue and repository access."
        },
        accessory: {
          type: "button",
          text: {
            type: "plain_text",
            text: "Connect"
          },
          url: input.githubUrl,
          action_id: "connect_github"
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: input.jiraUrl
            ? "*Atlassian Jira*\nConnect your Jira identity for assigned tickets and issue search."
            : "*Atlassian Jira*\nJira OAuth is not configured."
        },
        ...(input.jiraUrl
          ? {
              accessory: {
                type: "button",
                text: {
                  type: "plain_text",
                  text: "Connect"
                },
                url: input.jiraUrl,
                action_id: "connect_jira"
              }
            }
          : {})
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: input.slackUrl
            ? "*Slack search*\nConnect Slack user search for workspace message lookup."
            : "*Slack search*\nSlack OAuth is not configured."
        },
        ...(input.slackUrl
          ? {
              accessory: {
                type: "button",
                text: {
                  type: "plain_text",
                  text: "Connect"
                },
                url: input.slackUrl,
                action_id: "connect_slack"
              }
            }
          : {})
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Salesforce*\nPlanned for the semantic-layer authorization flow."
        }
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "Shortcuts: `/auth github`, `/auth jira`, `/auth slack`, `/github-me x`, `/issues x`"
          }
        ]
      }
    ]
  };
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
  Pick<SlackDirectMessageEvent, "channel" | "user" | "text" | "ts">
> &
  SlackDirectMessageEvent {
  return (
    event.channel_type === "im" &&
    Boolean(event.channel) &&
    Boolean(event.user) &&
    typeof event.text === "string" &&
    Boolean(event.ts) &&
    !event.subtype &&
    !event.bot_id
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
  }
): Promise<SlackRecentMessage[]> {
  try {
    const result = await client.conversations.history({
      channel: input.channel,
      latest: input.latestTs,
      inclusive: false,
      limit: 8
    });
    const messages = ((result.messages ?? []) as SlackHistoryMessage[])
      .slice()
      .reverse();

    return messages.flatMap<SlackRecentMessage>((message) => {
      const text = sanitizeRecentSlackText(message.text);
      if (!text || isProgressOnlyMessage(text)) {
        return [];
      }

      if (message.user === input.user) {
        return [{ author: "user" as const, text }];
      }

      if (message.bot_id || message.user) {
        return [{ author: "assistant" as const, text }];
      }

      return [];
    });
  } catch {
    return [];
  }
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
      text: input.response.text,
      ...(input.response.blocks ? { blocks: input.response.blocks } : {})
    });
    return;
  }

  if (input.response.visibility === "ephemeral") {
    await client.chat.postEphemeral({
      channel: input.channel,
      user: input.user,
      text: input.response.text,
      ...(input.response.blocks ? { blocks: input.response.blocks } : {})
    });
    return;
  }

  if (input.response.visibility === "dm") {
    await client.chat.postMessage({
      channel: input.user,
      text: input.response.text,
      ...(input.response.blocks ? { blocks: input.response.blocks } : {})
    });
    return;
  }

  await client.chat.postMessage({
    channel: input.channel,
    ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
    text: input.response.text,
    ...(input.response.blocks ? { blocks: input.response.blocks } : {})
  });
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
      return currentText.trim() ? undefined : normalizeAgentStatus(event.text);
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

function formatFinalProgressLine(elapsedMs: number, usage?: AgentUsage): string {
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
