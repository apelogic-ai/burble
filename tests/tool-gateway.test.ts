import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config";
import type { ProviderConnection, TokenStore } from "../src/db";
import { handleToolGatewayRequest } from "../src/tool-gateway";

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
  openClawNemoClawUrl: null,
  internalApiToken: "internal-secret",
  aiModel: "openai:gpt-5.4"
};

const connection: ProviderConnection = {
  provider: "github",
  email: "person@example.com",
  slackUserId: "U123",
  providerLogin: "octocat",
  accessToken: "secret-token",
  connectedAt: "2026-05-19T00:00:00Z"
};

function createStore(foundConnection: ProviderConnection | null): TokenStore {
  return {
    createOAuthState: () => "state",
    consumeOAuthState: () => null,
    upsertConnectedUser: () => undefined,
    getConnectedUserByEmail: () => null,
    getConnection: (provider, email) =>
      provider === "github" && email === "person@example.com"
        ? foundConnection
        : null,
    close: () => undefined
  } as TokenStore;
}

function request(
  toolName: string,
  body: unknown,
  token = "internal-secret"
): Request {
  return new Request(`https://example.test/internal/tools/${toolName}/execute`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });
}

describe("handleToolGatewayRequest", () => {
  test("executes an allowlisted GitHub tool with the stored caller token", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(connection),
      "github.listAssignedIssues",
      request("github.listAssignedIssues", {
        user: { email: "person@example.com" }
      }),
      {
        listAssignedIssues: async (token) => {
          expect(token).toBe("secret-token");
          return [
            {
              title: "Fix billing export",
              html_url: "https://github.com/acme/app/issues/1"
            }
          ];
        }
      }
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      classification: "user_private",
      content: [
        {
          title: "Fix billing export",
          url: "https://github.com/acme/app/issues/1"
        }
      ]
    });
    expect(JSON.stringify(body)).not.toContain("secret-token");
  });

  test("requires the configured internal bearer token", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(connection),
      "github.getAuthenticatedUser",
      request("github.getAuthenticatedUser", {
        user: { email: "person@example.com" }
      }, "wrong-token")
    );

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Unauthorized");
  });

  test("returns a private connect instruction when the user is not connected", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(null),
      "github.getAuthenticatedUser",
      request("github.getAuthenticatedUser", {
        user: { email: "person@example.com" }
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      classification: "user_private",
      content: {
        error: "github_not_connected",
        message: "Connect GitHub first: `@Burble connect github`."
      }
    });
  });

  test("rejects unknown tools", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(connection),
      "github.deleteRepository",
      request("github.deleteRepository", {
        user: { email: "person@example.com" }
      })
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Unknown tool");
  });

  test("validates tool input before execution", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(connection),
      "github.searchIssues",
      request("github.searchIssues", {
        user: { email: "person@example.com" },
        input: {}
      })
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Invalid tool input");
  });
});
