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
      title: "GitHub pull requests authored by me",
      description:
        "List GitHub pull requests authored by this Slack user's connected GitHub account. Defaults to open PRs sorted by most recently updated.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Maximum number of pull requests to return. Defaults to 10."),
        state: z
          .enum(["open", "closed", "all"])
          .optional()
          .describe("Pull request state to include. Defaults to open."),
        sort: z
          .enum(["updated", "created", "comments"])
          .optional()
          .describe("Sort field. Defaults to updated."),
        order: z
          .enum(["desc", "asc"])
          .optional()
          .describe("Sort order. Defaults to desc.")
      }
    },
    async ({ limit, state, sort, order }) =>
      mcpToolResult(
        await withConnection(input.store, input.runtime, "github", (connection) =>
          githubTools.listMyPullRequests.execute({
            connection,
            input: {
              ...(limit !== undefined ? { limit } : {}),
              ...(state ? { state } : {}),
              ...(sort ? { sort } : {}),
              ...(order ? { order } : {})
            }
          })
        )
      )
  );
}
