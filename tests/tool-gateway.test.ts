import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config";
import type {
  AgentRuntimeRecord,
  ConversationRouteRecord,
  ProviderConnection,
  TokenStore
} from "../src/db";
import { JiraApiError } from "../src/jira";
import { handleToolGatewayRequest } from "../src/tool-gateway";

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
  agentRuntimeMcpGatewayUrl: null,
  agentRuntimeMcpAudience: null,
  atlassianMcpUrl: "https://mcp.atlassian.com/v1/mcp",
  runtimeJwtIssuer: "https://example.ngrok-free.app",
  runtimeJwtPrivateKeyPath: null,
  openClawConfigPatchHostPath: null,
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

const jiraConnection: ProviderConnection = {
  provider: "jira",
  email: "person@example.com",
  slackUserId: "U123",
  providerLogin: "person@atlassian.example",
  accessToken: "jira-token",
  connectedAt: "2026-05-22T00:00:00Z"
};

const slackConnection: ProviderConnection = {
  provider: "slack",
  email: "person@example.com",
  slackUserId: "U123",
  providerLogin: "U123",
  accessToken: "xoxp-user-token",
  connectedAt: "2026-05-25T00:00:00Z"
};

const runtime: AgentRuntimeRecord = {
  id: "rt_u123",
  workspaceId: "T123",
  slackUserId: "U123",
  engine: "openclaw",
  status: "ready",
  endpointUrl: "http://runtime-u123:8080",
  authTokenHash:
    "d61d816e93bafb888da9bccc1fe342e978ee8619f396b6a1dbb9eaa09584eaba",
  statePath: "/data/runtimes/u123/state",
  configPath: "/data/runtimes/u123/config/openclaw.json",
  workspacePath: "/data/runtimes/u123/workspace",
  createdAt: "2026-05-21T00:00:00.000Z",
  lastSeenAt: "2026-05-21T00:00:00.000Z",
  lastUsedAt: "2026-05-21T00:00:00.000Z",
  stoppedAt: null,
  failureReason: null
};

function createStore(
  foundConnection: ProviderConnection | null,
  foundRuntime: AgentRuntimeRecord | null = null,
  runtimeEvents: unknown[] = [],
  foundRoute: ConversationRouteRecord | null = null
): TokenStore {
  return {
    createOAuthState: () => "state",
    consumeOAuthState: () => null,
    upsertConnectedUser: () => undefined,
    upsertProviderConnection: () => undefined,
    getConnectedUserByEmail: () => null,
    getConnection: (provider, email) =>
      provider === foundConnection?.provider && email === "person@example.com"
        ? foundConnection
        : null,
    getConnectionForSlackUser: (provider, slackUserId) =>
      provider === foundConnection?.provider &&
      slackUserId === foundConnection.slackUserId
        ? foundConnection
        : null,
    getOrCreateAgentRuntime: () => {
      throw new Error("unexpected agent runtime call");
    },
    getAgentRuntime: (id) => (id === foundRuntime?.id ? foundRuntime : null),
    getAgentRuntimeForPrincipal: () => foundRuntime,
    listIdleAgentRuntimes: () => [],
    recordAgentRuntimeEvent: (event) => {
      runtimeEvents.push(event);
    },
    listAgentRuntimeEvents: () => [],
    upsertConversationRoute: () => {
      throw new Error("unexpected conversation route write");
    },
    getConversationRoute: (id) => (id === foundRoute?.id ? foundRoute : null),
    updateAgentRuntimeStatus: () => undefined,
    touchAgentRuntime: () => undefined,
    close: () => undefined
  } as TokenStore;
}

