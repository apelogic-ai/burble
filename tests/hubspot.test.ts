import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config";
import {
  buildHubSpotOAuthUrl,
  exchangeHubSpotCode,
  getHubSpotAccessTokenInfo,
  HubSpotApiError,
  searchHubSpotContacts
} from "../src/providers/hubspot/client";
import { createHubSpotTools } from "../src/tools/hubspot";
import type { ProviderConnection } from "../src/db";

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
    const scopes = url.searchParams.get("scope")?.split(" ") ?? [];
    expect(scopes).toHaveLength(61);
    expect(scopes).toContain("oauth");
    expect(scopes).toContain("crm.objects.contacts.read");
    expect(scopes).toContain("crm.objects.companies.read");
    expect(scopes).toContain("crm.objects.deals.read");
    expect(scopes).toContain("crm.objects.custom.read");
    expect(scopes).toContain("settings.users.read");
    expect(scopes).not.toContain("behavioral_events.event_definitions.read");
    expect(scopes).not.toContain("crm.objects.feedback_submission.read");
    expect(scopes).not.toContain("document.read");
    expect(scopes).not.toContain("crm.dealsplits.read");
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

  test("redacts access tokens from account lookup transport errors", async () => {
    const originalFetch = globalThis.fetch;
    const token = "hubspot-token/with-path";
    globalThis.fetch = (async (input, _init): Promise<Response> => {
      throw new Error(`failed to fetch ${String(input)}`);
    }) as typeof fetch;

    try {
      await getHubSpotAccessTokenInfo(token);
      throw new Error("expected getHubSpotAccessTokenInfo to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain("[redacted]");
      expect(message).not.toContain(token);
      expect(message).not.toContain(encodeURIComponent(token));
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

describe("HubSpot tools", () => {
  test("refreshes expiring access tokens before a provider call", async () => {
    const saved: ProviderConnection[] = [];
    const searchedWith: string[] = [];
    const tools = createHubSpotTools({
      searchHubSpotContacts: async (token) => {
        searchedWith.push(token);
        return [];
      },
      searchHubSpotCompanies: async () => [],
      searchHubSpotDeals: async () => [],
      getHubSpotAccessTokenInfo: async () => ({
        hubId: 123,
        scopes: []
      }),
      refreshHubSpotAccessToken: async (refreshToken) => {
        expect(refreshToken).toBe("hubspot-refresh");
        return {
          accessToken: "fresh-token",
          refreshToken,
          accessTokenExpiresAt: "2026-06-03T12:30:00.000Z"
        };
      },
      saveHubSpotConnection: (connection) => saved.push(connection),
      now: () => new Date("2026-06-03T12:00:00.000Z")
    });

    await expect(
      tools.searchContacts.execute({
        connection: hubSpotConnection({
          accessToken: "stale-token",
          refreshToken: "hubspot-refresh",
          accessTokenExpiresAt: "2026-06-03T12:00:30.000Z"
        }),
        input: { query: "Acme" }
      })
    ).resolves.toEqual({
      classification: "user_private",
      content: []
    });
    expect(searchedWith).toEqual(["fresh-token"]);
    expect(saved.map((connection) => connection.accessToken)).toEqual([
      "fresh-token"
    ]);
  });

  test("refreshes once and retries when HubSpot returns 401", async () => {
    const searchedWith: string[] = [];
    const tools = createHubSpotTools({
      searchHubSpotContacts: async (token) => {
        searchedWith.push(token);
        if (token === "expired-token") {
          throw new HubSpotApiError("expired", 401);
        }
        return [];
      },
      searchHubSpotCompanies: async () => [],
      searchHubSpotDeals: async () => [],
      getHubSpotAccessTokenInfo: async () => ({
        hubId: 123,
        scopes: []
      }),
      refreshHubSpotAccessToken: async () => ({
        accessToken: "fresh-token",
        refreshToken: "hubspot-refresh",
        accessTokenExpiresAt: "2026-06-03T12:30:00.000Z"
      }),
      now: () => new Date("2026-06-03T12:00:00.000Z")
    });

    await expect(
      tools.searchContacts.execute({
        connection: hubSpotConnection({
          accessToken: "expired-token",
          refreshToken: "hubspot-refresh",
          accessTokenExpiresAt: "2026-06-03T12:30:00.000Z"
        }),
        input: { query: "Acme" }
      })
    ).resolves.toEqual({
      classification: "user_private",
      content: []
    });
    expect(searchedWith).toEqual(["expired-token", "fresh-token"]);
  });

  test("does not refresh or ask users to reconnect when HubSpot returns 403", async () => {
    let refreshCalls = 0;
    const tools = createHubSpotTools({
      searchHubSpotContacts: async () => {
        throw new HubSpotApiError("missing scope", 403);
      },
      searchHubSpotCompanies: async () => [],
      searchHubSpotDeals: async () => [],
      getHubSpotAccessTokenInfo: async () => ({
        hubId: 123,
        scopes: []
      }),
      refreshHubSpotAccessToken: async () => {
        refreshCalls += 1;
        return {
          accessToken: "fresh-token",
          refreshToken: "hubspot-refresh",
          accessTokenExpiresAt: "2026-06-03T12:30:00.000Z"
        };
      }
    });

    await expect(
      tools.searchContacts.execute({
        connection: hubSpotConnection({
          accessToken: "token-with-missing-scope",
          refreshToken: "hubspot-refresh"
        }),
        input: { query: "Acme" }
      })
    ).resolves.toEqual({
      classification: "user_private",
      content: {
        error: "hubspot_permission_denied",
        message:
          "HubSpot denied this request. Check that the connected HubSpot app has the required CRM read scopes."
      }
    });
    expect(refreshCalls).toBe(0);
  });
});

function hubSpotConnection(
  overrides: Partial<ProviderConnection> = {}
): ProviderConnection {
  return {
    provider: "hubspot",
    email: "person@example.com",
    slackUserId: "U123",
    providerLogin: "hubspot-user@example.com",
    accessToken: "hubspot-token",
    connectedAt: "2026-06-03T12:00:00.000Z",
    ...overrides
  };
}
