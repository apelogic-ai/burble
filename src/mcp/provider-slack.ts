import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { AgentRuntimeRecord, TokenStore } from "../db";
import type { SlackToolDeps } from "../tools/slack";
import { createSlackTools } from "../tools/slack";
import { mcpToolResult, type ProviderMcpDeps, withConnection } from "./provider-context";

export function registerSlackMcpTools(input: {
  server: McpServer;
  store: TokenStore;
  runtime: AgentRuntimeRecord;
  deps: SlackToolDeps & ProviderMcpDeps;
}): void {
  const slackTools = createSlackTools(input.deps);

  input.server.registerTool(
    "slack_search_users",
    {
      title: "Slack user search",
      description:
        "Search Slack users by display name, real name, username, or Slack user ID.",
      inputSchema: {
        query: z.string().min(1).describe("Slack user name, display name, or ID")
      }
    },
    async ({ query }) =>
      mcpToolResult(
        await withConnection(input.store, input.runtime, "slack", (connection) =>
          slackTools.searchUsers.execute({
            connection,
            input: { query }
          })
        )
      )
  );

  input.server.registerTool(
    "slack_search_messages",
    {
      title: "Slack message search",
      description:
        "Search Slack messages visible to this Slack user's connected Slack search token.",
      inputSchema: {
        query: z.string().min(1).describe("Slack search terms"),
        fromUserId: z
          .string()
          .optional()
          .describe("Optional Slack user ID to filter by author"),
        inChannel: z
          .string()
          .optional()
          .describe("Optional channel name without #, or channel ID"),
        limit: z.number().int().positive().max(20).optional()
      }
    },
    async ({ query, fromUserId, inChannel, limit }) =>
      mcpToolResult(
        await withConnection(input.store, input.runtime, "slack", (connection) =>
          slackTools.searchMessages.execute({
            connection,
            input: {
              query,
              ...(fromUserId ? { fromUserId } : {}),
              ...(inChannel ? { inChannel } : {}),
              ...(limit ? { limit } : {})
            }
          })
        )
      )
  );
}