function request(
  toolName: string,
  body: unknown,
  token = "internal-secret",
  runtimeId?: string
): Request {
  const headers = new Headers({
    "content-type": "application/json",
    authorization: `Bearer ${token}`
  });
  if (runtimeId) {
    headers.set("x-burble-runtime-id", runtimeId);
  }

  return new Request(`https://example.test/internal/tools/${toolName}/execute`, {
    method: "POST",
    headers,
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

  test("executes Slack message search with the stored Slack user token", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(slackConnection),
      "slack.searchMessages",
      request("slack.searchMessages", {
        user: { email: "person@example.com" },
        input: { query: "launch", fromUserId: "U123", limit: 3 }
      }),
      {
        searchSlackMessages: async (token, input) => {
          expect(token).toBe("xoxp-user-token");
          expect(input).toEqual({
            query: "launch",
            fromUserId: "U123",
            limit: 3
          });
          return [
            {
              channelId: "C123",
              channelName: "eng",
              userId: "U123",
              text: "launch notes",
              permalink: "https://slack.test/archives/C123/p1"
            }
          ];
        }
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      classification: "user_private",
      content: [
        {
          channelId: "C123",
          channelName: "eng",
          userId: "U123",
          text: "launch notes",
          permalink: "https://slack.test/archives/C123/p1"
        }
      ]
    });
  });

  test("allows a principal-bound runtime token for its own provider account", async () => {
    const runtimeEvents: unknown[] = [];
    const response = await handleToolGatewayRequest(
      config,
      createStore(connection, runtime, runtimeEvents),
      "github.getAuthenticatedUser",
      request(
        "github.getAuthenticatedUser",
        {
          user: { email: "person@example.com" }
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        getGitHubUser: async (token) => {
          expect(token).toBe("secret-token");
          return { login: "octocat" };
        }
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      classification: "user_private",
      content: { login: "octocat" }
    });
    expect(runtimeEvents).toEqual([
      {
        runtimeId: "rt_u123",
        eventType: "runtime_tool_called",
        summary: {
          toolName: "github.getAuthenticatedUser",
          classification: "user_private",
          itemCount: null
        }
      }
    ]);
  });

  test("lets a runtime send to its active conversation without provider credentials", async () => {
    const runtimeEvents: unknown[] = [];
    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime, runtimeEvents),
      "conversation.sendMessage",
      request(
        "conversation.sendMessage",
        {
          input: { text: "Long task finished." },
          conversation: {
            source: "slack",
            workspaceId: "T123",
            channelId: "C123",
            rootId: "channel:C123:thread:1779841118.237",
            isDirectMessage: false
          }
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        postActiveConversationMessage: async (input) => {
          expect(input).toEqual({
            transport: "slack",
            channelId: "C123",
            text: "Long task finished.",
            threadTs: "1779841118.237"
          });
          return {
            transport: "slack",
            channelId: "C123",
            messageId: "1779841120.000"
          };
        }
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      classification: "user_private",
      content: {
        ok: true,
        transport: "slack",
        conversationId: "C123",
        messageId: "1779841120.000"
      }
    });
    expect(runtimeEvents).toEqual([
      {
        runtimeId: "rt_u123",
        eventType: "runtime_tool_called",
        summary: {
          toolName: "conversation.sendMessage",
          classification: "user_private",
          itemCount: null
        }
      }
    ]);
  });

  test("lets a runtime send through a durable conversation route", async () => {
    const route: ConversationRouteRecord = {
      id: "convrt_abc123",
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destinationJson: JSON.stringify({
        channelId: "C123",
        threadTs: "1779841118.237"
      }),
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
      revokedAt: null
    };
    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime, [], route),
      "conversation.sendMessage",
      request(
        "conversation.sendMessage",
        {
          input: { text: "Cron finished.", routeId: "convrt_abc123" }
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        postActiveConversationMessage: async (input) => {
          expect(input).toEqual({
            transport: "slack",
            channelId: "C123",
            text: "Cron finished.",
            threadTs: "1779841118.237"
          });
          return {
            transport: "slack",
            channelId: "C123",
            messageId: "1779841130.000"
          };
        }
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      classification: "user_private",
      content: {
        ok: true,
        transport: "slack",
        conversationId: "C123",
        routeId: "convrt_abc123",
        messageId: "1779841130.000"
      }
    });
  });

  test("rejects invisible-only conversation messages", async () => {
    const route: ConversationRouteRecord = {
      id: "convrt_abc123",
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destinationJson: JSON.stringify({
        channelId: "C123"
      }),
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
      revokedAt: null
    };
    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime, [], route),
      "conversation.sendMessage",
      request(
        "conversation.sendMessage",
        {
          input: { text: "\u200B", routeId: "convrt_abc123" }
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        postActiveConversationMessage: async () => {
          throw new Error("invisible-only text should not be posted");
        }
      }
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Invalid tool input");
  });

  test("passes outbound conversation attachment metadata through durable routes", async () => {
    const route: ConversationRouteRecord = {
      id: "convrt_abc123",
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destinationJson: JSON.stringify({
        channelId: "C123",
        threadTs: "1779841118.237"
      }),
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
      revokedAt: null
    };
    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime, [], route),
      "conversation.sendMessage",
      request(
        "conversation.sendMessage",
        {
          input: {
            text: "Cron finished.",
            routeId: "convrt_abc123",
            attachments: [
              {
                id: "agent:report-1",
                source: "agent",
                kind: "file",
                mimeType: "text/plain",
                name: "report.txt",
                sizeBytes: 12
              }
            ]
          }
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        postActiveConversationMessage: async (input) => {
          expect(input).toEqual({
            transport: "slack",
            channelId: "C123",
            text: "Cron finished.",
            threadTs: "1779841118.237",
            attachments: [
              {
                id: "agent:report-1",
                source: "agent",
                kind: "file",
                mimeType: "text/plain",
                name: "report.txt",
                sizeBytes: 12
              }
            ]
          });
          return {
            transport: "slack",
            channelId: "C123",
            messageId: "1779841130.000"
          };
        }
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      classification: "user_private",
      content: {
        ok: true,
        transport: "slack",
        conversationId: "C123",
        routeId: "convrt_abc123",
        messageId: "1779841130.000"
      }
    });
  });

  test("allows attachment-only outbound conversation messages", async () => {
    const route: ConversationRouteRecord = {
      id: "convrt_abc123",
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destinationJson: JSON.stringify({
        channelId: "C123"
      }),
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
      revokedAt: null
    };
    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime, [], route),
      "conversation.sendMessage",
      request(
        "conversation.sendMessage",
        {
          input: {
            text: "",
            routeId: "convrt_abc123",
            attachments: [
              {
                id: "agent:image-1",
                source: "agent",
                kind: "image",
                mimeType: "image/png",
                name: "preview.png"
              }
            ]
          }
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        postActiveConversationMessage: async (input) => {
          expect(input.text).toBe("");
          expect(input.attachments).toEqual([
            {
              id: "agent:image-1",
              source: "agent",
              kind: "image",
              mimeType: "image/png",
              name: "preview.png"
            }
          ]);
          return {
            transport: "slack",
            channelId: "C123",
            messageId: "1779841130.000"
          };
        }
      }
    );

    expect(response.status).toBe(200);
  });

  test("rejects durable conversation routes bound to another runtime", async () => {
    const route: ConversationRouteRecord = {
      id: "convrt_abc123",
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destinationJson: JSON.stringify({
        channelId: "C123",
        runtimeId: "rt_other"
      }),
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
      revokedAt: null
    };
    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime, [], route),
      "conversation.sendMessage",
      request(
        "conversation.sendMessage",
        {
          input: { text: "Cron finished.", routeId: "convrt_abc123" }
        },
        "runtime-token-u123",
        "rt_u123"
      )
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Runtime route mismatch");
  });

  test("rejects active conversation sends for another workspace", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime),
      "conversation.sendMessage",
      request(
        "conversation.sendMessage",
        {
          input: { text: "hello" },
          conversation: {
            source: "slack",
            workspaceId: "T999",
            channelId: "C123",
            rootId: "channel:C123:thread:1779841118.237",
            isDirectMessage: false
          }
        },
        "runtime-token-u123",
        "rt_u123"
      )
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Runtime principal mismatch");
  });

  test("rejects runtime tokens for another user's connected account", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore({ ...connection, slackUserId: "U456" }, runtime),
      "github.getAuthenticatedUser",
      request(
        "github.getAuthenticatedUser",
        {
          user: { email: "person@example.com" }
        },
        "runtime-token-u123",
        "rt_u123"
      )
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Runtime principal mismatch");
  });

  test("rejects invalid runtime tokens", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(connection, runtime),
      "github.getAuthenticatedUser",
      request(
        "github.getAuthenticatedUser",
        {
          user: { email: "person@example.com" }
        },
        "wrong-runtime-token",
        "rt_u123"
      )
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

  test("executes an allowlisted Jira tool with the stored caller token", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(jiraConnection),
      "jira.searchIssues",
      request("jira.searchIssues", {
        user: { email: "person@example.com" },
        input: { jql: "assignee = currentUser() AND status != Done" }
      }),
      {
        searchJiraIssues: async (token, jql) => {
          expect(token).toBe("jira-token");
          expect(jql).toBe("assignee = currentUser() AND status != Done");
          return [
            {
              key: "ENG-123",
              summary: "Fix deploy dashboard",
              url: "https://example.atlassian.net/browse/ENG-123"
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
          key: "ENG-123",
          title: "Fix deploy dashboard",
          url: "https://example.atlassian.net/browse/ENG-123"
        }
      ]
    });
    expect(JSON.stringify(body)).not.toContain("jira-token");
  });

  test("executes Jira accessible resource lookup through the HTTP fallback gateway", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(jiraConnection),
      "jira.listAccessibleResources",
      request("jira.listAccessibleResources", {
        user: { email: "person@example.com" }
      }),
      {
        listJiraAccessibleResources: async (token) => {
          expect(token).toBe("jira-token");
          return [
            {
              id: "cloud-123",
              name: "APE GPT",
              url: "https://apegpt.atlassian.net",
              scopes: ["read:jira-work", "write:jira-work"]
            }
          ];
        }
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      classification: "user_private",
      content: [
        {
          id: "cloud-123",
          name: "APE GPT",
          url: "https://apegpt.atlassian.net"
        }
      ]
    });
  });

  test("executes Jira visible project lookup through the HTTP fallback gateway", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(jiraConnection),
      "jira.listVisibleProjects",
      request("jira.listVisibleProjects", {
        user: { email: "person@example.com" },
        input: { query: "DM", action: "create", expandIssueTypes: true }
      }),
      {
        listVisibleJiraProjects: async (token, input) => {
          expect(token).toBe("jira-token");
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

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
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
  });

  test("executes Jira REST write helpers through the HTTP fallback gateway", async () => {
    const createResponse = await handleToolGatewayRequest(
      config,
      createStore(jiraConnection),
      "jira.createIssue",
      request("jira.createIssue", {
        user: { email: "person@example.com" },
        input: {
          projectKey: "DM",
          issueTypeName: "Task",
          summary: "test ticket from slack",
          assigneeAccountId: "acct-boris"
        }
      }),
      {
        createJiraIssue: async (token, input) => {
          expect(token).toBe("jira-token");
          expect(input).toEqual({
            projectKey: "DM",
            issueTypeName: "Task",
            summary: "test ticket from slack",
            assigneeAccountId: "acct-boris"
          });
          return {
            key: "DM-100",
            summary: input.summary,
            url: "https://apegpt.atlassian.net/browse/DM-100"
          };
        }
      }
    );

    expect(createResponse.status).toBe(200);
    expect(await createResponse.json()).toEqual({
      classification: "user_private",
      content: {
        key: "DM-100",
        title: "test ticket from slack",
        url: "https://apegpt.atlassian.net/browse/DM-100"
      }
    });

    const editResponse = await handleToolGatewayRequest(
      config,
      createStore(jiraConnection),
      "jira.editIssue",
      request("jira.editIssue", {
        user: { email: "person@example.com" },
        input: {
          issueKey: "DM-100",
          summary: "updated title",
          assigneeAccountId: null
        }
      }),
      {
        editJiraIssue: async (token, input) => {
          expect(token).toBe("jira-token");
          expect(input).toEqual({
            issueKey: "DM-100",
            summary: "updated title",
            assigneeAccountId: null
          });
          return {
            key: "DM-100",
            summary: "updated title",
            url: "https://apegpt.atlassian.net/browse/DM-100"
          };
        }
      }
    );

    expect(editResponse.status).toBe(200);
    expect(await editResponse.json()).toEqual({
      classification: "user_private",
      content: {
        key: "DM-100",
        title: "updated title",
        url: "https://apegpt.atlassian.net/browse/DM-100"
      }
    });
  });

  test("executes Atlassian MCP tool discovery through the HTTP fallback gateway", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(jiraConnection),
      "atlassian.listMcpTools",
      request("atlassian.listMcpTools", {
        user: { email: "person@example.com" }
      }),
      {
        listAtlassianMcpTools: async ({ url, accessToken }) => {
          expect(url).toBe("https://mcp.atlassian.com/v1/mcp");
          expect(accessToken).toBe("jira-token");
          return [
            {
              name: "searchJiraIssuesUsingJql",
              description: "Search Jira issues using JQL",
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
              description: "Delete a Confluence page"
            }
          ];
        }
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      classification: "user_private",
      content: [
        {
          name: "searchJiraIssuesUsingJql",
          description: "Search Jira issues using JQL",
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
  });

  test("executes allowed Atlassian MCP calls through the HTTP fallback gateway", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(jiraConnection),
      "atlassian.callMcpTool",
      request("atlassian.callMcpTool", {
        user: { email: "person@example.com" },
        input: {
          name: "searchJiraIssuesUsingJql",
          arguments: {
            jql: 'text ~ "onboarding"'
          }
        }
      }),
      {
        callAtlassianMcpTool: async ({ url, accessToken, name, arguments: args }) => {
          expect(url).toBe("https://mcp.atlassian.com/v1/mcp");
          expect(accessToken).toBe("jira-token");
          expect(name).toBe("searchJiraIssuesUsingJql");
          expect(args).toEqual({
            jql: 'text ~ "onboarding"'
          });
          return {
            content: [
              {
                type: "text",
                text: "ECS-313 onboarding crash loop"
              }
            ]
          };
        }
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      classification: "user_private",
      content: {
        toolName: "searchJiraIssuesUsingJql",
        result: {
          content: [
            {
              type: "text",
              text: "ECS-313 onboarding crash loop"
            }
          ]
        }
      }
    });
  });

  test("executes allowlisted Jira write MCP calls through the HTTP fallback gateway", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(jiraConnection),
      "atlassian.callMcpTool",
      request("atlassian.callMcpTool", {
        user: { email: "person@example.com" },
        input: {
          name: "createJiraIssue",
          arguments: {
            projectKey: "ENG",
            issueType: "Task",
            summary: "Follow up on deploy dashboard"
          }
        }
      }),
      {
        callAtlassianMcpTool: async ({ accessToken, name, arguments: args }) => {
          expect(accessToken).toBe("jira-token");
          expect(name).toBe("createJiraIssue");
          expect(args).toEqual({
            projectKey: "ENG",
            issueType: "Task",
            summary: "Follow up on deploy dashboard"
          });
          return {
            content: [
              {
                type: "text",
                text: "Created ENG-124"
              }
            ]
          };
        }
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      classification: "user_private",
      content: {
        toolName: "createJiraIssue",
        result: {
          content: [
            {
              type: "text",
              text: "Created ENG-124"
            }
          ]
        }
      }
    });
  });

  test("classifies opaque Atlassian MCP errors as expired Jira auth when REST auth check fails", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(jiraConnection),
      "atlassian.callMcpTool",
      request("atlassian.callMcpTool", {
        user: { email: "person@example.com" },
        input: {
          name: "createJiraIssue",
          arguments: {
            cloudId: "https://apegpt.atlassian.net",
            projectKey: "DM",
            issueTypeName: "Task",
            summary: "test ticket from slack"
          }
        }
      }),
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

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      classification: "user_private",
      content: {
        error: "jira_authorization_failed",
        message: "Jira authorization expired. Reconnect Jira with `@Burble connect jira`."
      }
    });
  });

  test("rejects non-allowlisted mutating Atlassian MCP calls in the HTTP fallback gateway", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(jiraConnection),
      "atlassian.callMcpTool",
      request("atlassian.callMcpTool", {
        user: { email: "person@example.com" },
        input: {
          name: "updateJiraIssue",
          arguments: {
            key: "ENG-7"
          }
        }
      }),
      {
        callAtlassianMcpTool: async () => {
          throw new Error("unexpected upstream call");
        }
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      classification: "user_private",
      content: {
        error: "atlassian_mcp_tool_not_allowed",
        message:
          "Atlassian MCP tool `updateJiraIssue` is not enabled for use."
      }
    });
  });

  test("returns a private Jira connect instruction when Jira is not connected", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(null),
      "jira.listAssignedIssues",
      request("jira.listAssignedIssues", {
        user: { email: "person@example.com" }
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      classification: "user_private",
      content: {
        error: "jira_not_connected",
        message: "Connect Jira first."
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

  test("validates Jira search input before execution", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(jiraConnection),
      "jira.searchIssues",
      request("jira.searchIssues", {
        user: { email: "person@example.com" },
        input: {}
      })
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Invalid tool input");
  });
});
