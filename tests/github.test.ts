import { describe, expect, test } from "bun:test";
import {
  buildGitHubOAuthUrl,
  addGitHubIssueLabels,
  commentOnGitHubIssueOrPullRequest,
  createGitHubIssue,
  createGitHubPullRequest,
  listAssignedIssues,
  listMyPullRequests,
  removeGitHubIssueLabels,
  requestGitHubPullRequestReview,
  searchIssues,
  updateGitHubPullRequest
} from "../src/providers/github/client";
import type { Config } from "../src/config";

const config: Config = {
  slackBotToken: "xoxb-test",
  slackAppToken: "xapp-test",
  slackClientId: null,
  slackClientSecret: null,
  slackRedirectUri: "https://example.ngrok-free.app/oauth/slack/callback",
  githubClientId: "client-id",
  githubClientSecret: "client-secret",
  jiraClientId: null,
  jiraClientSecret: null,
  googleClientId: null,
  googleClientSecret: null,
  hubspotClientId: null,
  hubspotClientSecret: null,
  baseUrl: "https://example.ngrok-free.app",
  port: 3000,
  databasePath: ":memory:",
  slackLogLevel: "info",
  agentMode: "deterministic",
  agentFastTrack: false,
  agentRuntime: "ai-sdk",
  agentRuntimeFactory: "static",
  managedRuntimeUrl: null,
  openClawNemoClawUrl: null,
  agentRuntimeEngine: "openclaw",
  openClawNemoClawEngine: "openclaw",
  agentRuntimeDataRoot: "/data/runtimes",
  agentRuntimeDockerNetwork: "compose_default",
  agentRuntimeImage: "burble-openclaw-nemoclaw:dev",
  agentRuntimeIdleTtlMs: 86400000,
  agentRuntimeReaperEnabled: true,
  agentRuntimeReaperIntervalMs: 60000,
  agentRuntimeJwtTtlSeconds: 604800,
  agentRuntimeTokenSecret: null,
  agentRuntimeToolGatewayUrl: "http://burble-app:3000/internal/tools",
  agentRuntimeMcpGatewayUrl: null,
  agentRuntimeMcpAudience: null,
  agentRuntimeSandboxUrl: null,
  agentRuntimeSandboxToken: null,
  agentRuntimeSandboxStartCommand: null,
  atlassianMcpUrl: "https://mcp.atlassian.com/v1/mcp",
  runtimeJwtIssuer: "https://example.ngrok-free.app",
  runtimeJwtPrivateKeyPath: null,
  openClawConfigPatchHostPath: null,
  internalApiToken: null,
  observabilityJsonlPath: null,
  observabilityJsonlDir: null,
  observabilityIncludeContent: false,
  taskWorkflowShadowEnabled: false,
  taskWorkflowShadowDatabasePath: null,
  aiModel: "openai:gpt-5.4"
};

describe("buildGitHubOAuthUrl", () => {
  test("builds an authorize URL with callback, scopes, and state", () => {
    const url = new URL(buildGitHubOAuthUrl(config, "state-123"));

    expect(url.origin).toBe("https://github.com");
    expect(url.pathname).toBe("/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://example.ngrok-free.app/oauth/github/callback"
    );
    expect(url.searchParams.get("scope")).toBe("repo read:user user:email");
    expect(url.searchParams.get("state")).toBe("state-123");
  });
});

describe("GitHub search helpers", () => {
  test("listAssignedIssues searches open issues assigned to the token owner", async () => {
    const urls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return Response.json({ items: [] });
    }) as typeof fetch;

    try {
      await listAssignedIssues("token");
    } finally {
      globalThis.fetch = originalFetch;
    }

    const url = new URL(urls[0]);
    expect(url.searchParams.get("q")).toBe("is:open is:issue assignee:@me");
    expect(url.searchParams.get("per_page")).toBe("10");
  });

  test("searchIssues passes through caller query", async () => {
    const urls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return Response.json({ items: [] });
    }) as typeof fetch;

    try {
      await searchIssues("token", "repo:acme/app label:billing");
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(new URL(urls[0]).searchParams.get("q")).toBe(
      "repo:acme/app label:billing"
    );
  });

  test("listMyPullRequests searches open pull requests authored by the user", async () => {
    const urls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return Response.json({ items: [] });
    }) as typeof fetch;

    try {
      await listMyPullRequests("token");
    } finally {
      globalThis.fetch = originalFetch;
    }

    const url = new URL(urls[0]);
    expect(url.searchParams.get("q")).toBe("is:pr author:@me is:open");
    expect(url.searchParams.get("per_page")).toBe("10");
    expect(url.searchParams.get("sort")).toBe("updated");
    expect(url.searchParams.get("order")).toBe("desc");
  });

  test("listMyPullRequests accepts limit, state, sort, and order", async () => {
    const urls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return Response.json({ items: [] });
    }) as typeof fetch;

    try {
      await listMyPullRequests("token", {
        limit: 3,
        state: "closed",
        sort: "created",
        order: "asc"
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const url = new URL(urls[0]);
    expect(url.searchParams.get("q")).toBe("is:pr author:@me is:closed");
    expect(url.searchParams.get("per_page")).toBe("3");
    expect(url.searchParams.get("sort")).toBe("created");
    expect(url.searchParams.get("order")).toBe("asc");
  });

  test("listMyPullRequests scopes searches to owner or repo", async () => {
    const urls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return Response.json({ items: [] });
    }) as typeof fetch;

    try {
      await listMyPullRequests("token", {
        owner: "example-org",
        limit: 1
      });
      await listMyPullRequests("token", {
        owner: "ignored-owner",
        repo: "acme/app",
        limit: 1
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(new URL(urls[0]).searchParams.get("q")).toBe(
      "is:pr author:@me org:example-org is:open"
    );
    expect(new URL(urls[1]).searchParams.get("q")).toBe(
      "is:pr author:@me repo:acme/app is:open"
    );
  });
});

