import type { Config } from "./config";

export type GitHubUser = {
  login: string;
};

export type GitHubIssue = {
  html_url: string;
  title: string;
};

type GitHubSearchResponse = {
  items?: GitHubIssue[];
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
  const url = new URL("https://api.github.com/search/issues");
  url.searchParams.set("q", "is:open is:issue assignee:@me");
  url.searchParams.set("per_page", "10");

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
