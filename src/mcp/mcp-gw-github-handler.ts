import type { Config } from "../config";
import type { AgentRuntimeRecord } from "../db";
import type { ToolResult } from "../tools/types";
import {
  adaptMcpGwGitHubToolCall,
  executeMcpGwGitHubToolPlan,
  mcpGwGitHubToolResult,
} from "./mcp-gw-github-adapter";
import {
  callMcpGwTool,
  McpGwUnauthorizedError,
} from "./mcp-gw-client";
import type { ProviderMcpDeps } from "./provider-context";
import { resolveMcpUserAssertion } from "./user-assertion";

export async function handleMcpGwGitHubToolRequest(input: {
  config: Config;
  runtime: AgentRuntimeRecord;
  deps: ProviderMcpDeps;
  toolName: string;
  args: unknown;
}): Promise<ToolResult<unknown>> {
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
    const result = await executeMcpGwGitHubToolPlan(plan, (call) =>
      (input.deps.callMcpGwTool ?? callMcpGwTool)(
        {
          url: input.config.mcpGwMcpUrl as string,
          bearerToken: assertion.token,
        },
        call,
      ),
    );
    return mcpGwGitHubToolResult(plan, result);
  } catch (error) {
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
