import { describe, expect, test } from "bun:test";
import {
  buildGitHubOAuthUrl,
  listAssignedIssues,
  listMyPullRequests,
  searchIssues
} from "../src/github";
import type { Config } from "../src/config";

const config: Config = {
  slackBotToken: "xoxb-test",
  slackAppToken: "xapp-test",
  githubClientId: "client-id",
  githubClientSecret: "client-secret",
  jiraClientId: null,
  jiraClientSecret: null,
  baseUrl: "https://example.ngrok-free.app",
  port: 3000,
  databasePath: ":memory:",
  slackLogLevel: "info",
  agentMode: "deterministic",
  agentRuntime: "ai-sdk",
  agentRuntimeFactory: "static",
  openClawNemoClawUrl: null,
  agentRuntimeDataRoot: "/data/runtimes",
  agentRuntimeDockerNetwork: "compose_default",
  agentRuntimeImage: "burble-openclaw-nemoclaw:dev",
  agentRuntimeIdleTtlMs: 1800000,
  agentRuntimeReaperIntervalMs: 60000,
  agentRuntimeTokenSecret: null,
  agentRuntimeToolGatewayUrl: "http://burble-app:3000/internal/tools",
  agentRuntimeMcpGatewayUrl: null,
  agentRuntimeMcpAudience: null,
  atlassianMcpUrl: "https://mcp.atlassian.com/v1/mcp",
  runtimeJwtIssuer: "https://example.ngrok-free.app",
  runtimeJwtPrivateKeyPath: null,
  openClawConfigPatchHostPath: null,
  internalApiToken: null,
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

    expect(new URL(urls[0]).searchParams.get("q")).toBe(
      "is:open is:pr author:@me"
    );
  });
});
