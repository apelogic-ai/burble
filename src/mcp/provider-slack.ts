import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentRuntimeRecord, ProviderConnection, TokenStore } from "../db";
import { slackProviderToolSpecs } from "../providers/slack/tool-specs";
import { providerToolInputSchema } from "../providers/tool-specs";
import { createSlackTools } from "../tools/slack";
import type { ToolResult } from "../tools/types";
import { mcpToolResult, type ProviderMcpDeps, withConnection } from "./provider-context";
import {
  isProviderMcpToolEnabled,
  type ProviderMcpToolPolicy
} from "./provider-policy";

type SlackTools = ReturnType<typeof createSlackTools>;
type SlackToolArgs = Record<string, unknown>;
type SlackMcpHandler = (
  connection: ProviderConnection,
  args: SlackToolArgs
) => Promise<ToolResult<unknown>>;

export function registerSlackMcpTools(input: {
  server: McpServer;
  store: TokenStore;
  runtime: AgentRuntimeRecord;
  deps: Parameters<typeof createSlackTools>[0] & ProviderMcpDeps;
  policy?: ProviderMcpToolPolicy;
}): void {
  const slackTools = createSlackTools(input.deps);
  const handlers = createSlackMcpHandlers(slackTools);

  for (const spec of slackProviderToolSpecs) {
    if (!isProviderMcpToolEnabled(input.policy, spec.name)) {
      continue;
    }
    const handler = handlers[spec.implementation];
    if (!handler) {
      throw new Error(`Missing Slack MCP handler for ${spec.implementation}`);
    }

    input.server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: providerToolInputSchema(spec)
      },
      async (args) =>
        mcpToolResult(
          await withConnection(input.store, input.runtime, "slack", (connection) =>
            handler(connection, args as SlackToolArgs)
          )
        )
    );
  }
}

function createSlackMcpHandlers(
  slackTools: SlackTools
): Record<string, SlackMcpHandler> {
  return {
    searchUsers: (connection, args) =>
      slackTools.searchUsers.execute({
        connection,
        input: { query: stringArg(args, "query") }
      }),

    searchMessages: (connection, args) =>
      slackTools.searchMessages.execute({
        connection,
        input: {
          query: stringArg(args, "query"),
          ...optionalTruthyStringField(args, "fromUserId"),
          ...optionalTruthyStringField(args, "inChannel"),
          ...optionalTruthyNumberField(args, "limit")
        }
      })
  };
}

function stringArg(args: SlackToolArgs, key: string): string {
  return args[key] as string;
}

function optionalTruthyStringField(
  args: SlackToolArgs,
  key: string
): Partial<Record<string, string>> {
  return args[key] ? { [key]: args[key] as string } : {};
}

function optionalTruthyNumberField(
  args: SlackToolArgs,
  key: string
): Partial<Record<string, number>> {
  return args[key] ? { [key]: args[key] as number } : {};
}
