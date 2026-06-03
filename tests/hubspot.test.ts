import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config";
import {
  buildHubSpotOAuthUrl,
  exchangeHubSpotCode,
  getHubSpotAccessTokenInfo,
  searchHubSpotContacts
} from "../src/providers/hubspot/client";

const config: Config = {
  slackBotToken: "xoxb-test",
  slackAppToken: "xapp-test",
  slackClientId: null,
  slackClientSecret: null,
  slackRedirectUri: "https://example.ngrok-free.app/oauth/slack/callback",
  githubClientId: "github-client-id",
  githubClientSecret: "github-client-secret",
  jiraClientId: null,
  jiraClientSecret: null,
  googleClientId: null,
  googleClientSecret: null,
  hubspotClientId: "hubspot-client-id",
  hubspotClientSecret: "hubspot-client-secret",
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
  atlassianMcpUrl: "https://mcp.atlassian.com/v1/mcp",
  runtimeJwtIssuer: "https://example.ngrok-free.app",
  runtimeJwtPrivateKeyPath: null,
  openClawConfigPatchHostPath: null,
  internalApiToken: null,
  observabilityJsonlPath: null,
  observabilityJsonlDir: null,
  observabilityIncludeContent: false,
  aiModel: "openai:gpt-5.4"
};

describe("buildHubSpotOAuthUrl", () => {
  test("builds an authorize URL with CRM read scopes", () => {
    const url = new URL(buildHubSpotOAuthUrl(config, "state-123"));

    expect(url.origin).toBe("https://app.hubspot.com");
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("hubspot-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://example.ngrok-free.app/oauth/hubspot/callback"
    );
    expect(url.searchParams.get("state")).toBe("state-123");
    expect(url.searchParams.get("scope")).toContain("oauth");
    expect(url.searchParams.get("scope")).toContain(
      "crm.objects.contacts.read"
    );
    expect(url.searchParams.get("scope")).toContain(
      "crm.objects.companies.read"
    );
    expect(url.searchParams.get("scope")).toContain("crm.objects.deals.read");
  });
});

describe("HubSpot OAuth and API helpers", () => {
  test("exchanges an OAuth code", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe("https://api.hubapi.com/oauth/v1/token");
      expect(init?.method).toBe("POST");
      const body = init?.body as URLSearchParams;
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("code-123");
      expect(body.get("redirect_uri")).toBe(
        "https://example.ngrok-free.app/oauth/hubspot/callback"
      );
      return Response.json({
        access_token: "hubspot-token",
        refresh_token: "hubspot-refresh",
        expires_in: 3600
      });
    }) as typeof fetch;

    try {
      const token = await exchangeHubSpotCode(config, "code-123");
      expect(token.accessToken).toBe("hubspot-token");
      expect(token.refreshToken).toBe("hubspot-refresh");
      expect(typeof token.accessTokenExpiresAt).toBe("string");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("reads access token account info", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe(
        "https://api.hubapi.com/oauth/v1/access-tokens/hubspot-token"
      );
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer hubspot-token"
      );
      return Response.json({
        hub_id: 12345,
        hub_domain: "example.hubspot.com",
        user: "hubspot-user@example.com",
        user_id: 789,
        scopes: ["crm.objects.contacts.read"]
      });
    }) as typeof fetch;

    try {
      await expect(getHubSpotAccessTokenInfo("hubspot-token")).resolves.toEqual({
        hubId: 12345,
        hubDomain: "example.hubspot.com",
        user: "hubspot-user@example.com",
        userId: 789,
        scopes: ["crm.objects.contacts.read"]
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("searches contacts with sanitized CRM properties", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe(
        "https://api.hubapi.com/crm/v3/objects/contacts/search"
      );
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer hubspot-token"
      );
      expect(JSON.parse(String(init?.body))).toMatchObject({
        query: "Acme",
        limit: 5,
        properties: expect.arrayContaining(["email"])
      });
      return Response.json({
        results: [
          {
            id: "123",
            properties: {
              email: "person@example.com",
              firstname: "Person",
              invalid: 99
            },
            createdAt: "2026-06-01T00:00:00.000Z"
          }
        ]
      });
    }) as typeof fetch;

    try {
      await expect(
        searchHubSpotContacts("hubspot-token", { query: "Acme", limit: 5 })
      ).resolves.toEqual([
        {
          id: "123",
          properties: {
            email: "person@example.com",
            firstname: "Person"
          },
          createdAt: "2026-06-01T00:00:00.000Z"
        }
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
