import type { ProviderConnection } from "../db";
import type { GitHubIssue, GitHubUser } from "../github";
import type { ToolResult } from "./types";

export type GitHubToolDeps = {
  getGitHubUser: (token: string) => Promise<GitHubUser>;
  listAssignedIssues: (token: string) => Promise<GitHubIssue[]>;
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
          content: issues.slice(0, 10).map((issue) => ({
            title: issue.title,
            url: issue.html_url
          }))
        };
      }
    }
  };
}
