import type { Config } from "./config";

export type GitHubUser = {
  login: string;
};

export type GitHubIssue = {
  html_url: string;
  title: string;
};

export type GitHubPullRequest = {
  html_url: string;
  title: string;
};

export type GitHubCreatedIssue = {
  html_url: string;
  title: string;
  number: number;
};

export type GitHubCreatedComment = {
  html_url: string;
  id: number;
};

export type GitHubCreatedPullRequest = {
  html_url: string;
  title: string;
  number: number;
  draft?: boolean;
};

export type GitHubUpdatedPullRequest = {
  html_url: string;
  title: string;
  number: number;
  draft?: boolean;
};

export type GitHubLabelMutationResult = {
  html_url: string;
  number: number;
};

export type GitHubReviewRequestResult = {
  html_url: string;
  title: string;
  number: number;
};

export type GitHubSearchSort = "created" | "updated" | "comments";
export type GitHubSearchOrder = "asc" | "desc";
export type GitHubPullRequestState = "open" | "closed" | "all";

export type GitHubSearchOptions = {
  perPage?: number;
  sort?: GitHubSearchSort;
  order?: GitHubSearchOrder;
};

export type ListMyPullRequestsOptions = {
  limit?: number;
  state?: GitHubPullRequestState;
  sort?: GitHubSearchSort;
  order?: GitHubSearchOrder;
};

type GitHubSearchResponse = {
  items?: GitHubIssue[];
  message?: string;
};

type GitHubApiErrorBody = {
  message?: string;
};

function githubHeaders(token?: string): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "burble-slack-tui-poc",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}

export function buildGitHubOAuthUrl(config: Config, state: string): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", config.githubClientId);
  url.searchParams.set("redirect_uri", `${config.baseUrl}/oauth/github/callback`);
  url.searchParams.set("scope", "repo read:user user:email");
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeGitHubCode(
  config: Config,
  code: string,
  state: string
): Promise<string> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "burble-slack-tui-poc"
    },
    body: JSON.stringify({
      client_id: config.githubClientId,
      client_secret: config.githubClientSecret,
      code,
      state
    })
  });

  const body = (await response.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || !body.access_token) {
    throw new Error(
      body.error_description ?? body.error ?? "GitHub token exchange failed"
    );
  }

  return body.access_token;
}

export async function getGitHubUser(token: string): Promise<GitHubUser> {
  const response = await fetch("https://api.github.com/user", {
    headers: githubHeaders(token)
  });

  if (!response.ok) {
    throw new Error(`GitHub user lookup failed with ${response.status}`);
  }

  return (await response.json()) as GitHubUser;
}

export async function listAssignedIssues(token: string): Promise<GitHubIssue[]> {
  return searchIssues(token, "is:open is:issue assignee:@me");
}

export async function searchIssues(
  token: string,
  query: string,
  options: GitHubSearchOptions = {}
): Promise<GitHubIssue[]> {
  const url = new URL("https://api.github.com/search/issues");
  url.searchParams.set("q", query);
  url.searchParams.set("per_page", String(clampPositiveInteger(options.perPage, 10, 100)));
  if (options.sort) {
    url.searchParams.set("sort", options.sort);
  }
  if (options.order) {
    url.searchParams.set("order", options.order);
  }

  const response = await fetch(url, {
    headers: githubHeaders(token)
  });

  if (response.status === 401) {
    throw new Error("GITHUB_TOKEN_REJECTED");
  }

  const body = (await response.json()) as GitHubSearchResponse;
  if (!response.ok) {
    throw new Error(body.message ?? `GitHub issue search failed with ${response.status}`);
  }

  return body.items ?? [];
}

export async function listMyPullRequests(
  token: string,
  options: ListMyPullRequestsOptions = {}
): Promise<GitHubPullRequest[]> {
  const state = options.state ?? "open";
  const queryParts = ["is:pr", "author:@me"];
  if (state !== "all") {
    queryParts.push(`is:${state}`);
  }

  const items = await searchIssues(token, queryParts.join(" "), {
    perPage: clampPositiveInteger(options.limit, 10, 20),
    sort: options.sort ?? "updated",
    order: options.order ?? "desc"
  });
  return items.map((item) => ({
    html_url: item.html_url,
    title: item.title
  }));
}

