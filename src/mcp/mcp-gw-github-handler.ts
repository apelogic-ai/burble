import type { Config } from "../config";
import type { AgentRuntimeRecord } from "../db";
import type { ToolResult } from "../tools/types";
import {
  adaptMcpGwGitHubToolCall,
  executeMcpGwGitHubToolPlan,
  mcpGwGitHubToolResult,
  type McpGwGitHubToolPlan,
} from "./mcp-gw-github-adapter";
import {
  callMcpGwTool,
  listMcpGwTools,
  McpGwProviderConnectionRequiredError,
  McpGwUnauthorizedError,
} from "./mcp-gw-client";
import {
  isFederatedGitHubToolName,
  resolveMcpGwGitHubToolName,
} from "./mcp-gw-github-tools";
import type { ProviderMcpDeps } from "./provider-context";
import { resolveMcpUserAssertion } from "./user-assertion";

export async function handleMcpGwGitHubToolRequest(input: {
  config: Config;
  runtime: AgentRuntimeRecord;
  deps: ProviderMcpDeps;
  toolName: string;
  args: unknown;
}): Promise<ToolResult<unknown>> {
  if (
    !input.config.mcpGwMcpUrl ||
    !input.config.mcpGwAudience ||
    !input.deps.mcpIdentityIssuer
  ) {
    return {
      classification: "user_private",
      content: {
        error: "mcp_gw_not_configured",
        message:
          "GitHub via MCP-GW is enabled but MCP-GW URL, audience, or identity issuer is not configured.",
      },
    };
  }
  if (!input.deps.getSlackEmail) {
    return {
      classification: "user_private",
      content: {
        error: "mcp_gw_identity_unavailable",
        message: "GitHub via MCP-GW requires a trusted Slack email resolver.",
      },
    };
  }

  try {
    const assertion = await resolveMcpUserAssertion({
      workspaceId: input.runtime.workspaceId,
      slackUserId: input.runtime.slackUserId,
      audience: input.config.mcpGwAudience,
      issuer: input.deps.mcpIdentityIssuer,
      getSlackEmail: input.deps.getSlackEmail,
    });
    const clientConfig = {
      url: input.config.mcpGwMcpUrl as string,
      bearerToken: assertion.token,
    };
    const getAdvertisedTools = () =>
      (input.deps.listMcpGwTools ?? listMcpGwTools)(clientConfig);

    if (input.toolName === "github_list_mcp_tools") {
      const tools = await getAdvertisedTools();
      return {
        classification: "user_private",
        content: tools
          .filter((tool) => isFederatedGitHubToolName(tool.name))
          .slice(0, 100)
          .map(sanitizeMcpGwTool),
      };
    }

    if (input.toolName === "github_call_mcp_tool") {
      const args = recordInput(input.args);
      const name = stringInput(args, "name");
      const advertisedTools = await getAdvertisedTools();
      if (
        !isFederatedGitHubToolName(name) ||
        !advertisedTools.some((tool) => tool.name === name)
      ) {
        return {
          classification: "user_private",
          content: {
            error: "github_mcp_tool_not_allowed",
            message: `MCP-GW tool \`${name}\` is not an advertised GitHub tool.`,
          },
        };
      }
      const toolArguments = optionalRecordInput(args, "arguments");
      const result = await (input.deps.callMcpGwTool ?? callMcpGwTool)(
        clientConfig,
        { name, arguments: toolArguments },
      );
      const dynamicPlan: McpGwGitHubToolPlan = {
        ok: true,
        kind: "call",
        burbleToolName: input.toolName,
        call: { name, arguments: toolArguments },
      };
      return mcpGwGitHubToolResult(dynamicPlan, result);
    }

    const plan = adaptMcpGwGitHubToolCall(input.toolName, input.args);
    if (!plan.ok) {
      return {
        classification: "user_private",
        content: {
          error: "mcp_gw_tool_not_adapted",
          burbleToolName: plan.burbleToolName,
          message: plan.message,
        },
      };
    }
    const advertisedToolNames = (await getAdvertisedTools()).map(
      (tool) => tool.name,
    );
    const result = await executeMcpGwGitHubToolPlan(plan, (call) =>
      (input.deps.callMcpGwTool ?? callMcpGwTool)(
        clientConfig,
        {
          ...call,
          name: resolveMcpGwGitHubToolName(call.name, advertisedToolNames),
        },
      ),
    );
    return mcpGwGitHubToolResult(plan, result);
  } catch (error) {
    if (
      error instanceof McpGwProviderConnectionRequiredError &&
      error.provider === "github"
    ) {
      return {
        classification: "user_private",
        content: {
          error: "github_not_connected",
          message:
            "GitHub account is not connected. Run `/auth github` to connect or reconnect GitHub.",
          authCommand: "/auth github",
        },
      };
    }
    if (error instanceof McpGwUnauthorizedError) {
      return {
        classification: "user_private",
        content: {
          error: "mcp_gw_unauthorized",
          message: error.message,
          ...(error.protectedResourceMetadataUrl
            ? {
                protectedResourceMetadataUrl:
                  error.protectedResourceMetadataUrl,
              }
            : {}),
        },
      };
    }
    return {
      classification: "user_private",
      content: {
        error: "mcp_gw_call_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function sanitizeMcpGwTool(tool: {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
}) {
  return {
    name: tool.name,
    ...(tool.title ? { title: tool.title } : {}),
    ...(tool.description ? { description: tool.description } : {}),
    ...(tool.inputSchema !== undefined
      ? { inputSchema: boundedJson(tool.inputSchema, 12_000) }
      : {}),
  };
}

function boundedJson(value: unknown, maxLength: number): unknown {
  try {
    const serialized = JSON.stringify(value);
    return serialized.length <= maxLength ? JSON.parse(serialized) : undefined;
  } catch {
    return undefined;
  }
}

function recordInput(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringInput(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === "string" ? value.trim() : "";
}

function optionalRecordInput(
  input: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  return recordInput(input[key]);
}
