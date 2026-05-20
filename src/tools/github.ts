import type { ProviderConnection } from "../db";
import type { GitHubIssue, GitHubPullRequest, GitHubUser } from "../github";
import type { ToolResult } from "./types";

export type GitHubToolDeps = {
  getGitHubUser: (token: string) => Promise<GitHubUser>;
  listAssignedIssues: (token: string) => Promise<GitHubIssue[]>;
  searchIssues: (token: string, query: string) => Promise<GitHubIssue[]>;
  listMyPullRequests: (token: string) => Promise<GitHubPullRequest[]>;
};

export type GitHubToolContext = {
  connection: ProviderConnection;
};

export function createGitHubTools(deps: GitHubToolDeps) {
  return {
    getAuthenticatedUser: {
      async execute(
        context: GitHubToolContext
      ): Promise<ToolResult<{ login: string }>> {
        const user = await deps.getGitHubUser(context.connection.accessToken);
        return {
          classification: "user_private",
          content: {
            login: user.login
          }
        };
      }
    },

    listAssignedIssues: {
      async execute(
        context: GitHubToolContext
      ): Promise<ToolResult<Array<{ title: string; url: string }>>> {
        const issues = await deps.listAssignedIssues(
          context.connection.accessToken
        );
        return {
          classification: "user_private",
          content: sanitizeItems(issues)
        };
      }
    },

    searchIssues: {
      async execute(
        context: GitHubToolContext & { input: { query: string } }
      ): Promise<ToolResult<Array<{ title: string; url: string }>>> {
        const issues = await deps.searchIssues(
          context.connection.accessToken,
          context.input.query
        );
        return {
          classification: "user_private",
          content: sanitizeItems(issues)
        };
      }
    },

    listMyPullRequests: {
      async execute(
        context: GitHubToolContext
      ): Promise<ToolResult<Array<{ title: string; url: string }>>> {
        const prs = await deps.listMyPullRequests(
          context.connection.accessToken
        );
        return {
          classification: "user_private",
          content: sanitizeItems(prs)
        };
      }
    }
  };
}

function sanitizeItems(items: Array<{ title: string; html_url: string }>) {
  return items.slice(0, 10).map((item) => ({
    title: item.title,
    url: item.html_url
  }));
}