export async function createGitHubIssue(
  token: string,
  input: {
    repo: string;
    title: string;
    body?: string;
    labels?: string[];
    assignees?: string[];
  }
): Promise<GitHubCreatedIssue> {
  const repo = parseGitHubRepo(input.repo);
  const body = await githubJson<GitHubCreatedIssue>(
    token,
    `https://api.github.com/repos/${repo}/issues`,
    {
      method: "POST",
      body: {
        title: input.title,
        ...(input.body ? { body: input.body } : {}),
        ...(input.labels?.length ? { labels: input.labels } : {}),
        ...(input.assignees?.length ? { assignees: input.assignees } : {})
      }
    },
    "GitHub issue creation failed"
  );
  return {
    html_url: body.html_url,
    title: body.title,
    number: body.number
  };
}

export async function commentOnGitHubIssueOrPullRequest(
  token: string,
  input: { repo: string; number: number; body: string }
): Promise<GitHubCreatedComment> {
  const repo = parseGitHubRepo(input.repo);
  const body = await githubJson<GitHubCreatedComment>(
    token,
    `https://api.github.com/repos/${repo}/issues/${input.number}/comments`,
    {
      method: "POST",
      body: { body: input.body }
    },
    "GitHub comment creation failed"
  );
  return {
    html_url: body.html_url,
    id: body.id
  };
}

export async function createGitHubPullRequest(
  token: string,
  input: {
    repo: string;
    title: string;
    head: string;
    base: string;
    body?: string;
    draft?: boolean;
  }
): Promise<GitHubCreatedPullRequest> {
  const repo = parseGitHubRepo(input.repo);
  const body = await githubJson<GitHubCreatedPullRequest>(
    token,
    `https://api.github.com/repos/${repo}/pulls`,
    {
      method: "POST",
      body: {
        title: input.title,
        head: input.head,
        base: input.base,
        ...(input.body ? { body: input.body } : {}),
        ...(input.draft !== undefined ? { draft: input.draft } : {})
      }
    },
    "GitHub pull request creation failed"
  );
  return {
    html_url: body.html_url,
    title: body.title,
    number: body.number,
    ...(body.draft !== undefined ? { draft: body.draft } : {})
  };
}

export async function updateGitHubPullRequest(
  token: string,
  input: {
    repo: string;
    number: number;
    title?: string;
    body?: string;
    base?: string;
    draft?: boolean;
  }
): Promise<GitHubUpdatedPullRequest> {
  const repo = parseGitHubRepo(input.repo);
  const metadataBody = {
    ...(input.title ? { title: input.title } : {}),
    ...(input.body !== undefined ? { body: input.body } : {}),
    ...(input.base ? { base: input.base } : {})
  };
  let pullRequest = await githubJson<
    GitHubUpdatedPullRequest & { node_id?: string }
  >(
    token,
    `https://api.github.com/repos/${repo}/pulls/${input.number}`,
    {
      method: Object.keys(metadataBody).length ? "PATCH" : "GET",
      ...(Object.keys(metadataBody).length ? { body: metadataBody } : {})
    },
    "GitHub pull request update failed"
  );

  if (
    input.draft !== undefined &&
    pullRequest.node_id &&
    pullRequest.draft !== input.draft
  ) {
    pullRequest = await setGitHubPullRequestDraftState(
      token,
      pullRequest.node_id,
      input.draft
    );
  }

  return {
    html_url: pullRequest.html_url,
    title: pullRequest.title,
    number: pullRequest.number,
    ...(pullRequest.draft !== undefined ? { draft: pullRequest.draft } : {})
  };
}

export async function addGitHubIssueLabels(
  token: string,
  input: { repo: string; number: number; labels: string[] }
): Promise<GitHubLabelMutationResult> {
  const repo = parseGitHubRepo(input.repo);
  await githubJson<unknown>(
    token,
    `https://api.github.com/repos/${repo}/issues/${input.number}/labels`,
    {
      method: "POST",
      body: { labels: input.labels }
    },
    "GitHub label add failed"
  );
  return issueUrlResult(input.repo, input.number);
}

export async function removeGitHubIssueLabels(
  token: string,
  input: { repo: string; number: number; labels: string[] }
): Promise<GitHubLabelMutationResult> {
  const repo = parseGitHubRepo(input.repo);
  await Promise.all(
    input.labels.map((label) =>
      githubJson<unknown>(
        token,
        `https://api.github.com/repos/${repo}/issues/${input.number}/labels/${encodeURIComponent(label)}`,
        { method: "DELETE" },
        "GitHub label removal failed"
      )
    )
  );
  return issueUrlResult(input.repo, input.number);
}

