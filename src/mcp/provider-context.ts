import type { AgentRuntimeRecord, Provider, TokenStore } from "../db";
import type { GitHubToolDeps } from "../tools/github";
import type { GoogleToolDeps } from "../tools/google";
import type { HubSpotToolDeps } from "../tools/hubspot";
import type { JiraToolDeps } from "../tools/jira";
import type { SlackToolDeps } from "../tools/slack";
import type { ToolResult } from "../tools/types";
import type { UpstreamMcpTool, UpstreamMcpToolResult } from "./upstream-http-client";

export type ProviderMcpScope =
  | "all"
  | "github"
  | "google"
  | "hubspot"
  | "jira"
  | "slack"
  | "atlassian";

export type ProviderMcpDeps = Partial<GitHubToolDeps> &
  Partial<GoogleToolDeps> &
  Partial<HubSpotToolDeps> &
  Partial<JiraToolDeps> &
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
          provider === "github"
            ? "Connect GitHub first."
            : provider === "google"
              ? "Connect Google first: `/auth google`."
            : provider === "hubspot"
              ? "Connect HubSpot first: `/auth hubspot`."
            : provider === "jira"
              ? "Connect Jira first."
              : "Connect Slack search first: `/auth slack`."
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
