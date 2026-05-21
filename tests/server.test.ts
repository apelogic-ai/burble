import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config";
import type { TokenStore } from "../src/db";
import { handleGitHubCallback } from "../src/server";
import type { SlackRuntime } from "../src/slack";

const config: Config = {
  slackBotToken: "xoxb-test",
  slackAppToken: "xapp-test",
  githubClientId: "client-id",
  githubClientSecret: "client-secret",
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
  agentRuntimeTokenSecret: null,
  agentRuntimeToolGatewayUrl: "http://burble-app:3000/internal/tools",
  openClawConfigPatchHostPath: null,
  internalApiToken: null,
  aiModel: "openai:gpt-5.4"
};

function createFakeStore() {
  const connectedUsers: unknown[] = [];
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
    getConnectedUserByEmail: () => null,
    getConnection: () => null,
    getOrCreateAgentRuntime: () => {
      throw new Error("unexpected agent runtime call");
    },
    getAgentRuntime: () => null,
    listIdleAgentRuntimes: () => [],
    updateAgentRuntimeStatus: () => undefined,
    touchAgentRuntime: () => undefined,
    close: () => undefined
  } as TokenStore;

  return { store, connectedUsers };
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
