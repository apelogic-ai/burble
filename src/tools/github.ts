import type { ProviderConnection } from "../db";
import type {
  GitHubIssue,
  GitHubPullRequest,
  GitHubPullRequestState,
  GitHubSearchOrder,
  GitHubSearchSort,
  GitHubUser,
  ListMyPullRequestsOptions
} from "../github";
import type { ToolResult } from "./types";

export type GitHubToolDeps = {
  getGitHubUser: (token: string) => Promise<GitHubUser>;
  listAssignedIssues: (token: string) => Promise<GitHubIssue[]>;
  searchIssues: (token: string, query: string) => Promise<GitHubIssue[]>;
  listMyPullRequests: (
    token: string,
    options?: ListMyPullRequestsOptions
  ) => Promise<GitHubPullRequest[]>;
};

export type GitHubToolContext = {
  connection: ProviderConnection;
};

export type GitHubPullRequestListInput = {
  limit?: number;
  state?: GitHubPullRequestState;
  sort?: GitHubSearchSort;
  order?: GitHubSearchOrder;
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
        context: GitHubToolContext & { input?: GitHubPullRequestListInput }
      ): Promise<ToolResult<Array<{ title: string; url: string }>>> {
        const input = normalizePullRequestListInput(context.input);
        const prs = await deps.listMyPullRequests(
          context.connection.accessToken,
          input
        );
        return {
          classification: "user_private",
          content: sanitizeItems(prs, input.limit)
        };
      }
    }
  };
}

function sanitizeItems(
  items: Array<{ title: string; html_url: string }>,
  limit = 10
) {
  return items.slice(0, limit).map((item) => ({
    title: item.title,
    url: item.html_url
  }));
}

function normalizePullRequestListInput(
  input: GitHubPullRequestListInput | undefined
): Required<GitHubPullRequestListInput> {
  return {
    limit: normalizeLimit(input?.limit),
    state: input?.state ?? "open",
    sort: input?.sort ?? "updated",
    order: input?.order ?? "desc"
  };
}

function normalizeLimit(value: number | undefined): number {
  if (!Number.isInteger(value) || value === undefined || value <= 0) {
    return 10;
  }
  return Math.min(value, 20);
}
