import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { AgentRuntimeRecord, TokenStore } from "../db";
import type { GitHubToolDeps } from "../tools/github";
import { createGitHubTools } from "../tools/github";
import { mcpToolResult, type ProviderMcpDeps, withConnection } from "./provider-context";

export function registerGitHubMcpTools(input: {
  server: McpServer;
  store: TokenStore;
  runtime: AgentRuntimeRecord;
  deps: GitHubToolDeps & ProviderMcpDeps;
}): void {
  const githubTools = createGitHubTools(input.deps);

  input.server.registerTool(
    "github_get_authenticated_user",
    {
      title: "GitHub authenticated user",
      description: "Return the GitHub identity connected to this Slack user.",
      inputSchema: {}
    },
    async () =>
      mcpToolResult(
        await withConnection(input.store, input.runtime, "github", (connection) =>
          githubTools.getAuthenticatedUser.execute({ connection })
        )
      )
  );

  input.server.registerTool(
    "github_list_assigned_issues",
    {
      title: "GitHub assigned issues",
      description: "List GitHub issues assigned to this Slack user.",
      inputSchema: {}
    },
    async () =>
      mcpToolResult(
        await withConnection(input.store, input.runtime, "github", (connection) =>
          githubTools.listAssignedIssues.execute({ connection })
        )
      )
  );

  input.server.registerTool(
    "github_search_issues",
    {
      title: "GitHub issue search",
      description:
        "Search GitHub issues and pull requests visible to this Slack user's connected GitHub account.",
      inputSchema: {
        query: z.string().min(1).describe("GitHub search query")
      }
    },
    async ({ query }) =>
      mcpToolResult(
        await withConnection(input.store, input.runtime, "github", (connection) =>
          githubTools.searchIssues.execute({
            connection,
            input: { query }
          })
        )
      )
  );

  input.server.registerTool(
    "github_list_my_pull_requests",
    {
      title: "GitHub open pull requests",
      description:
        "List open GitHub pull requests authored by this Slack user's connected GitHub account.",
      inputSchema: {}
    },
    async () =>
      mcpToolResult(
        await withConnection(input.store, input.runtime, "github", (connection) =>
          githubTools.listMyPullRequests.execute({ connection })
        )
      )
  );
}
