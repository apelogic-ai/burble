import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config";
import {
  buildJiraOAuthUrl,
  createJiraIssue,
  editJiraIssue,
  exchangeJiraCode,
  getJiraUser,
  listAssignedJiraIssues,
  listVisibleJiraProjects,
  refreshJiraAccessToken,
  searchJiraUsers,
  searchJiraIssues
} from "../src/providers/jira/client";

const config: Config = {
  slackBotToken: "xoxb-test",
  slackAppToken: "xapp-test",
  slackClientId: null,
  slackClientSecret: null,
  slackRedirectUri: "https://example.ngrok-free.app/oauth/slack/callback",
  githubClientId: "github-client-id",
  githubClientSecret: "github-client-secret",
  jiraClientId: "jira-client-id",
  jiraClientSecret: "jira-client-secret",
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
  taskWorkflowAuthority: "off",
  taskWorkflowShadowEnabled: false,
  taskWorkflowShadowDatabasePath: null,
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
    expect(url.searchParams.get("scope")).toBe(
      "read:jira-user read:jira-work write:jira-work offline_access"
    );
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
      return Response.json({
        access_token: "jira-token",
        refresh_token: "jira-refresh-token",
        expires_in: 3600
      });
    }) as typeof fetch;

    try {
      await expect(exchangeJiraCode(config, "code-123")).resolves.toMatchObject({
        accessToken: "jira-token",
        refreshToken: "jira-refresh-token",
        accessTokenExpiresAt: expect.any(String)
      });
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

  test("refreshes an Atlassian access token", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body))
      });
      return Response.json({
        access_token: "new-jira-token",
        refresh_token: "new-jira-refresh-token",
        expires_in: 3600
      });
    }) as typeof fetch;

    try {
      await expect(
        refreshJiraAccessToken(config, "old-refresh-token")
      ).resolves.toMatchObject({
        accessToken: "new-jira-token",
        refreshToken: "new-jira-refresh-token",
        accessTokenExpiresAt: expect.any(String)
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls).toEqual([
      {
        url: "https://auth.atlassian.com/oauth/token",
        body: {
          grant_type: "refresh_token",
          client_id: "jira-client-id",
          client_secret: "jira-client-secret",
          refresh_token: "old-refresh-token"
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
        displayName: "Example User"
      });
    }) as typeof fetch;

    try {
      await expect(getJiraUser("jira-token")).resolves.toEqual({
        accountId: "account-123",
        displayName: "Example User"
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

  test("lists visible Jira projects with create permission and issue types", async () => {
    const urls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      if (String(input).endsWith("/accessible-resources")) {
        return Response.json([
          {
            id: "cloud-123",
            url: "https://acme.atlassian.net",
            scopes: ["read:jira-work", "write:jira-work"]
          }
        ]);
      }

      return Response.json({
        values: [
          {
            id: "10000",
            key: "DM",
            name: "DM Workspace",
            issueTypes: [
              {
                id: "10001",
                name: "Task",
                description: "A unit of work",
                subtask: false
              }
            ]
          }
        ]
      });
    }) as typeof fetch;

    try {
      await expect(
        listVisibleJiraProjects("jira-token", {
          query: " DM ",
          action: "create",
          expandIssueTypes: true
        })
      ).resolves.toEqual([
        {
          id: "10000",
          key: "DM",
          name: "DM Workspace",
          url: "https://acme.atlassian.net/jira/projects/DM",
          issueTypes: [
            {
              id: "10001",
              name: "Task",
              description: "A unit of work",
              subtask: false
            }
          ]
        }
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const url = new URL(urls[1]);
    expect(url.pathname).toBe("/ex/jira/cloud-123/rest/api/3/project/search");
    expect(url.searchParams.get("query")).toBe("DM");
    expect(url.searchParams.get("action")).toBe("create");
    expect(url.searchParams.get("expand")).toBe("issueTypes");
    expect(url.searchParams.get("maxResults")).toBe("20");
  });

  test("searches Jira users by query", async () => {
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

      return Response.json([
        {
          accountId: "acct-example",
          displayName: "Alex Reviewer",
          emailAddress: "alex.reviewer@example.com"
        }
      ]);
    }) as typeof fetch;

    try {
      await expect(searchJiraUsers("jira-token", "alex.reviewer@example.com")).resolves.toEqual([
        {
          accountId: "acct-example",
          displayName: "Alex Reviewer",
          emailAddress: "alex.reviewer@example.com"
        }
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const url = new URL(urls[1]);
    expect(url.pathname).toBe("/ex/jira/cloud-123/rest/api/3/user/search");
    expect(url.searchParams.get("query")).toBe("alex.reviewer@example.com");
    expect(url.searchParams.get("maxResults")).toBe("10");
  });

  test("creates Jira issues with REST fields", async () => {
    const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined
      });
      if (String(input).endsWith("/accessible-resources")) {
        return Response.json([
          {
            id: "cloud-123",
            url: "https://acme.atlassian.net",
            scopes: ["read:jira-work", "write:jira-work"]
          }
        ]);
      }

      return Response.json({ key: "DM-100" }, { status: 201 });
    }) as typeof fetch;

    try {
      await expect(
        createJiraIssue("jira-token", {
          projectKey: "DM",
          issueTypeName: "Task",
          summary: "test ticket from slack",
          description: "created from Slack",
          assigneeAccountId: "acct-example"
        })
      ).resolves.toEqual({
        key: "DM-100",
        summary: "test ticket from slack",
        url: "https://acme.atlassian.net/browse/DM-100"
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls[1]).toMatchObject({
      url: "https://api.atlassian.com/ex/jira/cloud-123/rest/api/3/issue",
      method: "POST",
      body: {
        fields: {
          project: { key: "DM" },
          summary: "test ticket from slack",
          issuetype: { name: "Task" },
          assignee: { id: "acct-example" }
        }
      }
    });
    expect(calls[1].body).toHaveProperty("fields.description.type", "doc");
  });

  test("edits Jira issues with REST fields", async () => {
    const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined
      });
      if (String(input).endsWith("/accessible-resources")) {
        return Response.json([
          {
            id: "cloud-123",
            url: "https://acme.atlassian.net",
            scopes: ["read:jira-work", "write:jira-work"]
          }
        ]);
      }

      return new Response(null, { status: 204 });
    }) as typeof fetch;

    try {
      await expect(
        editJiraIssue("jira-token", {
          issueKey: "DM-100",
          summary: "updated title",
          assigneeAccountId: null
        })
      ).resolves.toEqual({
        key: "DM-100",
        summary: "updated title",
        url: "https://acme.atlassian.net/browse/DM-100"
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls[1]).toEqual({
      url: "https://api.atlassian.com/ex/jira/cloud-123/rest/api/3/issue/DM-100",
      method: "PUT",
      body: {
        fields: {
          summary: "updated title",
          assignee: null
        }
      }
    });
  });
});
