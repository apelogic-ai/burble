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
  searchJiraIssues
} from "./jira";
import type { TokenStore } from "./db";
import { handleConversation } from "./conversation/orchestrator";
import { normalizeMentionText } from "./conversation/normalize";
import type { ConversationResponse } from "./conversation/types";
import { createConfiguredAgentRunner } from "./agent/runtime";
import type { AgentRunEvent } from "./agent/types";
import { createDockerRuntimeFactory } from "./agent/container-runtime-factory";
import { createStaticRuntimeFactory } from "./agent/runtime-factory";
import type { RuntimeFactory } from "./agent/runtime-factory";
import { createGitHubTools } from "./tools/github";
import { createJiraTools } from "./tools/jira";
import {
  formatConnectGitHubMessage,
  formatGitHubIdentityMessage,
  formatIssuesMessage,
  formatMentionWorkingMessage,
  formatWorkingMessage
} from "./formatting";
import { formatLogError, withUtcTimestamp } from "./logging";

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

type SlackProgressMessage = {
  channel: string;
  ts: string;
  text: string;
};

export function createSlackRuntime(config: Config, store: TokenStore): SlackRuntime {
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
    searchJiraIssues
  });
  const runtimeFactory = createOpenClawRuntimeFactory(config, store);
  const agentRunner =
    config.agentMode === "llm"
      ? createConfiguredAgentRunner({
          runtime: config.agentRuntime,
          model: config.aiModel,
          githubTools,
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

      const activeProgressMessage = progressMessage;
      const response = await handleConversation(
        {
          source: "slack",
          workspaceId: body.team_id ?? "",
          channelId: mention.channel,
          threadTs: mention.thread_ts,
          messageTs: mention.ts,
          isDirectMessage:
            mention.channel_type === "im" || mention.channel.startsWith("D"),
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
          getConnection: (provider, emailAddress) =>
            store.getConnection(provider, emailAddress),
          githubTools,
          agentMode: config.agentMode,
          ...(agentRunner ? { agentRunner } : {}),
          ...(activeProgressMessage
            ? {
                onAgentEvent: (event) =>
                  updateAgentProgressMessage(client, activeProgressMessage, event)
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
          isDirectMessage:
            mention.channel_type === "im" || mention.channel.startsWith("D"),
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
          getConnection: (provider, emailAddress) =>
            store.getConnection(provider, emailAddress),
          githubTools,
          agentMode: config.agentMode,
          ...(agentRunner ? { agentRunner } : {}),
          ...(activeProgressMessage
            ? {
                onAgentEvent: (event) =>
                  updateAgentProgressMessage(client, activeProgressMessage, event)
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
          text: `Unknown auth target \`${action.value}\`. Try \`/auth connections\`, \`/auth github\`, or \`/auth jira\`.`
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
            : buildAuthResponse({ githubUrl, jiraUrl })
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
  store: TokenStore
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
      engine: "openclaw",
      image: config.agentRuntimeImage,
      dataRoot: config.agentRuntimeDataRoot,
      dockerNetwork: config.agentRuntimeDockerNetwork,
      toolGatewayUrl: config.agentRuntimeToolGatewayUrl,
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
    engine: "openclaw",
    endpointUrl: config.openClawNemoClawUrl,
    authToken: config.internalApiToken ?? "",
    dataRoot: config.agentRuntimeDataRoot
  });
}

export type AuthCommand =
  | { kind: "connections" }
  | { kind: "github" }
  | { kind: "jira" }
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

  return { kind: "unknown", value: normalized };
}

export function buildAuthResponse(input: {
  githubUrl: string;
  jiraUrl: string | null;
}) {
  return {
    response_type: "ephemeral" as const,
    text: "Connections: GitHub and Jira are available. Salesforce is coming later.",
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
          text: "*Salesforce*\nPlanned for the semantic-layer authorization flow."
        }
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "Shortcuts: `/auth github`, `/auth jira`, `/github-me x`, `/issues x`"
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
    await client.chat.update({
      channel: input.progressMessage.channel,
      ts: input.progressMessage.ts,
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
          text
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
  const text = formatAgentProgressEvent(event, progressMessage.text);
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
      return event.text;
    case "tool_call":
      return `Using ${formatAgentToolName(event.toolName)}...`;
    case "tool_result":
      return `Finished ${formatAgentToolName(event.toolName)}.`;
    case "message_delta": {
      if (!event.text.trim()) {
        return undefined;
      }

      return currentText && !currentText.endsWith("...")
        ? `${currentText}${event.text}`
        : event.text.trimStart();
    }
    case "final":
    case "error":
      return undefined;
  }
}

function formatAgentToolName(toolName: string): string {
  return toolName
    .replace(/^github_/, "GitHub ")
    .replace(/^jira_/, "Jira ")
    .replaceAll("_", " ")
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