describe("GitHub write helpers", () => {
  test("createGitHubIssue posts a sanitized issue payload", async () => {
    const requests: Request[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json({
        html_url: "https://github.com/acme/app/issues/7",
        title: "New issue",
        number: 7
      });
    }) as typeof fetch;

    try {
      const issue = await createGitHubIssue("token", {
        repo: "acme/app",
        title: "New issue",
        body: "Body",
        labels: ["bug"],
        assignees: ["octocat"]
      });

      expect(issue).toEqual({
        html_url: "https://github.com/acme/app/issues/7",
        title: "New issue",
        number: 7
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requests[0].method).toBe("POST");
    expect(requests[0].url).toBe("https://api.github.com/repos/acme/app/issues");
    await expect(requests[0].json()).resolves.toEqual({
      title: "New issue",
      body: "Body",
      labels: ["bug"],
      assignees: ["octocat"]
    });
  });

  test("comments on an issue or pull request", async () => {
    const requests: Request[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json({
        html_url: "https://github.com/acme/app/pull/7#issuecomment-1",
        id: 123
      });
    }) as typeof fetch;

    try {
      await commentOnGitHubIssueOrPullRequest("token", {
        repo: "acme/app",
        number: 7,
        body: "Looks good"
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requests[0].method).toBe("POST");
    expect(requests[0].url).toBe(
      "https://api.github.com/repos/acme/app/issues/7/comments"
    );
    await expect(requests[0].json()).resolves.toEqual({
      body: "Looks good"
    });
  });

  test("creates and updates pull request metadata", async () => {
    const requests: Request[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url.endsWith("/pulls")) {
        return Response.json({
          html_url: "https://github.com/acme/app/pull/8",
          title: "New PR",
          number: 8,
          draft: true
        });
      }
      return Response.json({
        html_url: "https://github.com/acme/app/pull/8",
        title: "Updated PR",
        number: 8,
        draft: false
      });
    }) as typeof fetch;

    try {
      await createGitHubPullRequest("token", {
        repo: "acme/app",
        title: "New PR",
        head: "feature",
        base: "main",
        draft: true
      });
      await updateGitHubPullRequest("token", {
        repo: "acme/app",
        number: 8,
        title: "Updated PR",
        body: "Updated body"
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requests[0].method).toBe("POST");
    expect(requests[0].url).toBe("https://api.github.com/repos/acme/app/pulls");
    await expect(requests[0].json()).resolves.toEqual({
      title: "New PR",
      head: "feature",
      base: "main",
      draft: true
    });
    expect(requests[1].method).toBe("PATCH");
    expect(requests[1].url).toBe(
      "https://api.github.com/repos/acme/app/pulls/8"
    );
    await expect(requests[1].json()).resolves.toEqual({
      title: "Updated PR",
      body: "Updated body"
    });
  });

  test("adds/removes labels and requests reviewers", async () => {
    const requests: Request[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return Response.json({
        html_url: "https://github.com/acme/app/pull/8",
        title: "New PR",
        number: 8
      });
    }) as typeof fetch;

    try {
      await addGitHubIssueLabels("token", {
        repo: "acme/app",
        number: 8,
        labels: ["ready"]
      });
      await removeGitHubIssueLabels("token", {
        repo: "acme/app",
        number: 8,
        labels: ["wip"]
      });
      await requestGitHubPullRequestReview("token", {
        repo: "acme/app",
        number: 8,
        reviewers: ["octocat"],
        teamReviewers: ["platform"]
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requests[0].method).toBe("POST");
    expect(requests[0].url).toBe(
      "https://api.github.com/repos/acme/app/issues/8/labels"
    );
    await expect(requests[0].json()).resolves.toEqual({ labels: ["ready"] });
    expect(requests[1].method).toBe("DELETE");
    expect(requests[1].url).toBe(
      "https://api.github.com/repos/acme/app/issues/8/labels/wip"
    );
    expect(requests[2].method).toBe("POST");
    expect(requests[2].url).toBe(
      "https://api.github.com/repos/acme/app/pulls/8/requested_reviewers"
    );
    await expect(requests[2].json()).resolves.toEqual({
      reviewers: ["octocat"],
      team_reviewers: ["platform"]
    });
  });
});
