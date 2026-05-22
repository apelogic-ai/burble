import type { ProviderConnection } from "../db";
import type { ToolResult } from "./types";

export type JiraUser = {
  accountId: string;
  displayName: string;
  emailAddress?: string;
};

export type JiraIssue = {
  key: string;
  summary: string;
  url: string;
  status?: string;
};

export type JiraToolDeps = {
  getJiraUser: (token: string) => Promise<JiraUser>;
  listAssignedJiraIssues: (token: string) => Promise<JiraIssue[]>;
  searchJiraIssues: (token: string, jql: string) => Promise<JiraIssue[]>;
};

export type JiraToolContext = {
  connection: ProviderConnection;
};

export function createJiraTools(deps: JiraToolDeps) {
  return {
    getAuthenticatedUser: {
      async execute(
        context: JiraToolContext
      ): Promise<ToolResult<{ accountId: string; displayName: string }>> {
        const user = await deps.getJiraUser(context.connection.accessToken);
        return {
          classification: "user_private",
          content: {
            accountId: user.accountId,
            displayName: user.displayName
          }
        };
      }
    },

    listAssignedIssues: {
      async execute(
        context: JiraToolContext
      ): Promise<ToolResult<Array<{ key: string; title: string; url: string; status?: string }>>> {
        const issues = await deps.listAssignedJiraIssues(
          context.connection.accessToken
        );
        return {
          classification: "user_private",
          content: sanitizeIssues(issues)
        };
      }
    },

    searchIssues: {
      async execute(
        context: JiraToolContext & { input: { jql: string } }
      ): Promise<ToolResult<Array<{ key: string; title: string; url: string; status?: string }>>> {
        const issues = await deps.searchJiraIssues(
          context.connection.accessToken,
          context.input.jql
        );
        return {
          classification: "user_private",
          content: sanitizeIssues(issues)
        };
      }
    }
  };
}

function sanitizeIssues(issues: JiraIssue[]) {
  return issues.slice(0, 10).map((issue) => ({
    key: issue.key,
    title: issue.summary,
    url: issue.url,
    ...(issue.status ? { status: issue.status } : {})
  }));
}
