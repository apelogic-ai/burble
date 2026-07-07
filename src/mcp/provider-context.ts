import type { AgentRuntimeRecord, Provider, TokenStore } from "../db";
import type { GitHubToolDeps } from "../tools/github";
import type { GoogleToolDeps } from "../tools/google";
import type { HubSpotToolDeps } from "../tools/hubspot";
import type { JiraToolDeps } from "../tools/jira";
import type { SlackToolDeps } from "../tools/slack";
import type { ToolResult } from "../tools/types";
import type { WebSearchDeps } from "../providers/web/client";
import type { McpIdentityIssuer } from "../mcp-identity";
import {
  providerDescriptor,
  type ProviderDescriptorId
} from "../providers/descriptors";
import type { callMcpGwTool } from "./mcp-gw-client";
import type {
  UpstreamMcpTool,
  UpstreamMcpToolResult
} from "./upstream-http-client";

export type ProviderMcpScope = "all" | ProviderDescriptorId;

export type ProviderMcpDeps = Partial<GitHubToolDeps> &
  Partial<GoogleToolDeps> &
  Partial<HubSpotToolDeps> &
  Partial<JiraToolDeps> &
  Partial<WebSearchDeps> &
  Partial<SlackToolDeps> & {
    listAtlassianMcpTools?: (input: {
      url: string;
      accessToken: string;
    }) => Promise<UpstreamMcpTool[]>;
    callAtlassianMcpTool?: (input: {
      url: string;
      accessToken: string;
      name: string;
      arguments?: Record<string, unknown>;
    }) => Promise<UpstreamMcpToolResult>;
    mcpIdentityIssuer?: McpIdentityIssuer | null;
    getSlackEmail?: (slackUserId: string) => Promise<string>;
    callMcpGwTool?: typeof callMcpGwTool;
  };

export async function withConnection<TContent>(
  store: TokenStore,
  runtime: AgentRuntimeRecord,
  provider: Provider,
  callback: (
    connection: NonNullable<ReturnType<TokenStore["getConnectionForSlackUser"]>>
  ) => Promise<ToolResult<TContent>>
): Promise<ToolResult<TContent | { error: string; message: string }>> {
  const connection = store.getConnectionForSlackUser(provider, runtime.slackUserId);
  if (!connection) {
    return {
      classification: "user_private",
      content: {
        error: `${provider}_not_connected`,
        message:
          providerDescriptor(provider)?.missingConnectionText ??
          `Connect ${provider} first.`
      }
    };
  }

  return callback(connection);
}

export function mcpToolResult(result: ToolResult<unknown>) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(result)
      }
    ]
  };
}
