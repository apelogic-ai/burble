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
import type { TokenStore } from "./db";
import { handleConversation } from "./conversation/orchestrator";
import { normalizeMentionText } from "./conversation/normalize";
import type { ConversationResponse } from "./conversation/types";
import { createConfiguredAgentRunner } from "./agent/runtime";
import { createGitHubTools } from "./tools/github";
import {
  formatConnectGitHubMessage,
  formatGitHubIdentityMessage,
  formatIssuesMessage,
  formatMentionWorkingMessage,
  formatWorkingMessage
} from "./formatting";

export {
  formatConnectGitHubMessage,
  formatGitHubIdentityMessage,
  formatIssuesMessage,
  formatMentionWorkingMessage,
  formatWorkingMessage
} from "./formatting";

export type SlackRuntime = {
  app: App;
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

export function createSlackRuntime(config: Config, store: TokenStore): SlackRuntime {
  const app = new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    socketMode: true,
    logLevel: toBoltLogLevel(config.slackLogLevel)
  });

  app.use(async ({ body, logger, next }) => {
    logger.info(`Received Slack payload ${summarizeSlackPayload(body)}`);

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
      logger.info(`Received /connect-github from ${body.user_id}`);
      const userId = body.user_id;
      const state = store.createOAuthState(userId);
      const url = buildGitHubOAuthUrl(config, state);

      await ack({
        response_type: "ephemeral",
        text: formatConnectGitHubMessage(url)
      });
    } catch (error) {
      logger.error(error);
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
  const agentRunner =
    config.agentMode === "llm"
      ? createConfiguredAgentRunner({
          runtime: config.agentRuntime,
          model: config.aiModel,
          githubTools,
          openClawNemoClawUrl: config.openClawNemoClawUrl,
          logInfo: (message) => app.logger.info(message)
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

    logger.info(`Received app_mention from ${mention.user ?? "unknown"}`);

    if (!mention.user || !mention.channel || !mention.ts) {
      logger.warn("Ignoring malformed app_mention event");
      return;
    }

    try {
      const email = await getSlackEmail(mention.user);
      const text = normalizeMentionText(mention.text ?? "");
      if (config.agentMode === "llm") {
        await postMentionWorkingState(client, {
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
          getConnection: (provider, emailAddress) =>
            store.getConnection(provider, emailAddress),
          githubTools,
          agentMode: config.agentMode,
          ...(agentRunner ? { agentRunner } : {})
        }
      );

      await postConversationResponse(client, {
        response,
        channel: mention.channel,
        user: mention.user,
        threadTs: buildReplyThreadTs({
          isDirectMessage:
            mention.channel_type === "im" || mention.channel.startsWith("D"),
          messageTs: mention.ts,
          threadTs: mention.thread_ts
        })
      });
    } catch (error) {
      logger.error(error);
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

    logger.info(`Received message.im from ${directMessage.user}`);

    try {
      const email = await getSlackEmail(directMessage.user);
      if (config.agentMode === "llm") {
        await postMentionWorkingState(client, {
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
          getConnection: (provider, emailAddress) =>
            store.getConnection(provider, emailAddress),
          githubTools,
          agentMode: config.agentMode,
          ...(agentRunner ? { agentRunner } : {})
        }
      );

      await postConversationResponse(client, {
        response,
        channel: directMessage.channel,
        user: directMessage.user,
        threadTs: buildReplyThreadTs({
          isDirectMessage: true,
          messageTs: directMessage.ts,
          threadTs: directMessage.thread_ts
        })
      });
    } catch (error) {
      logger.error(error);
      await client.chat.postMessage({
        channel: directMessage.channel,
        text: "I could not handle that message."
      });
    }
  });

  app.command("/auth", async ({ ack, body, logger }) => {
    try {
      logger.info(`Received /auth ${body.text} from ${body.user_id}`);
      const action = parseAuthCommand(body.text);

      if (action.kind === "unknown") {
        await ack({
          response_type: "ephemeral",
          text: `Unknown auth target \`${action.value}\`. Try \`/auth connections\` or \`/auth github\`.`
        });
        return;
      }

      const state = store.createOAuthState(body.user_id);
      const githubUrl = buildGitHubOAuthUrl(config, state);

      await ack(
        action.kind === "github"
          ? {
              response_type: "ephemeral",
              text: formatConnectGitHubMessage(githubUrl)
            }
          : buildAuthResponse(githubUrl)
      );
    } catch (error) {
      logger.error(error);
      await ack({
        response_type: "ephemeral",
        text: "I could not open auth settings."
      });
    }
  });

  app.command("/issues", async ({ ack, body, respond, logger }) => {
    logger.info(`Received /issues from ${body.user_id}`);
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
      logger.error(error);
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
    logger.info(`Received /github-me from ${body.user_id}`);
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
      logger.error(error);
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

  return { app, getSlackEmail };
}

export type AuthCommand =
  | { kind: "connections" }
  | { kind: "github" }
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

  return { kind: "unknown", value: normalized };
}

export function buildAuthResponse(githubUrl: string) {
  return {
    response_type: "ephemeral" as const,
    text: "Connections: GitHub is available. Atlassian and Salesforce are coming later.",
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
          url: githubUrl,
          action_id: "connect_github"
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Atlassian*\nJira and Confluence auth will be added after the GitHub PoC."
        }
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
            text: "Shortcuts: `/auth github`, `/github-me x`, `/issues x`"
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
    threadTs?: string;
  }
): Promise<void> {
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
): Promise<void> {
  const text = formatMentionWorkingMessage();

  if (input.isDirectMessage) {
    await client.chat.postMessage({
      channel: input.channel,
      ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
      text
    });
    return;
  }

  await client.chat.postEphemeral({
    channel: input.channel,
    user: input.user,
    ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
    text
  });
}
