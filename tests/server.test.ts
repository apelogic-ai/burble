import { describe, expect, spyOn, test } from "bun:test";
import type { Config } from "../src/config";
import type { TokenStore } from "../src/db";
import {
  handleGitHubCallback,
  handleGoogleCallback,
  handleHubSpotCallback,
  handleJiraCallback,
  handleSlackCallback
} from "../src/server";
import type { SlackRuntime } from "../src/slack";

const config: Config = {
  slackBotToken: "xoxb-test",
  slackAppToken: "xapp-test",
  slackClientId: null,
  slackClientSecret: null,
  slackRedirectUri: "https://example.ngrok-free.app/oauth/slack/callback",
  githubClientId: "client-id",
  githubClientSecret: "client-secret",
  jiraClientId: "jira-client-id",
  jiraClientSecret: "jira-client-secret",
  googleClientId: "google-client-id",
  googleClientSecret: "google-client-secret",
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

function createFakeStore() {
  const connectedUsers: unknown[] = [];
  const providerConnections: unknown[] = [];
  const store = {
    createOAuthState: () => "state",
    consumeOAuthState: (state: string) =>
      state === "valid-state"
        ? {
            state,
            slackUserId: "U123",
            expiresAt: new Date(Date.now() + 1000).toISOString()
          }
        : null,
    upsertConnectedUser: (input: unknown) => {
      connectedUsers.push(input);
    },
    upsertProviderConnection: (input: unknown) => {
      providerConnections.push(input);
    },
    getConnectedUserByEmail: () => null,
    getConnection: () => null,
    getConnectionForSlackUser: () => null,
    deleteConnectionForSlackUser: () => false,
    getOrCreateAgentRuntime: () => {
      throw new Error("unexpected agent runtime call");
    },
    getAgentRuntime: () => null,
    getAgentRuntimeForPrincipal: () => null,
    listIdleAgentRuntimes: () => [],
    recordAgentRuntimeEvent: () => undefined,
    listAgentRuntimeEvents: () => [],
    upsertConversationRoute: () => {
      throw new Error("unexpected conversation route write");
    },
    getConversationRoute: () => null,
    getConversationGrantRouteForSlackChannel: () => null,
    recordConversationRouteDeliveryFailure: () => null,
    resetConversationRouteDeliveryFailure: () => null,
    revokeConversationRoutesForDestination: () => 0,
    upsertWorkspacePolicy: () => {
      throw new Error("unexpected workspace policy write");
    },
    getWorkspacePolicy: () => null,
    listWorkspacePolicy: () => [],
    upsertUserPreference: () => {
      throw new Error("unexpected user preference write");
    },
    getUserPreference: () => null,
    listUserPreferences: () => [],
    upsertAgentMemory: () => {
      throw new Error("unexpected agent memory write");
    },
    listAgentMemory: () => [],
    deleteAgentMemory: () => undefined,
    upsertAgentJobState: () => {
      throw new Error("unexpected agent job state write");
    },
    getAgentJobState: () => null,
    listAgentJobStatesForPrincipal: () => [],
    deleteAgentJobState: () => undefined,
    upsertAgentJobCapability: () => {
      throw new Error("unexpected agent job capability write");
    },
    getAgentJobCapability: () => null,
    listAgentJobCapabilitiesForPrincipal: () => [],
    deleteAgentJobCapability: () => undefined,
    upsertSkillCatalog: () => {
      throw new Error("unexpected skill catalog write");
    },
    getSkillCatalog: () => null,
    listSkillCatalog: () => [],
    upsertWorkspaceSkill: () => {
      throw new Error("unexpected workspace skill write");
    },
    listWorkspaceSkills: () => [],
    upsertUserSkill: () => {
      throw new Error("unexpected user skill write");
    },
    listUserSkills: () => [],
    updateAgentRuntimeStatus: () => undefined,
    touchAgentRuntime: () => undefined,
    close: () => undefined
  } as TokenStore;

  return { store, connectedUsers, providerConnections };
}

function createFakeSlack() {
  const messages: unknown[] = [];
  const slack = {
    app: {
      client: {
        chat: {
          postMessage: async (message: unknown) => {
            messages.push(message);
          }
        }
      }
    },
    getSlackEmail: async () => "person@example.com"
  } as unknown as SlackRuntime;

  return { slack, messages };
}

describe("handleGitHubCallback", () => {
  test("rejects missing code or state", async () => {
    const { store } = createFakeStore();
    const { slack } = createFakeSlack();

    const response = await handleGitHubCallback(
      config,
      store,
      slack,
      new URL("https://example.test/oauth/github/callback?state=valid-state"),
      {
        exchangeGitHubCode: async () => "token",
        getGitHubUser: async () => ({ login: "octocat" })
      }
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Missing code or state");
  });

  test("rejects invalid OAuth state before exchanging code", async () => {
    const { store } = createFakeStore();
    const { slack } = createFakeSlack();
    let exchanged = false;

    const response = await handleGitHubCallback(
      config,
      store,
      slack,
      new URL("https://example.test/oauth/github/callback?code=abc&state=bad"),
      {
        exchangeGitHubCode: async () => {
          exchanged = true;
          return "token";
        },
        getGitHubUser: async () => ({ login: "octocat" })
      }
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Invalid or expired OAuth state");
    expect(exchanged).toBe(false);
  });

  test("stores the user connection and DMs Slack on success", async () => {
    const { store, connectedUsers } = createFakeStore();
    const { slack, messages } = createFakeSlack();

    const response = await handleGitHubCallback(
      config,
      store,
      slack,
      new URL(
        "https://example.test/oauth/github/callback?code=abc&state=valid-state"
      ),
      {
        exchangeGitHubCode: async (_config, code, state) => {
          expect(code).toBe("abc");
          expect(state).toBe("valid-state");
          return "gh-token";
        },
        getGitHubUser: async (token) => {
          expect(token).toBe("gh-token");
          return { login: "octocat" };
        }
      }
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Connected. You can close this tab.");
    expect(connectedUsers).toEqual([
      {
        email: "person@example.com",
        slackUserId: "U123",
        githubLogin: "octocat",
        githubToken: "gh-token"
      }
    ]);
    expect(messages).toEqual([
      {
        channel: "U123",
        text: "Connected as `octocat` (person@example.com)."
      }
    ]);
  });
});

describe("handleJiraCallback", () => {
  test("rejects missing code or state", async () => {
    const { store } = createFakeStore();
    const { slack } = createFakeSlack();

    const response = await handleJiraCallback(
      config,
      store,
      slack,
      new URL("https://example.test/oauth/jira/callback?state=valid-state"),
      {
        exchangeJiraCode: async () => ({
          accessToken: "token",
          refreshToken: null,
          accessTokenExpiresAt: null
        }),
        getJiraUser: async () => ({ accountId: "account-123", displayName: "Example User" })
      }
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Missing code or state");
  });

  test("stores the Jira provider connection and DMs Slack on success", async () => {
    const { store, providerConnections } = createFakeStore();
    const { slack, messages } = createFakeSlack();

    const response = await handleJiraCallback(
      config,
      store,
      slack,
      new URL(
        "https://example.test/oauth/jira/callback?code=abc&state=valid-state"
      ),
      {
        exchangeJiraCode: async (_config, code) => {
          expect(code).toBe("abc");
          return {
            accessToken: "jira-token",
            refreshToken: "jira-refresh-token",
            accessTokenExpiresAt: "2026-05-23T06:00:00.000Z"
          };
        },
        getJiraUser: async (token) => {
          expect(token).toBe("jira-token");
          return { accountId: "account-123", displayName: "Example User" };
        }
      }
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Connected. You can close this tab.");
    expect(providerConnections).toEqual([
      {
        provider: "jira",
        email: "person@example.com",
        slackUserId: "U123",
        providerLogin: "Example User",
        accessToken: "jira-token",
        refreshToken: "jira-refresh-token",
        accessTokenExpiresAt: "2026-05-23T06:00:00.000Z"
      }
    ]);
    expect(messages).toEqual([
      {
        channel: "U123",
        text: "Connected to Jira as `Example User` (person@example.com)."
      }
    ]);
  });
});

describe("handleGoogleCallback", () => {
  test("stores the Google provider connection and DMs Slack on success", async () => {
    const { store, providerConnections } = createFakeStore();
    const { slack, messages } = createFakeSlack();

    const response = await handleGoogleCallback(
      config,
      store,
      slack,
      new URL(
        "https://example.test/oauth/google/callback?code=abc&state=valid-state"
      ),
      {
        exchangeGoogleCode: async (_config, code) => {
          expect(code).toBe("abc");
          return {
            accessToken: "google-token",
            refreshToken: "google-refresh-token",
            accessTokenExpiresAt: "2026-05-23T06:00:00.000Z"
          };
        },
        getGoogleUser: async (token) => {
          expect(token).toBe("google-token");
          return { email: "google-user@example.com", name: "Person" };
        }
      }
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Connected. You can close this tab.");
    expect(providerConnections).toEqual([
      {
        provider: "google",
        email: "person@example.com",
        slackUserId: "U123",
        providerLogin: "google-user@example.com",
        accessToken: "google-token",
        refreshToken: "google-refresh-token",
        accessTokenExpiresAt: "2026-05-23T06:00:00.000Z"
      }
    ]);
    expect(messages).toEqual([
      {
        channel: "U123",
        text: "Connected to Google as `google-user@example.com` (person@example.com)."
      }
    ]);
  });
});

describe("handleHubSpotCallback", () => {
  test("stores the HubSpot provider connection and DMs Slack on success", async () => {
    const { store, providerConnections } = createFakeStore();
    const { slack, messages } = createFakeSlack();

    const response = await handleHubSpotCallback(
      config,
      store,
      slack,
      new URL(
        "https://example.test/oauth/hubspot/callback?code=abc&state=valid-state"
      ),
      {
        exchangeHubSpotCode: async (_config, code) => {
          expect(code).toBe("abc");
          return {
            accessToken: "hubspot-token",
            refreshToken: "hubspot-refresh-token",
            accessTokenExpiresAt: "2026-05-23T06:00:00.000Z"
          };
        },
        getHubSpotAccessTokenInfo: async (token) => {
          expect(token).toBe("hubspot-token");
          return {
            hubId: 12345,
            hubDomain: "example.hubspot.com",
            user: "hubspot-user@example.com",
            scopes: ["crm.objects.contacts.read"]
          };
        }
      }
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Connected. You can close this tab.");
    expect(providerConnections).toEqual([
      {
        provider: "hubspot",
        email: "person@example.com",
        slackUserId: "U123",
        providerLogin: "hubspot-user@example.com",
        accessToken: "hubspot-token",
        refreshToken: "hubspot-refresh-token",
        accessTokenExpiresAt: "2026-05-23T06:00:00.000Z"
      }
    ]);
    expect(messages).toEqual([
      {
        channel: "U123",
        text: "Connected to HubSpot as `hubspot-user@example.com` (person@example.com)."
      }
    ]);
  });
});

describe("handleSlackCallback", () => {
  test("stores the Slack provider connection and DMs Slack on success", async () => {
    const { store, providerConnections } = createFakeStore();
    const { slack, messages } = createFakeSlack();

    const response = await handleSlackCallback(
      config,
      store,
      slack,
      new URL(
        "https://example.test/oauth/slack/callback?code=abc&state=valid-state"
      ),
      {
        exchangeSlackCode: async (_config, code) => {
          expect(code).toBe("abc");
          return {
            accessToken: "xoxp-user-token",
            slackUserId: "U123",
            scope: "search:read users:read"
          };
        }
      }
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Connected. You can close this tab.");
    expect(providerConnections).toEqual([
      {
        provider: "slack",
        email: "person@example.com",
        slackUserId: "U123",
        providerLogin: "U123",
        accessToken: "xoxp-user-token"
      }
    ]);
    expect(messages).toEqual([
      {
        channel: "U123",
        text: "Connected Slack search for <@U123> (person@example.com)."
      }
    ]);
  });

  test("rejects a Slack token for a different Slack user", async () => {
    const { store, providerConnections } = createFakeStore();
    const { slack, messages } = createFakeSlack();
    const consoleError = spyOn(console, "error").mockImplementation(() => {});

    try {
      const response = await handleSlackCallback(
        config,
        store,
        slack,
        new URL(
          "https://example.test/oauth/slack/callback?code=abc&state=valid-state"
        ),
        {
          exchangeSlackCode: async () => ({
            accessToken: "xoxp-user-token",
            slackUserId: "U999"
          })
        }
      );

      expect(response.status).toBe(400);
      expect(providerConnections).toEqual([]);
      expect(messages).toEqual([
        {
          channel: "U123",
          text: "Slack connection failed. Run `/auth slack` and try again."
        }
      ]);
    } finally {
      consoleError.mockRestore();
    }
  });
});
