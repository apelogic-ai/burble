import type { ProviderConnection } from "../db";
import type {
  GitHubCreatedComment,
  GitHubCreatedIssue,
  GitHubCreatedPullRequest,
  GitHubIssue,
  GitHubLabelMutationResult,
  GitHubPullRequest,
  GitHubPullRequestState,
  GitHubReviewRequestResult,
  GitHubSearchOrder,
  GitHubSearchSort,
  GitHubUpdatedPullRequest,
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
  createIssue?: (
    token: string,
    input: GitHubCreateIssueInput
  ) => Promise<GitHubCreatedIssue>;
  commentOnIssueOrPullRequest?: (
    token: string,
    input: GitHubCommentInput
  ) => Promise<GitHubCreatedComment>;
  createPullRequest?: (
    token: string,
    input: GitHubCreatePullRequestInput
  ) => Promise<GitHubCreatedPullRequest>;
  updatePullRequest?: (
    token: string,
    input: GitHubUpdatePullRequestInput
  ) => Promise<GitHubUpdatedPullRequest>;
  addLabels?: (
    token: string,
    input: GitHubLabelsInput
  ) => Promise<GitHubLabelMutationResult>;
  removeLabels?: (
    token: string,
    input: GitHubLabelsInput
  ) => Promise<GitHubLabelMutationResult>;
  requestReview?: (
    token: string,
    input: GitHubRequestReviewInput
  ) => Promise<GitHubReviewRequestResult>;
};

export type GitHubToolContext = {
  connection: ProviderConnection;
};

export type GitHubPullRequestListInput = {
  limit?: number;
  state?: GitHubPullRequestState;
  sort?: GitHubSearchSort;
  order?: GitHubSearchOrder;
  owner?: string;
  repo?: string;
};

export type GitHubCreateIssueInput = {
  repo: string;
  title: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
};

export type GitHubCommentInput = {
  repo: string;
  number: number;
  body: string;
};

export type GitHubCreatePullRequestInput = {
  repo: string;
  title: string;
  head: string;
  base: string;
  body?: string;
  draft?: boolean;
};

export type GitHubUpdatePullRequestInput = {
  repo: string;
  number: number;
  title?: string;
  body?: string;
  base?: string;
  draft?: boolean;
};

export type GitHubLabelsInput = {
  repo: string;
  number: number;
  labels: string[];
};

