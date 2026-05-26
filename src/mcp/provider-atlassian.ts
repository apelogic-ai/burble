import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { Config } from "../config";
import type { AgentRuntimeRecord, TokenStore } from "../db";
import { refreshJiraAccessToken } from "../jira";
import {
  isJiraAuthErrorResult,
  type JiraToolDeps,
  withFreshJiraToken
} from "../tools/jira";
import {
  logAtlassianMcpCallFailure,
  logAtlassianMcpCallFinish,
  logAtlassianMcpCallStart
} from "./atlassian-logging";
import { verifyJiraAuthForOpaqueAtlassianMcpError } from "./atlassian-auth";
import {
  mcpToolResult,
  type ProviderMcpDeps,
  withConnection
} from "./provider-context";
import {
  callUpstreamMcpTool,
  listUpstreamMcpTools,
  type UpstreamMcpTool,
  type UpstreamMcpToolResult
} from "./upstream-http-client";

export function registerAtlassianMcpTools(input: {
  server: McpServer;
  config: Config;
  store: TokenStore;
  runtime: AgentRuntimeRecord;
  deps: JiraToolDeps & ProviderMcpDeps;
}): void {
  input.server.registerTool(
    "atlassian_list_mcp_tools",
    {
      title: "Atlassian MCP tools",
      description:
        "List allowed tool metadata advertised by the upstream Atlassian MCP server for this Slack user's connected Jira account.",
      inputSchema: {}
    },
    async () =>
      mcpToolResult(
        await withConnection<
          | Array<{ name: string; title?: string; description?: string }>
          | { error: string; message: string }
        >(input.store, input.runtime, "jira", async (connection) => {
          const tools = await withFreshJiraToken(
            {
              ...input.deps,
              refreshJiraAccessToken: (refreshToken) =>
                refreshJiraAccessToken(input.config, refreshToken),
              saveJiraConnection: (updatedConnection) =>
                input.store.upsertProviderConnection(updatedConnection)
            },
            connection,
            (accessToken) =>
              (input.deps.listAtlassianMcpTools ?? defaultListAtlassianMcpTools)({
                url: input.config.atlassianMcpUrl,
                accessToken
              })
          );
          if (isJiraAuthErrorResult(tools)) {
            return tools;
          }

          return {
            classification: "user_private",
            content: tools
              .filter((tool) => isAllowedAtlassianMcpToolName(tool.name))
              .slice(0, 50)
              .map((tool) => ({
                name: tool.name,
                ...(tool.title ? { title: tool.title } : {}),
                ...(tool.description ? { description: tool.description } : {}),
                ...("inputSchema" in tool
                  ? { inputSchema: sanitizeMcpInputSchema(tool.inputSchema) }
                  : {})
              }))
          };
        })
      )
  );

  input.server.registerTool(
    "atlassian_call_mcp_tool",
    {
      title: "Atlassian MCP allowed tool call",
      description:
        "Call an allowlisted upstream Atlassian MCP tool with this Slack user's connected Jira identity.",
      inputSchema: {
        name: z.string().min(1).describe("Upstream Atlassian MCP tool name"),
        arguments: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("JSON arguments for the upstream MCP tool")
      }
    },
    async ({ name, arguments: args }) =>
      mcpToolResult(
        await withConnection<
          | { toolName: string; result: UpstreamMcpToolResult }
          | { error: string; message: string }
        >(input.store, input.runtime, "jira", async (connection) => {
          if (!isAllowedAtlassianMcpToolName(name)) {
            return {
              classification: "user_private",
              content: {
                error: "atlassian_mcp_tool_not_allowed",
                message: `Atlassian MCP tool \`${name}\` is not enabled for use.`
              }
            };
          }

          const result = await withFreshJiraToken(
            {
              ...input.deps,
              refreshJiraAccessToken: (refreshToken) =>
                refreshJiraAccessToken(input.config, refreshToken),
              saveJiraConnection: (updatedConnection) =>
                input.store.upsertProviderConnection(updatedConnection)
            },
            connection,
            async (accessToken) => {
              logAtlassianMcpCallStart("mcp", input.runtime.id, name, args);
              try {
                const upstreamResult = await (input.deps.callAtlassianMcpTool ??
                  defaultCallAtlassianMcpTool)({
                  url: input.config.atlassianMcpUrl,
                  accessToken,
                  name,
                  arguments: args
                });
                logAtlassianMcpCallFinish(
                  "mcp",
                  input.runtime.id,
                  name,
                  upstreamResult
                );
                await verifyJiraAuthForOpaqueAtlassianMcpError(
                  upstreamResult,
                  accessToken,
                  { getJiraUser: input.deps.getJiraUser }
                );
                return upstreamResult;
              } catch (error) {
                logAtlassianMcpCallFailure("mcp", input.runtime.id, name, error);
                throw error;
              }
            }
          );
          if (isJiraAuthErrorResult(result)) {
            return result;
          }

          return {
            classification: "user_private",
            content: {
              toolName: name,
              result: sanitizeUpstreamMcpToolResult(result)
            }
          };
        })
      )
  );
}

function defaultListAtlassianMcpTools(input: {
  url: string;
  accessToken: string;
}): Promise<UpstreamMcpTool[]> {
  return listUpstreamMcpTools({
    url: input.url,
    authorization: `Bearer ${input.accessToken}`,
    clientName: "burble-atlassian-mcp-facade",
    clientVersion: "0.1.0"
  });
}

function defaultCallAtlassianMcpTool(input: {
  url: string;
  accessToken: string;
  name: string;
  arguments?: Record<string, unknown>;
}): Promise<UpstreamMcpToolResult> {
  return callUpstreamMcpTool(
    {
      url: input.url,
      authorization: `Bearer ${input.accessToken}`,
      clientName: "burble-atlassian-mcp-facade",
      clientVersion: "0.1.0"
    },
    {
      name: input.name,
      arguments: input.arguments
    }
  );
}

const allowedMutatingAtlassianMcpTools = new Set([
  "addcommenttojiraissue",
  "addworklogtojiraissue",
  "createjiraissue",
  "editjiraissue",
  "transitionjiraissue"
]);

export function isAllowedAtlassianMcpToolName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  if (allowedMutatingAtlassianMcpTools.has(normalized)) {
    return true;
  }

  if (
    /(create|update|delete|remove|transition|assign|comment|attach|add|set|edit|move|link)/.test(
      normalized
    )
  ) {
    return false;
  }

  return /^(get|list|search|find|read|lookup|fetch|describe)/.test(normalized);
}

export const isReadOnlyAtlassianMcpToolName = isAllowedAtlassianMcpToolName;

function sanitizeUpstreamMcpToolResult(
  result: UpstreamMcpToolResult
): UpstreamMcpToolResult {
  return {
    ...(Array.isArray(result.content)
      ? { content: result.content.slice(0, 20).map(sanitizeMcpContentItem) }
      : {}),
    ...(typeof result.isError === "boolean" ? { isError: result.isError } : {})
  };
}

function sanitizeMcpInputSchema(schema: unknown): unknown {
  if (schema === undefined) {
    return undefined;
  }

  try {
    const text = JSON.stringify(schema);
    return text.length <= 12_000 ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeMcpContentItem(item: unknown): unknown {
  if (!item || typeof item !== "object") {
    return item;
  }

  const record = item as Record<string, unknown>;
  if (record.type === "text" && typeof record.text === "string") {
    return {
      type: "text",
      text: record.text.slice(0, 12_000)
    };
  }

  return record;
}
