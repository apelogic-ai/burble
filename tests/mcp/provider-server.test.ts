import { describe, expect, test } from "bun:test";
import type { Config } from "../../src/config";
import { createTokenStore } from "../../src/db";
import { JiraApiError } from "../../src/jira";
import {
  handleProviderMcpRequest,
  isAllowedAtlassianMcpToolName
} from "../../src/mcp/provider-server";
import { createRuntimeJwtIssuer } from "../../src/runtime-jwt";

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
  baseUrl: "https://example.ngrok-free.app",
  port: 3000,
  databasePath: ":memory:",
  slackLogLevel: "info",
  agentMode: "deterministic",
  agentRuntime: "ai-sdk",
  agentRuntimeFactory: "static",
  openClawNemoClawUrl: null,
  openClawNemoClawEngine: "openclaw",
  agentRuntimeDataRoot: "/data/runtimes",
  agentRuntimeDockerNetwork: "compose_default",
  agentRuntimeImage: "burble-openclaw-nemoclaw:dev",
  agentRuntimeIdleTtlMs: 1800000,
  agentRuntimeReaperIntervalMs: 60000,
  agentRuntimeJwtTtlSeconds: 604800,
  agentRuntimeTokenSecret: null,
  agentRuntimeToolGatewayUrl: "http://burble-app:3000/internal/tools",
  agentRuntimeMcpGatewayUrl: "http://agentgateway:3000/mcp",
  agentRuntimeMcpAudience: "http://agentgateway:3000/mcp",
  atlassianMcpUrl: "https://mcp.atlassian.com/v1/mcp",
  runtimeJwtIssuer: "http://burble-app:3000",
  runtimeJwtPrivateKeyPath: null,
  openClawConfigPatchHostPath: null,
  internalApiToken: null,
  aiModel: "openai:gpt-5.4"
};