export async function requestGitHubPullRequestReview(
  token: string,
  input: {
    repo: string;
    number: number;
    reviewers?: string[];
    teamReviewers?: string[];
  }
): Promise<GitHubReviewRequestResult> {
  const repo = parseGitHubRepo(input.repo);
  const body = await githubJson<GitHubReviewRequestResult>(
    token,
    `https://api.github.com/repos/${repo}/pulls/${input.number}/requested_reviewers`,
    {
      method: "POST",
      body: {
        ...(input.reviewers?.length ? { reviewers: input.reviewers } : {}),
        ...(input.teamReviewers?.length
          ? { team_reviewers: input.teamReviewers }
          : {})
      }
    },
    "GitHub review request failed"
  );
  return {
    html_url: body.html_url,
    title: body.title,
    number: body.number
  };
}

function clampPositiveInteger(
  value: number | undefined,
  fallback: number,
  max: number
): number {
  if (!Number.isInteger(value) || value === undefined || value <= 0) {
    return fallback;
  }
  return Math.min(value, max);
}

function parseGitHubRepo(repo: string): string {
  const trimmed = repo.trim().replace(/^https:\/\/github\.com\//, "");
  const parts = trimmed.split("/").filter(Boolean);
  if (parts.length !== 2) {
    throw new Error("GitHub repo must be in owner/name format");
  }
  return `${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}`;
}

async function githubJson<T>(
  token: string,
  url: string,
  input: { method: string; body?: unknown },
  message: string
): Promise<T> {
  const response = await fetch(url, {
    method: input.method,
    headers: {
      ...githubHeaders(token),
      ...(input.body === undefined ? {} : { "Content-Type": "application/json" })
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) })
  });

  const body = (await readGitHubJson(response)) as T & GitHubApiErrorBody;
  if (!response.ok) {
    throw new Error(body.message ?? `${message} with ${response.status}`);
  }
  return body;
}

async function readGitHubJson(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return {};
  }
  return response.json();
}

async function setGitHubPullRequestDraftState(
  token: string,
  pullRequestId: string,
  draft: boolean
): Promise<GitHubUpdatedPullRequest & { node_id?: string }> {
  const mutation = draft
    ? `mutation($pullRequestId: ID!) {
        convertPullRequestToDraft(input: { pullRequestId: $pullRequestId }) {
          pullRequest {
            id
            number
            title
            url
            isDraft
          }
        }
      }`
    : `mutation($pullRequestId: ID!) {
        markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
          pullRequest {
            id
            number
            title
            url
            isDraft
          }
        }
      }`;
  const result = await githubJson<{
    data?: {
      convertPullRequestToDraft?: {
        pullRequest?: {
          id: string;
          number: number;
          title: string;
          url: string;
          isDraft: boolean;
        };
      };
      markPullRequestReadyForReview?: {
        pullRequest?: {
          id: string;
          number: number;
          title: string;
          url: string;
          isDraft: boolean;
        };
      };
    };
    errors?: Array<{ message?: string }>;
  }>(
    token,
    "https://api.github.com/graphql",
    {
      method: "POST",
      body: {
        query: mutation,
        variables: { pullRequestId }
      }
    },
    "GitHub pull request draft update failed"
  );

  if (result.errors?.length) {
    throw new Error(
      result.errors[0]?.message ?? "GitHub pull request draft update failed"
    );
  }
  const pullRequest =
    result.data?.convertPullRequestToDraft?.pullRequest ??
    result.data?.markPullRequestReadyForReview?.pullRequest;
  if (!pullRequest) {
    throw new Error("GitHub pull request draft update failed");
  }
  return {
    html_url: pullRequest.url,
    title: pullRequest.title,
    number: pullRequest.number,
    draft: pullRequest.isDraft,
    node_id: pullRequest.id
  };
}

function issueUrlResult(repo: string, number: number): GitHubLabelMutationResult {
  const trimmed = repo.trim().replace(/^https:\/\/github\.com\//, "");
  return {
    html_url: `https://github.com/${trimmed}/issues/${number}`,
    number
  };
}
