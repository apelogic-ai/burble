import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config";
import type { AgentRuntimeRecord, ProviderConnection, TokenStore } from "../db";
import { refreshJiraAccessToken } from "../providers/jira/client";
import {
  allowedMutatingAtlassianMcpTools,
  atlassianProviderToolSpecs
} from "../providers/atlassian/tool-specs";
import { providerToolInputSchema } from "../providers/tool-specs";
import {
  isJiraAuthErrorResult,
  type JiraToolDeps,
  withFreshJiraToken
} from "../tools/jira";
import type { ToolResult } from "../tools/types";
import { verifyJiraAuthForOpaqueAtlassianMcpError } from "./atlassian-auth";
import {
  logAtlassianMcpCallFailure,
  logAtlassianMcpCallFinish,
  logAtlassianMcpCallStart
} from "./atlassian-logging";
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

type AtlassianToolArgs = Record<string, unknown>;
type AtlassianMcpHandler = (
  connection: ProviderConnection,
  args: AtlassianToolArgs
) => Promise<ToolResult<unknown>>;

export function registerAtlassianMcpTools(input: {
  server: McpServer;
  config: Config;
  store: TokenStore;
  runtime: AgentRuntimeRecord;
  deps: JiraToolDeps & ProviderMcpDeps;
}): void {
  const handlers = createAtlassianMcpHandlers(input);

  for (const spec of atlassianProviderToolSpecs) {
    const handler = handlers[spec.implementation];
    if (!handler) {
      throw new Error(`Missing Atlassian MCP handler for ${spec.implementation}`);
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
          await withConnection(input.store, input.runtime, "jira", (connection) =>
            handler(connection, args as AtlassianToolArgs)
          )
        )
    );
  }
}

function createAtlassianMcpHandlers(input: {
  config: Config;
  store: TokenStore;
  runtime: AgentRuntimeRecord;
  deps: JiraToolDeps & ProviderMcpDeps;
}): Record<string, AtlassianMcpHandler> {
  return {
    listMcpTools: async (connection) => {
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
    },

    callMcpTool: async (connection, args) => {
      const name = stringArg(args, "name");
      const toolArguments = optionalObjectArg(args, "arguments");

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
          logAtlassianMcpCallStart(
            "mcp",
            input.runtime.id,
            name,
            toolArguments
          );
          try {
            const upstreamResult = await (input.deps.callAtlassianMcpTool ??
              defaultCallAtlassianMcpTool)({
              url: input.config.atlassianMcpUrl,
              accessToken,
              name,
              arguments: toolArguments
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
    }
  };
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

function stringArg(args: AtlassianToolArgs, key: string): string {
  return args[key] as string;
}

function optionalObjectArg(
  args: AtlassianToolArgs,
  key: string
): Record<string, unknown> | undefined {
  return args[key] !== undefined ? (args[key] as Record<string, unknown>) : undefined;
}