describe("handleProviderMcpRequest", () => {
  test("rejects requests without a runtime JWT", async () => {
    const issuer = createRuntimeJwtIssuer({ issuer: config.runtimeJwtIssuer });
    const store = createTokenStore(":memory:");

    const response = await handleProviderMcpRequest(
      config,
      store,
      issuer,
      mcpRequest({ method: "tools/list" })
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "unauthorized",
      error_description: "Runtime JWT token required"
    });
    store.close();
  });

  test("rejects invalid runtime JWTs with a specific error", async () => {
    const issuer = createRuntimeJwtIssuer({ issuer: config.runtimeJwtIssuer });
    const store = createTokenStore(":memory:");

    const response = await handleProviderMcpRequest(
      config,
      store,
      issuer,
      mcpRequest({ method: "tools/list" }, "not-a-jwt")
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "unauthorized",
      error_description: "Runtime JWT token invalid"
    });
    store.close();
  });

  test("exposes provider tools under the runtime principal", async () => {
    const issuer = createRuntimeJwtIssuer({ issuer: config.runtimeJwtIssuer });
    const store = createTokenStore(":memory:");
    const runtime = store.getOrCreateAgentRuntime({
      workspaceId: "T123",
      slackUserId: "U123",
      engine: "openclaw",
      endpointUrl: "http://runtime-u123:8080",
      authTokenHash: "hash-u123",
      statePath: "/data/runtimes/u123/state",
      configPath: "/data/runtimes/u123/config/openclaw.json",
      workspacePath: "/data/runtimes/u123/workspace"
    });
    store.upsertConnectedUser({
      email: "person@example.com",
      slackUserId: "U123",
      githubLogin: "octocat",
      githubToken: "gh-token"
    });
    const token = issuer.issueRuntimeJwt({
      audience: "http://agentgateway:3000/mcp",
      runtimeId: runtime.id,
      workspaceId: "T123",
      slackUserId: "U123"
    });

    const response = await handleProviderMcpRequest(
      config,
      store,
      issuer,
      mcpRequest(
        {
          method: "tools/call",
          params: {
            name: "github_get_authenticated_user",
            arguments: {}
          }
        },
        token
      ),
      {
        getGitHubUser: async (accessToken) => {
          expect(accessToken).toBe("gh-token");
          return { login: "octocat" };
        }
      }
    );
    const body = readMcpBody(await response.text());
    const toolResult = JSON.parse(body.result.content[0].text);

    expect(response.status).toBe(200);
    expect(toolResult).toEqual({
      classification: "user_private",
      content: { login: "octocat" }
    });
    store.close();
  });

  test("executes Slack search tools under the runtime principal", async () => {
    const issuer = createRuntimeJwtIssuer({ issuer: config.runtimeJwtIssuer });
    const store = createTokenStore(":memory:");
    const runtime = store.getOrCreateAgentRuntime({
      workspaceId: "T123",
      slackUserId: "U123",
      engine: "openclaw",
      endpointUrl: "http://runtime-u123:8080",
      authTokenHash: "hash-u123",
      statePath: "/data/runtimes/u123/state",
      configPath: "/data/runtimes/u123/config/openclaw.json",
      workspacePath: "/data/runtimes/u123/workspace"
    });
    store.upsertProviderConnection({
      provider: "slack",
      email: "person@example.com",
      slackUserId: "U123",
      providerLogin: "U123",
      accessToken: "xoxp-user-token"
    });
    const token = issuer.issueRuntimeJwt({
      audience: "http://agentgateway:3000/mcp",
      runtimeId: runtime.id,
      workspaceId: "T123",
      slackUserId: "U123"
    });

    const response = await handleProviderMcpRequest(
      config,
      store,
      issuer,
      mcpRequest(
        {
          method: "tools/call",
          params: {
            name: "slack_search_messages",
            arguments: { query: "launch", fromUserId: "U123" }
          }
        },
        token
      ),
      {
        searchSlackMessages: async (accessToken, input) => {
          expect(accessToken).toBe("xoxp-user-token");
          expect(input).toEqual({ query: "launch", fromUserId: "U123" });
          return [{ text: "launch notes", channelName: "eng", userId: "U123" }];
        }
      }
    );
    const body = readMcpBody(await response.text());
    const toolResult = JSON.parse(body.result.content[0].text);

    expect(response.status).toBe(200);
    expect(toolResult).toEqual({
      classification: "user_private",
      content: [{ channelName: "eng", userId: "U123", text: "launch notes" }]
    });
    store.close();
  });

  test("lists upstream Atlassian MCP tools with the connected Jira token", async () => {
    const issuer = createRuntimeJwtIssuer({ issuer: config.runtimeJwtIssuer });
    const store = createTokenStore(":memory:");
    const runtime = store.getOrCreateAgentRuntime({
      workspaceId: "T123",
      slackUserId: "U123",
      engine: "openclaw",
      endpointUrl: "http://runtime-u123:8080",
      authTokenHash: "hash-u123",
      statePath: "/data/runtimes/u123/state",
      configPath: "/data/runtimes/u123/config/openclaw.json",
      workspacePath: "/data/runtimes/u123/workspace"
    });
    store.upsertProviderConnection({
      provider: "jira",
      email: "person@example.com",
      slackUserId: "U123",
      providerLogin: "Person",
      accessToken: "jira-token",
      refreshToken: null,
      accessTokenExpiresAt: null
    });
    const token = issuer.issueRuntimeJwt({
      audience: "http://agentgateway:3000/mcp",
      runtimeId: runtime.id,
      workspaceId: "T123",
      slackUserId: "U123"
    });

    const response = await handleProviderMcpRequest(
      config,
      store,
      issuer,
      mcpRequest(
        {
          method: "tools/call",
          params: {
            name: "atlassian_list_mcp_tools",
            arguments: {}
          }
        },
        token
      ),
      {
        listAtlassianMcpTools: async ({ url, accessToken }) => {
          expect(url).toBe("https://mcp.atlassian.com/v1/mcp");
          expect(accessToken).toBe("jira-token");
          return [
            {
              name: "searchJiraIssuesUsingJql",
              title: "Search Jira issues using JQL",
              description: "Search Jira issues visible to the connected user",
              inputSchema: {
                type: "object",
                properties: {
                  jql: { type: "string" }
                },
                required: ["jql"]
              }
            },
            {
              name: "deleteConfluencePage",
              title: "Delete Confluence page",
              description: "Delete a Confluence page"
            }
          ];
        }
      }
    );
    const body = readMcpBody(await response.text());
    const toolResult = JSON.parse(body.result.content[0].text);

    expect(response.status).toBe(200);
    expect(toolResult).toEqual({
      classification: "user_private",
      content: [
        {
          name: "searchJiraIssuesUsingJql",
          title: "Search Jira issues using JQL",
          description: "Search Jira issues visible to the connected user",
          inputSchema: {
            type: "object",
            properties: {
              jql: { type: "string" }
            },
            required: ["jql"]
          }
        }
      ]
    });
    store.close();
  });

  test("lists visible Jira projects through provider MCP", async () => {
    const issuer = createRuntimeJwtIssuer({ issuer: config.runtimeJwtIssuer });
    const store = createTokenStore(":memory:");
    const runtime = store.getOrCreateAgentRuntime({
      workspaceId: "T123",
      slackUserId: "U123",
      engine: "openclaw",
      endpointUrl: "http://runtime-u123:8080",
      authTokenHash: "hash-u123",
      statePath: "/data/runtimes/u123/state",
      configPath: "/data/runtimes/u123/config/openclaw.json",
      workspacePath: "/data/runtimes/u123/workspace"
    });
    store.upsertProviderConnection({
      provider: "jira",
      email: "person@example.com",
      slackUserId: "U123",
      providerLogin: "Person",
      accessToken: "jira-token",
      refreshToken: null,
      accessTokenExpiresAt: null
    });
    const token = issuer.issueRuntimeJwt({
      audience: "http://agentgateway:3000/mcp",
      runtimeId: runtime.id,
      workspaceId: "T123",
      slackUserId: "U123"
    });

    const response = await handleProviderMcpRequest(
      config,
      store,
      issuer,
      mcpRequest(
        {
          method: "tools/call",
          params: {
            name: "jira_list_visible_projects",
            arguments: { query: "DM", action: "create", expandIssueTypes: true }
          }
        },
        token
      ),
      {
        listVisibleJiraProjects: async (accessToken, input) => {
          expect(accessToken).toBe("jira-token");
          expect(input).toEqual({
            query: "DM",
            action: "create",
            expandIssueTypes: true
          });
          return [
            {
              id: "10000",
              key: "DM",
              name: "DM Workspace",
              url: "https://apegpt.atlassian.net/jira/projects/DM",
              issueTypes: [{ id: "10001", name: "Task", subtask: false }]
            }
          ];
        }
      }
    );
    const body = readMcpBody(await response.text());
    const toolResult = JSON.parse(body.result.content[0].text);

    expect(response.status).toBe(200);
    expect(toolResult).toEqual({
      classification: "user_private",
      content: [
        {
          id: "10000",
          key: "DM",
          name: "DM Workspace",
          url: "https://apegpt.atlassian.net/jira/projects/DM",
          issueTypes: [{ id: "10001", name: "Task", subtask: false }]
        }
      ]
    });
    store.close();
  });

  test("calls allowlisted upstream Atlassian MCP tools with the connected Jira token", async () => {
    const issuer = createRuntimeJwtIssuer({ issuer: config.runtimeJwtIssuer });
    const store = createTokenStore(":memory:");
    const runtime = store.getOrCreateAgentRuntime({
      workspaceId: "T123",
      slackUserId: "U123",
      engine: "openclaw",
      endpointUrl: "http://runtime-u123:8080",
      authTokenHash: "hash-u123",
      statePath: "/data/runtimes/u123/state",
      configPath: "/data/runtimes/u123/config/openclaw.json",
      workspacePath: "/data/runtimes/u123/workspace"
    });
    store.upsertProviderConnection({
      provider: "jira",
      email: "person@example.com",
      slackUserId: "U123",
      providerLogin: "Person",
      accessToken: "jira-token",
      refreshToken: null,
      accessTokenExpiresAt: null
    });
    const token = issuer.issueRuntimeJwt({
      audience: "http://agentgateway:3000/mcp",
      runtimeId: runtime.id,
      workspaceId: "T123",
      slackUserId: "U123"
    });

    const response = await handleProviderMcpRequest(
      config,
      store,
      issuer,
      mcpRequest(
        {
          method: "tools/call",
          params: {
            name: "atlassian_call_mcp_tool",
            arguments: {
              name: "searchJiraIssuesUsingJql",
              arguments: { jql: "assignee = currentUser()" }
            }
          }
        },
        token
      ),
      {
        callAtlassianMcpTool: async ({ url, accessToken, name, arguments: args }) => {
          expect(url).toBe("https://mcp.atlassian.com/v1/mcp");
          expect(accessToken).toBe("jira-token");
          expect(name).toBe("searchJiraIssuesUsingJql");
          expect(args).toEqual({ jql: "assignee = currentUser()" });
          return {
            content: [
              {
                type: "text",
                text: "ECS-123 Fix dashboard"
              }
            ]
          };
        }
      }
    );
    const body = readMcpBody(await response.text());
    const toolResult = JSON.parse(body.result.content[0].text);

    expect(response.status).toBe(200);
    expect(toolResult).toEqual({
      classification: "user_private",
      content: {
        toolName: "searchJiraIssuesUsingJql",
        result: {
          content: [
            {
              type: "text",
              text: "ECS-123 Fix dashboard"
            }
          ]
        }
      }
    });
    store.close();
  });

  test("classifies opaque Atlassian MCP errors as expired Jira auth", async () => {
    const issuer = createRuntimeJwtIssuer({ issuer: config.runtimeJwtIssuer });
    const store = createTokenStore(":memory:");
    const runtime = store.getOrCreateAgentRuntime({
      workspaceId: "T123",
      slackUserId: "U123",
      engine: "openclaw",
      endpointUrl: "http://runtime-u123:8080",
      authTokenHash: "hash-u123",
      statePath: "/data/runtimes/u123/state",
      configPath: "/data/runtimes/u123/config/openclaw.json",
      workspacePath: "/data/runtimes/u123/workspace"
    });
    store.upsertProviderConnection({
      provider: "jira",
      email: "person@example.com",
      slackUserId: "U123",
      providerLogin: "Person",
      accessToken: "jira-token",
      refreshToken: null,
      accessTokenExpiresAt: null
    });
    const token = issuer.issueRuntimeJwt({
      audience: "http://agentgateway:3000/mcp",
      runtimeId: runtime.id,
      workspaceId: "T123",
      slackUserId: "U123"
    });

    const response = await handleProviderMcpRequest(
      config,
      store,
      issuer,
      mcpRequest(
        {
          method: "tools/call",
          params: {
            name: "atlassian_call_mcp_tool",
            arguments: {
              name: "createJiraIssue",
              arguments: {
                cloudId: "https://apegpt.atlassian.net",
                projectKey: "DM",
                issueTypeName: "Task",
                summary: "test ticket from slack"
              }
            }
          }
        },
        token
      ),
      {
        callAtlassianMcpTool: async () => ({
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: true,
                message: "We are having trouble completing this action. Please try again shortly."
              })
            }
          ]
        }),
        getJiraUser: async () => {
          throw new JiraApiError("expired", 401);
        }
      }
    );
    const body = readMcpBody(await response.text());
    const toolResult = JSON.parse(body.result.content[0].text);

    expect(response.status).toBe(200);
    expect(toolResult).toEqual({
      classification: "user_private",
      content: {
        error: "jira_authorization_failed",
        message: "Jira authorization expired. Reconnect Jira with `@Burble connect jira`."
      }
    });
    store.close();
  });

  test("allows read tools and selected Jira write MCP tool names", async () => {
    expect(isAllowedAtlassianMcpToolName("searchJiraIssuesUsingJql")).toBe(true);
    expect(isAllowedAtlassianMcpToolName("getJiraIssue")).toBe(true);
    expect(isAllowedAtlassianMcpToolName("createJiraIssue")).toBe(true);
    expect(isAllowedAtlassianMcpToolName("editJiraIssue")).toBe(true);
    expect(isAllowedAtlassianMcpToolName("transitionJiraIssue")).toBe(true);
    expect(isAllowedAtlassianMcpToolName("addCommentToJiraIssue")).toBe(true);
    expect(isAllowedAtlassianMcpToolName("addWorklogToJiraIssue")).toBe(true);
    expect(isAllowedAtlassianMcpToolName("updateJiraIssue")).toBe(false);
    expect(isAllowedAtlassianMcpToolName("deleteConfluencePage")).toBe(false);
  });
});

function mcpRequest(
  payload: { method: string; params?: Record<string, unknown> },
  token?: string
): Request {
  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-06-18"
  });
  if (token) {
    headers.set("authorization", `Bearer ${token}`);
  }

  return new Request("https://example.test/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      ...payload
    })
  });
}

function readMcpBody(text: string): {
  result: { content: Array<{ text: string }> };
} {
  const dataLine = text
    .split("\n")
    .find((line) => line.startsWith("data: "));
  if (!dataLine) {
    throw new Error(`Missing MCP data line in response: ${text}`);
  }

  return JSON.parse(dataLine.slice("data: ".length));
}
