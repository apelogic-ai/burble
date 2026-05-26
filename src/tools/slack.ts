import type { ProviderConnection } from "../db";
import type { SlackMessageSearchResult, SlackUser } from "../slack-api";
import type { ToolResult } from "./types";

export type SlackToolDeps = {
  searchSlackUsers: (token: string, query: string) => Promise<SlackUser[]>;
  searchSlackMessages: (
    token: string,
    input: {
      query: string;
      fromUserId?: string;
      inChannel?: string;
      limit?: number;
    }
  ) => Promise<SlackMessageSearchResult[]>;
};

export type SlackToolContext = {
  connection: ProviderConnection;
};

type SlackAuthErrorContent = { error: string; message: string };
type SlackUserContent = Array<{
  id: string;
  name?: string;
  realName?: string;
  displayName?: string;
}>;
type SlackMessageContent = Array<{
  channelId?: string;
  channelName?: string;
  userId?: string;
  username?: string;
  text: string;
  ts?: string;
  permalink?: string;
}>;

export function createSlackTools(deps: SlackToolDeps) {
  return {
    searchUsers: {
      async execute(
        context: SlackToolContext & { input: { query: string } }
      ): Promise<ToolResult<SlackUserContent | SlackAuthErrorContent>> {
        try {
          const users = await deps.searchSlackUsers(
            context.connection.accessToken,
            context.input.query
          );
          return {
            classification: "user_private",
            content: users.slice(0, 10).map((user) => ({
              id: user.id,
              ...(user.name ? { name: user.name } : {}),
              ...(user.realName ? { realName: user.realName } : {}),
              ...(user.displayName ? { displayName: user.displayName } : {})
            }))
          };
        } catch (error) {
          if (isSlackAuthError(error)) {
            return slackAuthErrorResult();
          }
          throw error;
        }
      }
    },

    searchMessages: {
      async execute(
        context: SlackToolContext & {
          input: {
            query: string;
            fromUserId?: string;
            inChannel?: string;
            limit?: number;
          };
        }
      ): Promise<ToolResult<SlackMessageContent | SlackAuthErrorContent>> {
        try {
          const messages = await deps.searchSlackMessages(
            context.connection.accessToken,
            context.input
          );
          return {
            classification: "user_private",
            content: messages.slice(0, 20).map((message) => ({
              ...(message.channelId ? { channelId: message.channelId } : {}),
              ...(message.channelName ? { channelName: message.channelName } : {}),
              ...(message.userId ? { userId: message.userId } : {}),
              ...(message.username ? { username: message.username } : {}),
              text: message.text,
              ...(message.ts ? { ts: message.ts } : {}),
              ...(message.permalink ? { permalink: message.permalink } : {})
            }))
          };
        } catch (error) {
          if (isSlackAuthError(error)) {
            return slackAuthErrorResult();
          }
          throw error;
        }
      }
    }
  };
}

function isSlackAuthError(error: unknown): boolean {
  return (
    error instanceof Error &&
    ["invalid_auth", "token_revoked", "account_inactive", "missing_scope"].includes(
      error.message
    )
  );
}

function slackAuthErrorResult(): ToolResult<SlackAuthErrorContent> {
  return {
    classification: "user_private",
    content: {
      error: "slack_not_connected",
      message: "Connect Slack search first: `/auth slack`."
    }
  };
}