export type GitHubRequestReviewInput = {
  repo: string;
  number: number;
  reviewers?: string[];
  teamReviewers?: string[];
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
    },

    createIssue: {
      async execute(
        context: GitHubToolContext & { input: GitHubCreateIssueInput }
      ): Promise<ToolResult<{ title: string; url: string; number: number }>> {
        const issue = await requireGitHubWriteTool(
          deps.createIssue,
          "github.createIssue"
        )(
          context.connection.accessToken,
          normalizeCreateIssueInput(context.input)
        );
        return {
          classification: "user_private",
          content: sanitizeNumberedItem(issue)
        };
      }
    },

    commentOnIssueOrPullRequest: {
      async execute(
        context: GitHubToolContext & { input: GitHubCommentInput }
      ): Promise<ToolResult<{ url: string; id: number }>> {
        const comment = await requireGitHubWriteTool(
          deps.commentOnIssueOrPullRequest,
          "github.commentOnIssueOrPullRequest"
        )(
          context.connection.accessToken,
          context.input
        );
        return {
          classification: "user_private",
          content: {
            url: comment.html_url,
            id: comment.id
          }
        };
      }
    },

    createPullRequest: {
      async execute(
        context: GitHubToolContext & { input: GitHubCreatePullRequestInput }
      ): Promise<
        ToolResult<{ title: string; url: string; number: number; draft?: boolean }>
      > {
        const pullRequest = await requireGitHubWriteTool(
          deps.createPullRequest,
          "github.createPullRequest"
        )(
          context.connection.accessToken,
          context.input
        );
        return {
          classification: "user_private",
          content: sanitizeNumberedItem(pullRequest)
        };
      }
    },

    updatePullRequest: {
      async execute(
        context: GitHubToolContext & { input: GitHubUpdatePullRequestInput }
      ): Promise<
        ToolResult<{ title: string; url: string; number: number; draft?: boolean }>
      > {
        const pullRequest = await requireGitHubWriteTool(
          deps.updatePullRequest,
          "github.updatePullRequest"
        )(
          context.connection.accessToken,
          context.input
        );
        return {
          classification: "user_private",
          content: sanitizeNumberedItem(pullRequest)
        };
      }
    },

    addLabels: {
      async execute(
        context: GitHubToolContext & { input: GitHubLabelsInput }
      ): Promise<ToolResult<{ url: string; number: number }>> {
        const issue = await requireGitHubWriteTool(
          deps.addLabels,
          "github.addLabels"
        )(
          context.connection.accessToken,
          context.input
        );
        return {
          classification: "user_private",
          content: sanitizeIssueMutation(issue)
        };
      }
    },

    removeLabels: {
      async execute(
        context: GitHubToolContext & { input: GitHubLabelsInput }
      ): Promise<ToolResult<{ url: string; number: number }>> {
        const issue = await requireGitHubWriteTool(
          deps.removeLabels,
          "github.removeLabels"
        )(
          context.connection.accessToken,
          context.input
        );
        return {
          classification: "user_private",
          content: sanitizeIssueMutation(issue)
        };
      }
    },

    requestReview: {
      async execute(
        context: GitHubToolContext & { input: GitHubRequestReviewInput }
      ): Promise<ToolResult<{ title: string; url: string; number: number }>> {
        const pullRequest = await requireGitHubWriteTool(
          deps.requestReview,
          "github.requestReview"
        )(
          context.connection.accessToken,
          context.input
        );
        return {
          classification: "user_private",
          content: sanitizeNumberedItem(pullRequest)
        };
      }
    }
  };
}

function requireGitHubWriteTool<T extends (...args: never[]) => unknown>(
  fn: T | undefined,
  toolName: string
): T {
  if (!fn) {
    throw new Error(`${toolName} is not configured`);
  }
  return fn;
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

function sanitizeNumberedItem(item: {
  title: string;
  html_url: string;
  number: number;
  draft?: boolean;
}) {
  return {
    title: item.title,
    url: item.html_url,
    number: item.number,
    ...(item.draft !== undefined ? { draft: item.draft } : {})
  };
}

function sanitizeIssueMutation(item: { html_url: string; number: number }) {
  return {
    url: item.html_url,
    number: item.number
  };
}

function normalizePullRequestListInput(
  input: GitHubPullRequestListInput | undefined
): GitHubPullRequestListInput & Required<Pick<GitHubPullRequestListInput, "limit" | "state" | "sort" | "order">> {
  return {
    limit: normalizeLimit(input?.limit),
    state: input?.state ?? "open",
    sort: input?.sort ?? "updated",
    order: input?.order ?? "desc",
    ...normalizeGitHubScopeInput(input)
  };
}

function normalizeLimit(value: number | undefined): number {
  if (!Number.isInteger(value) || value === undefined || value <= 0) {
    return 10;
  }
  return Math.min(value, 20);
}

function normalizeGitHubScopeInput(
  input: GitHubPullRequestListInput | undefined
): Pick<GitHubPullRequestListInput, "owner" | "repo"> {
  const repo = normalizeGitHubQualifier(input?.repo, true);
  if (repo) {
    return { repo };
  }

  const owner = normalizeGitHubQualifier(input?.owner, false);
  return owner ? { owner } : {};
}

function normalizeGitHubQualifier(
  value: string | undefined,
  allowRepo: boolean
): string | null {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }
  const pattern = allowRepo
    ? /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
    : /^[A-Za-z0-9_.-]+$/;
  return pattern.test(normalized) ? normalized : null;
}

function normalizeCreateIssueInput(
  input: GitHubCreateIssueInput
): GitHubCreateIssueInput {
  return {
    repo: input.repo,
    title: input.title,
    ...(input.body ? { body: input.body } : {}),
    ...(input.labels?.length ? { labels: input.labels } : {}),
    ...(input.assignees?.length ? { assignees: input.assignees } : {})
  };
}
