import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config";
import {
  buildJiraOAuthUrl,
  exchangeJiraCode,
  getJiraUser,
  listAssignedJiraIssues,
  searchJiraIssues
} from "../src/jira";

const config: Config = {
  slackBotToken: "xoxb-test",
  slackAppToken: "xapp-test",
  githubClientId: "github-client-id",
  githubClientSecret: "github-client-secret",
  jiraClientId: "jira-client-id",
  jiraClientSecret: "jira-client-secret",
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
  runtimeJwtIssuer: "https://example.ngrok-free.app",
  runtimeJwtPrivateKeyPath: null,
  openClawConfigPatchHostPath: null,
  internalApiToken: null,
  aiModel: "openai:gpt-5.4"
};

describe("buildJiraOAuthUrl", () => {
  test("builds an Atlassian authorize URL with callback, scopes, and state", () => {
    const url = new URL(buildJiraOAuthUrl(config, "state-123"));

    expect(url.origin).toBe("https://auth.atlassian.com");
    expect(url.pathname).toBe("/authorize");
    expect(url.searchParams.get("audience")).toBe("api.atlassian.com");
    expect(url.searchParams.get("client_id")).toBe("jira-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://example.ngrok-free.app/oauth/jira/callback"
    );
    expect(url.searchParams.get("scope")).toBe("read:jira-user read:jira-work");
    expect(url.searchParams.get("state")).toBe("state-123");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });

  test("rejects missing Jira OAuth settings", () => {
    expect(() =>
      buildJiraOAuthUrl({ ...config, jiraClientId: null }, "state-123")
    ).toThrow("Jira OAuth is not configured");
  });
});

describe("Jira OAuth and REST helpers", () => {
  test("exchanges an authorization code for an Atlassian access token", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body))
      });
      return Response.json({ access_token: "jira-token" });
    }) as typeof fetch;

    try {
      await expect(exchangeJiraCode(config, "code-123")).resolves.toBe(
        "jira-token"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls).toEqual([
      {
        url: "https://auth.atlassian.com/oauth/token",
        body: {
          grant_type: "authorization_code",
          client_id: "jira-client-id",
          client_secret: "jira-client-secret",
          code: "code-123",
          redirect_uri: "https://example.ngrok-free.app/oauth/jira/callback"
        }
      }
    ]);
  });

  test("loads the Jira user from the first accessible Jira resource", async () => {
    const urls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      if (String(input).endsWith("/accessible-resources")) {
        return Response.json([
          {
            id: "cloud-123",
            url: "https://acme.atlassian.net",
            scopes: ["read:jira-user", "read:jira-work"]
          }
        ]);
      }

      return Response.json({
        accountId: "account-123",
        displayName: "Leo"
      });
    }) as typeof fetch;

    try {
      await expect(getJiraUser("jira-token")).resolves.toEqual({
        accountId: "account-123",
        displayName: "Leo"
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(urls).toEqual([
      "https://api.atlassian.com/oauth/token/accessible-resources",
      "https://api.atlassian.com/ex/jira/cloud-123/rest/api/3/myself"
    ]);
  });

  test("searches Jira issues and formats browse URLs", async () => {
    const urls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      if (String(input).endsWith("/accessible-resources")) {
        return Response.json([
          {
            id: "cloud-123",
            url: "https://acme.atlassian.net",
            scopes: ["read:jira-work"]
          }
        ]);
      }

      return Response.json({
        issues: [
          {
            key: "ENG-7",
            fields: {
              summary: "Fix deploy dashboard",
              status: { name: "In Progress" }
            }
          }
        ]
      });
    }) as typeof fetch;

    try {
      await expect(searchJiraIssues("jira-token", "text ~ \"deploy\"")).resolves.toEqual([
        {
          key: "ENG-7",
          summary: "Fix deploy dashboard",
          url: "https://acme.atlassian.net/browse/ENG-7",
          status: "In Progress"
        }
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const url = new URL(urls[1]);
    expect(url.pathname).toBe("/ex/jira/cloud-123/rest/api/3/search/jql");
    expect(url.searchParams.get("jql")).toBe('text ~ "deploy"');
    expect(url.searchParams.get("maxResults")).toBe("10");
    expect(url.searchParams.get("fields")).toBe("summary,status");
  });

  test("listAssignedJiraIssues uses current user assignment JQL", async () => {
    const urls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      if (String(input).endsWith("/accessible-resources")) {
        return Response.json([
          {
            id: "cloud-123",
            url: "https://acme.atlassian.net",
            scopes: ["read:jira-work"]
          }
        ]);
      }

      return Response.json({ issues: [] });
    }) as typeof fetch;

    try {
      await listAssignedJiraIssues("jira-token");
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(new URL(urls[1]).searchParams.get("jql")).toBe(
      "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC"
    );
  });
});
