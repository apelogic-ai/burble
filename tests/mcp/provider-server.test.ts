import { describe, expect, test } from "bun:test";
import type { Config } from "../../src/config";
import { createTokenStore } from "../../src/db";
import { JiraApiError } from "../../src/providers/jira/client";
import {
  handleProviderMcpRequest,
  isAllowedAtlassianMcpToolName
} from "../../src/mcp/provider-server";
import { createRuntimeJwtIssuer } from "../../src/runtime-jwt";
import { buildRuntimeManifestForRecord } from "../../src/agent/runtime-policy";

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
  agentRuntimeMcpGatewayUrl: "http://agentgateway:3000/mcp",
  agentRuntimeMcpAudience: "http://agentgateway:3000/mcp",
  agentRuntimeSandboxUrl: null,
  agentRuntimeSandboxToken: null,
  agentRuntimeSandboxStartCommand: null,
  atlassianMcpUrl: "https://mcp.atlassian.com/v1/mcp",
  runtimeJwtIssuer: "http://burble-app:3000",
  runtimeJwtPrivateKeyPath: null,
  openClawConfigPatchHostPath: null,
  internalApiToken: null,
  observabilityJsonlPath: null,
  observabilityJsonlDir: null,
  observabilityIncludeContent: false,
  taskWorkflowAuthority: "off",
  taskWorkflowShadowEnabled: false,
  taskWorkflowShadowDatabasePath: null,
  taskWorkflowMaxAttempts: 2,
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
    const route = store.upsertConversationRoute({
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destination: {
        runtimeId: runtime.id,
        conversationId: "D123"
      }
    });
    const token = issuer.issueRuntimeJwt({
      audience: "http://agentgateway:3000/mcp",
      runtimeId: runtime.id,
      workspaceId: "T123",
      slackUserId: "U123"
    });
    const lastUsedBefore = store.getAgentRuntime(runtime.id)?.lastUsedAt;
    await Bun.sleep(2);

    const response = await handleProviderMcpRequest(
      config,
      store,
      issuer,
      mcpRequest(
        {
          method: "tools/call",
          params: {
            name: "github_get_authenticated_user",
            arguments: { routeId: route.id }
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
    expect(store.getAgentRuntime(runtime.id)?.lastUsedAt).not.toBe(
      lastUsedBefore
    );
    store.close();
  });

  test("executes GitHub write tools under the runtime principal", async () => {
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
    const route = store.upsertConversationRoute({
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destination: {
        runtimeId: runtime.id,
        conversationId: "D123"
      }
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
            name: "github_create_issue",
            arguments: {
              routeId: route.id,
              repo: "acme/app",
              title: "New issue",
              labels: ["bug"]
            }
          }
        },
        token
      ),
      {
        createIssue: async (accessToken, input) => {
          expect(accessToken).toBe("gh-token");
          expect(input).toEqual({
            repo: "acme/app",
            title: "New issue",
            labels: ["bug"]
          });
          return {
            title: "New issue",
            html_url: "https://github.com/acme/app/issues/12",
            number: 12
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
        title: "New issue",
        url: "https://github.com/acme/app/issues/12",
        number: 12
      }
    });
    store.close();
  });

  test("rejects route-scoped provider tool calls for another principal", async () => {
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
    const route = store.upsertConversationRoute({
      workspaceId: "T123",
      slackUserId: "U999",
      transport: "slack",
      destination: {
        runtimeId: runtime.id,
        conversationId: "D999"
      }
    });
    const token = issuer.issueRuntimeJwt({
      audience: "http://agentgateway:3000/mcp",
      runtimeId: runtime.id,
      workspaceId: "T123",
      slackUserId: "U123"
    });
    let called = false;

    const response = await handleProviderMcpRequest(
      config,
      store,
      issuer,
      mcpRequest(
        {
          method: "tools/call",
          params: {
            name: "github_get_authenticated_user",
            arguments: { routeId: route.id }
          }
        },
        token
      ),
      {
        getGitHubUser: async () => {
          called = true;
          return { login: "octocat" };
        }
      }
    );
    const body = readMcpBody(await response.text());

    expect(response.status).toBe(200);
    expect(body.error.message).toBe(
      "Conversation route does not belong to this runtime principal."
    );
    expect(called).toBe(false);
    store.close();
  });

  test("can expose a provider-scoped MCP tool surface", async () => {
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
      mcpRequest({ method: "tools/list" }, token),
      {},
      "github"
    );
    const body = readMcpBody(await response.text());
    const toolNames = body.result.tools.map((tool) => tool.name);

    expect(toolNames).toContain("github_search_issues");
    expect(toolNames).not.toContain("jira_search_issues");
    expect(toolNames).not.toContain("slack_search_messages");

    store.close();
  });

  test("executes connectionless web search through provider MCP", async () => {
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
    const token = issuer.issueRuntimeJwt({
      audience: "http://agentgateway:3000/mcp",
      runtimeId: runtime.id,
      workspaceId: "T123",
      slackUserId: "U123"
    });
    const requestedUrls: string[] = [];

    const response = await handleProviderMcpRequest(
      config,
      store,
      issuer,
      mcpRequest(
        {
          method: "tools/call",
          params: {
            name: "web_search",
            arguments: {
              query: "latest AI news",
              limit: 1
            }
          }
        },
        token
      ),
      {
        fetch: async (url) => {
          requestedUrls.push(String(url));
          return new Response(
            `
              <rss>
                <channel>
                  <item>
                    <title>AI policy update</title>
                    <link>https://example.com/ai-policy</link>
                  </item>
                </channel>
              </rss>
            `,
            { status: 200 }
          );
        }
      },
      "web"
    );
    const body = readMcpBody(await response.text());
    const toolResult = JSON.parse(body.result.content[0].text);

    expect(response.status).toBe(200);
    expect(requestedUrls[0]).toContain("q=latest+AI+news");
    expect(toolResult).toEqual({
      classification: "public",
      content: {
        query: "latest AI news",
        results: [
          {
            title: "AI policy update",
            url: "https://example.com/ai-policy"
          }
        ]
      }
    });

    store.close();
  });

  test("filters provider MCP tools through workspace provider policy", async () => {
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
    store.upsertWorkspacePolicy({
      workspaceId: "T123",
      key: "providers.allowed",
      value: ["github"],
      updatedBySlackUserId: "UADMIN"
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
      mcpRequest({ method: "tools/list" }, token)
    );
    const body = readMcpBody(await response.text());
    const toolNames = body.result.tools.map((tool) => tool.name);

    expect(response.status).toBe(200);
    expect(toolNames).toContain("github_search_issues");
    expect(toolNames).not.toContain("google_search_drive_files");
    expect(toolNames).not.toContain("jira_search_issues");
    expect(toolNames).not.toContain("slack_search_messages");

    store.close();
  });

  test("narrows provider MCP tools through job-scoped JWT claims", async () => {
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
    const route = store.upsertConversationRoute({
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destination: {
        runtimeId: runtime.id,
        conversationId: "D123"
      }
    });
    store.upsertAgentJobCapability({
      jobId: "job-123",
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["github_list_my_pull_requests"],
      routeId: route.id,
      policyHash: "policy-a",
      capabilityProfile: "scheduled_job",
      runtimeType: "openclaw"
    });
    const token = issuer.issueRuntimeJwt({
      audience: "http://agentgateway:3000/mcp",
      runtimeId: runtime.id,
      workspaceId: "T123",
      slackUserId: "U123",
      jobId: "job-123",
      allowedTools: ["github_list_my_pull_requests"]
    });

    const listResponse = await handleProviderMcpRequest(
      config,
      store,
      issuer,
      mcpRequest({ method: "tools/list" }, token),
      {},
      "github"
    );
    const listBody = readMcpBody(await listResponse.text());
    const toolNames = listBody.result.tools.map((tool) => tool.name);

    expect(toolNames).toEqual(["github_list_my_pull_requests"]);

    const callResponse = await handleProviderMcpRequest(
      config,
      store,
      issuer,
      mcpRequest(
        {
          method: "tools/call",
          params: {
            name: "github_search_issues",
            arguments: { query: "repo:octo/repo is:open", routeId: route.id }
          }
        },
        token
      ),
      {
        searchIssues: async () => {
          throw new Error("job-scoped token should not allow this tool");
        }
      }
    );
    const callBody = readMcpBody(await callResponse.text());

    expect(callResponse.status).toBe(200);
    expect(callBody.error.message).toBe(
      "Tool github_search_issues is not available to this job."
    );
    const event = store
      .listAgentRuntimeEvents(runtime.id)
      .find((record) => record.eventType === "runtime_tool_called");
    expect(event).toBeDefined();
    expect(JSON.parse(event?.summaryJson ?? "{}")).toEqual({
      allowed: false,
      jobId: "job-123",
      reason: "job_scope_denied",
      tool: "github_search_issues"
    });

    store.close();
  });

  test("rejects job-scoped JWT claims without a stored job capability", async () => {
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
    const token = issuer.issueRuntimeJwt({
      audience: "http://agentgateway:3000/mcp",
      runtimeId: runtime.id,
      workspaceId: "T123",
      slackUserId: "U123",
      jobId: "missing-job",
      allowedTools: ["github_list_my_pull_requests"]
    });

    const response = await handleProviderMcpRequest(
      config,
      store,
      issuer,
      mcpRequest({ method: "tools/list" }, token),
      {},
      "github"
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "forbidden",
      error_description: "Scheduled job capability not found or inactive"
    });

    store.close();
  });

  test("hides and blocks user-disabled provider MCP tools", async () => {
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
    store.upsertUserPreference({
      workspaceId: "T123",
      slackUserId: "U123",
      key: "tools.disabled",
      value: ["github_search_issues"]
    });
    const route = store.upsertConversationRoute({
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destination: {
        runtimeId: runtime.id,
        conversationId: "D123"
      }
    });
    const token = issuer.issueRuntimeJwt({
      audience: "http://agentgateway:3000/mcp",
      runtimeId: runtime.id,
      workspaceId: "T123",
      slackUserId: "U123"
    });

    const listResponse = await handleProviderMcpRequest(
      config,
      store,
      issuer,
      mcpRequest({ method: "tools/list" }, token)
    );
    const listBody = readMcpBody(await listResponse.text());
    const toolNames = listBody.result.tools.map((tool) => tool.name);

    expect(toolNames).not.toContain("github_search_issues");
    expect(toolNames).toContain("github_list_my_pull_requests");

    const callResponse = await handleProviderMcpRequest(
      config,
      store,
      issuer,
      mcpRequest(
        {
          method: "tools/call",
          params: {
            name: "github_search_issues",
            arguments: { query: "repo:octo/repo is:open", routeId: route.id }
          }
        },
        token
      ),
      {
        searchIssues: async () => {
          throw new Error("disabled tool should not execute");
        }
      }
    );
    const callBody = readMcpBody(await callResponse.text());

    expect(callResponse.status).toBe(200);
    expect(callBody.result.content[0].text).toContain("github_search_issues");
    expect(callBody.result.content[0].text).toContain("not found");

    store.close();
  });

  test("requires policy confirmation for confirmed provider MCP write tools", async () => {
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
    store.upsertWorkspacePolicy({
      workspaceId: "T123",
      key: "tools.policy",
      value: [
        {
          provider: "github",
          tool: "github_create_pr",
          effect: "allow",
          risk: "moderate_write",
          confirmation: "explicit"
        }
      ],
      updatedBySlackUserId: "UADMIN"
    });
    store.upsertConnectedUser({
      email: "person@example.com",
      slackUserId: "U123",
      githubLogin: "octocat",
      githubToken: "gh-token"
    });
    const route = store.upsertConversationRoute({
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destination: {
        runtimeId: runtime.id,
        conversationId: "D123"
      }
    });
    const token = issuer.issueRuntimeJwt({
      audience: "http://agentgateway:3000/mcp",
      runtimeId: runtime.id,
      workspaceId: "T123",
      slackUserId: "U123"
    });

    const unconfirmedResponse = await handleProviderMcpRequest(
      config,
      store,
      issuer,
      mcpRequest(
        {
          method: "tools/call",
          params: {
            name: "github_create_pr",
            arguments: {
              routeId: route.id,
              repo: "acme/app",
              title: "Ship it",
              head: "feature",
              base: "main"
            }
          }
        },
        token
      ),
      {
        createPullRequest: async () => {
          throw new Error("unconfirmed write tool should not execute");
        }
      }
    );
    const unconfirmedBody = readMcpBody(await unconfirmedResponse.text());

    expect(unconfirmedResponse.status).toBe(200);
    expect(unconfirmedBody.error.message).toBe(
      "Tool github_create_pr requires explicit confirmation."
    );

    const manifest = buildRuntimeManifestForRecord({ config, store, runtime });
    const confirmedResponse = await handleProviderMcpRequest(
      config,
      store,
      issuer,
      mcpRequest(
        {
          method: "tools/call",
          params: {
            name: "github_create_pr",
            arguments: {
              routeId: route.id,
              repo: "acme/app",
              title: "Ship it",
              head: "feature",
              base: "main",
              confirmation: {
                tool: "github_create_pr",
                policyHash: manifest.policyHash,
                level: "explicit"
              }
            }
          }
        },
        token
      ),
      {
        createPullRequest: async (accessToken, input) => {
          expect(accessToken).toBe("gh-token");
          expect(input).toEqual({
            repo: "acme/app",
            title: "Ship it",
            head: "feature",
            base: "main"
          });
          return {
            title: "Ship it",
            html_url: "https://github.com/acme/app/pull/7",
            number: 7,
            draft: false
          };
        }
      }
    );
    const confirmedBody = readMcpBody(await confirmedResponse.text());
    const toolResult = JSON.parse(confirmedBody.result.content[0].text);

    expect(confirmedResponse.status).toBe(200);
    expect(toolResult).toEqual({
      classification: "user_private",
      content: {
        title: "Ship it",
        url: "https://github.com/acme/app/pull/7",
        number: 7,
        draft: false
      }
    });
    store.close();
  });

  test("executes Google search tools under the runtime principal", async () => {
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
      provider: "google",
      email: "person@example.com",
      slackUserId: "U123",
      providerLogin: "google-user@example.com",
      accessToken: "google-token",
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
            name: "google_search_drive_files",
            arguments: { query: "roadmap", limit: 3 }
          }
        },
        token
      ),
      {
        searchGoogleDriveFiles: async (accessToken, input) => {
          expect(accessToken).toBe("google-token");
          expect(input).toEqual({ query: "roadmap", limit: 3 });
          return [
            {
              id: "file-1",
              name: "Roadmap",
              webViewLink: "https://drive.google.com/file-1"
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
          id: "file-1",
          name: "Roadmap",
          webViewLink: "https://drive.google.com/file-1"
        }
      ]
    });
    store.close();
  });

  test("executes new Google MCP tools through default dependencies", async () => {
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
      provider: "google",
      email: "person@example.com",
      slackUserId: "U123",
      providerLogin: "google-user@example.com",
      accessToken: "google-token",
      refreshToken: null,
      accessTokenExpiresAt: null
    });
    const token = issuer.issueRuntimeJwt({
      audience: "http://agentgateway:3000/mcp",
      runtimeId: runtime.id,
      workspaceId: "T123",
      slackUserId: "U123"
    });
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    globalThis.fetch = (async (input, init) => {
      requestedUrl = String(input);
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer google-token"
      );
      return Response.json({
        accountSummaries: [
          {
            account: "accounts/123",
            displayName: "ApeLogic",
            propertySummaries: [
              {
                property: "properties/456",
                displayName: "Website",
                parent: "accounts/123",
                propertyType: "PROPERTY_TYPE_ORDINARY"
              }
            ]
          }
        ]
      });
    }) as typeof fetch;

    try {
      const response = await handleProviderMcpRequest(
        config,
        store,
        issuer,
        mcpRequest(
          {
            method: "tools/call",
            params: {
              name: "google_analytics_list_properties",
              arguments: { limit: 2 }
            }
          },
          token
        )
      );
      const body = readMcpBody(await response.text());
      const toolResult = JSON.parse(body.result.content[0].text);

      expect(response.status).toBe(200);
      expect(new URL(requestedUrl).pathname).toBe("/v1beta/accountSummaries");
      expect(toolResult).toEqual({
        classification: "user_private",
        content: [
          {
            account: "accounts/123",
            accountDisplayName: "ApeLogic",
            property: "properties/456",
            propertyId: "456",
            displayName: "Website",
            parent: "accounts/123",
            propertyType: "PROPERTY_TYPE_ORDINARY"
          }
        ]
      });
    } finally {
      globalThis.fetch = originalFetch;
      store.close();
    }
  });

  test("executes Google Slides copy through provider MCP", async () => {
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
      provider: "google",
      email: "person@example.com",
      slackUserId: "U123",
      providerLogin: "google-user@example.com",
      accessToken: "google-token",
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
            name: "google_slides_copy_presentation",
            arguments: {
              presentationId: "deck-template",
              name: "ApeLogic Template Copy"
            }
          }
        },
        token
      ),
      {
        copyGoogleSlidesPresentation: async (accessToken, input) => {
          expect(accessToken).toBe("google-token");
          expect(input).toEqual({
            presentationId: "deck-template",
            name: "ApeLogic Template Copy"
          });
          return {
            id: "deck-copy",
            name: "ApeLogic Template Copy",
            mimeType: "application/vnd.google-apps.presentation",
            webViewLink: "https://docs.google.com/presentation/d/deck-copy"
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
        id: "deck-copy",
        name: "ApeLogic Template Copy",
        mimeType: "application/vnd.google-apps.presentation",
        webViewLink: "https://docs.google.com/presentation/d/deck-copy"
      }
    });
    store.close();
  });

  test("executes Google Slides copy through provider MCP default dependencies", async () => {
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
      provider: "google",
      email: "person@example.com",
      slackUserId: "U123",
      providerLogin: "google-user@example.com",
      accessToken: "google-token",
      refreshToken: null,
      accessTokenExpiresAt: null
    });
    const token = issuer.issueRuntimeJwt({
      audience: "http://agentgateway:3000/mcp",
      runtimeId: runtime.id,
      workspaceId: "T123",
      slackUserId: "U123"
    });
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    let requestBody: unknown;
    globalThis.fetch = (async (input, init) => {
      requestedUrl = String(input);
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer google-token"
      );
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        id: "deck-copy",
        name: "ApeLogic Template Copy",
        mimeType: "application/vnd.google-apps.presentation",
        webViewLink: "https://docs.google.com/presentation/d/deck-copy"
      });
    }) as typeof fetch;

    try {
      const response = await handleProviderMcpRequest(
        config,
        store,
        issuer,
        mcpRequest(
          {
            method: "tools/call",
            params: {
              name: "google_slides_copy_presentation",
              arguments: {
                presentationId: "deck-template",
                name: "ApeLogic Template Copy"
              }
            }
          },
          token
        )
      );
      const body = readMcpBody(await response.text());
      const toolResult = JSON.parse(body.result.content[0].text);

      expect(response.status).toBe(200);
      expect(new URL(requestedUrl).pathname).toBe(
        "/drive/v3/files/deck-template/copy"
      );
      expect(requestBody).toEqual({ name: "ApeLogic Template Copy" });
      expect(toolResult).toEqual({
        classification: "user_private",
        content: {
          id: "deck-copy",
          name: "ApeLogic Template Copy",
          mimeType: "application/vnd.google-apps.presentation",
          webViewLink: "https://docs.google.com/presentation/d/deck-copy"
        }
      });
    } finally {
      globalThis.fetch = originalFetch;
      store.close();
    }
  });

  test("executes Google Slides placeholder fills through provider MCP", async () => {
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
      provider: "google",
      email: "person@example.com",
      slackUserId: "U123",
      providerLogin: "google-user@example.com",
      accessToken: "google-token",
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
            name: "google_slides_fill_placeholders",
            arguments: {
              presentationId: "deck-copy",
              replacements: [
                { placeholderType: "TITLE", text: "ApeLogic" },
                {
                  placeholderType: "SUBTITLE",
                  text: "Test presentation from template"
                }
              ]
            }
          }
        },
        token
      ),
      {
        fillGoogleSlidesPlaceholders: async (accessToken, input) => {
          expect(accessToken).toBe("google-token");
          expect(input).toEqual({
            presentationId: "deck-copy",
            replacements: [
              { placeholderType: "TITLE", text: "ApeLogic" },
              {
                placeholderType: "SUBTITLE",
                text: "Test presentation from template"
              }
            ]
          });
          return {
            presentationId: "deck-copy",
            slideObjectId: "slide-1",
            updatedPlaceholders: [
              {
                placeholderType: "TITLE",
                matchedPlaceholderType: "TITLE",
                objectId: "title-shape",
                text: "ApeLogic"
              }
            ],
            skippedPlaceholders: []
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
        presentationId: "deck-copy",
        slideObjectId: "slide-1",
        updatedPlaceholders: [
          {
            placeholderType: "TITLE",
            matchedPlaceholderType: "TITLE",
            objectId: "title-shape",
            text: "ApeLogic"
          }
        ],
        skippedPlaceholders: []
      }
    });
    store.close();
  });

  test("executes Google Slides slide creation through provider MCP", async () => {
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
      provider: "google",
      email: "person@example.com",
      slackUserId: "U123",
      providerLogin: "google-user@example.com",
      accessToken: "google-token",
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
            name: "google_slides_create_slide",
            arguments: {
              presentationId: "deck-copy",
              insertionIndex: 2,
              predefinedLayout: "TITLE_AND_TWO_COLUMNS",
              replacements: [
                { placeholderType: "TITLE", text: "Test slide 3" },
                { placeholderType: "BODY", index: 0, text: "Left text" },
                { placeholderType: "BODY", index: 1, text: "Right text" }
              ]
            }
          }
        },
        token
      ),
      {
        createGoogleSlidesSlide: async (accessToken, input) => {
          expect(accessToken).toBe("google-token");
          expect(input).toEqual({
            presentationId: "deck-copy",
            insertionIndex: 2,
            predefinedLayout: "TITLE_AND_TWO_COLUMNS",
            replacements: [
              { placeholderType: "TITLE", text: "Test slide 3" },
              { placeholderType: "BODY", index: 0, text: "Left text" },
              { placeholderType: "BODY", index: 1, text: "Right text" }
            ]
          });
          return {
            presentationId: "deck-copy",
            slideObjectId: "slide-3",
            layoutObjectId: "layout-two-columns"
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
        presentationId: "deck-copy",
        slideObjectId: "slide-3",
        layoutObjectId: "layout-two-columns"
      }
    });
    store.close();
  });

  test("enforces scheduled job capabilities for principal-scoped MCP calls", async () => {
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
      provider: "google",
      email: "person@example.com",
      slackUserId: "U123",
      providerLogin: "google-user@example.com",
      accessToken: "google-token",
      refreshToken: null,
      accessTokenExpiresAt: null
    });
    store.upsertAgentJobCapability({
      jobId: "ai-news-hourly",
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["google_search_drive_files"],
      routeId: null,
      policyHash: "policy-a",
      capabilityProfile: "scheduled_job",
      runtimeType: "openclaw"
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
            name: "google_search_drive_files",
            arguments: {
              jobId: "ai-news-hourly",
              query: "AI News Scratchpad",
              limit: 1
            }
          }
        },
        token
      ),
      {
        searchGoogleDriveFiles: async (accessToken, input) => {
          expect(accessToken).toBe("google-token");
          expect(input).toEqual({
            query: "AI News Scratchpad",
            limit: 1
          });
          return [{ id: "file-1", name: "AI News Scratchpad" }];
        }
      }
    );
    const body = readMcpBody(await response.text());
    const toolResult = JSON.parse(body.result.content[0].text);

    expect(response.status).toBe(200);
    expect(toolResult).toEqual({
      classification: "user_private",
      content: [{ id: "file-1", name: "AI News Scratchpad" }]
    });
    store.close();
  });

  test("blocks principal-scoped MCP calls outside scheduled job capabilities", async () => {
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
      provider: "google",
      email: "person@example.com",
      slackUserId: "U123",
      providerLogin: "google-user@example.com",
      accessToken: "google-token",
      refreshToken: null,
      accessTokenExpiresAt: null
    });
    store.upsertAgentJobCapability({
      jobId: "ai-news-hourly",
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["google_search_drive_files"],
      routeId: null,
      policyHash: "policy-a",
      capabilityProfile: "scheduled_job",
      runtimeType: "openclaw"
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
            name: "google_append_to_drive_text_file",
            arguments: {
              jobId: "ai-news-hourly",
              fileId: "file-1",
              text: "Reported item"
            }
          }
        },
        token
      ),
      {
        appendGoogleDriveTextFile: async () => {
          throw new Error("job capability should block this tool");
        }
      }
    );
    const body = readMcpBody(await response.text());

    expect(response.status).toBe(200);
    expect(body.error.message).toBe(
      "Tool google_append_to_drive_text_file is not available to scheduled job ai-news-hourly."
    );
    store.close();
  });

  test("requires job-scoped MCP calls to include the matching scheduled job id argument", async () => {
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
      provider: "google",
      email: "person@example.com",
      slackUserId: "U123",
      providerLogin: "google-user@example.com",
      accessToken: "google-token",
      refreshToken: null,
      accessTokenExpiresAt: null
    });
    store.upsertAgentJobCapability({
      jobId: "ai-news-hourly",
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["google_search_drive_files"],
      routeId: null,
      policyHash: "policy-a",
      capabilityProfile: "scheduled_job",
      runtimeType: "openclaw"
    });
    const token = issuer.issueRuntimeJwt({
      audience: "http://agentgateway:3000/mcp",
      runtimeId: runtime.id,
      workspaceId: "T123",
      slackUserId: "U123",
      jobId: "ai-news-hourly",
      allowedTools: ["google_search_drive_files"]
    });

    const response = await handleProviderMcpRequest(
      config,
      store,
      issuer,
      mcpRequest(
        {
          method: "tools/call",
          params: {
            name: "google_search_drive_files",
            arguments: {
              query: "AI News Scratchpad",
              limit: 1
            }
          }
        },
        token
      ),
      {
        searchGoogleDriveFiles: async () => {
          throw new Error("job-scoped calls must include jobId");
        }
      }
    );
    const body = readMcpBody(await response.text());

    expect(response.status).toBe(200);
    expect(body.error.message).toBe(
      "Scheduled job provider calls must include jobId matching the runtime token."
    );

    const aliasResponse = await handleProviderMcpRequest(
      config,
      store,
      issuer,
      mcpRequest(
        {
          method: "tools/call",
          params: {
            name: "google_search_drive_files",
            arguments: {
              query: "AI News Scratchpad",
              limit: 1,
              scheduledJobId: "ai-news-hourly"
            }
          }
        },
        token
      ),
      {
        searchGoogleDriveFiles: async (_accessToken, input) => {
          expect(input).toEqual({
            query: "AI News Scratchpad",
            limit: 1
          });
          return [{ id: "file-1", name: "AI News Scratchpad" }];
        }
      }
    );
    const aliasBody = readMcpBody(await aliasResponse.text());
    const aliasToolResult = JSON.parse(aliasBody.result.content[0].text);

    expect(aliasResponse.status).toBe(200);
    expect(aliasToolResult).toEqual({
      classification: "user_private",
      content: [{ id: "file-1", name: "AI News Scratchpad" }]
    });
    store.close();
  });

  test("rejects scheduled MCP calls when the stored job route no longer matches the runtime", async () => {
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
    const route = store.upsertConversationRoute({
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destination: {
        runtimeId: "rt_other",
        conversationId: "D123"
      }
    });
    store.upsertAgentJobCapability({
      jobId: "ai-news-hourly",
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["google_search_drive_files"],
      routeId: route.id,
      policyHash: "policy-a",
      capabilityProfile: "scheduled_job",
      runtimeType: "openclaw"
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
            name: "google_search_drive_files",
            arguments: {
              jobId: "ai-news-hourly",
              query: "AI News Scratchpad",
              limit: 1
            }
          }
        },
        token
      ),
      {
        searchGoogleDriveFiles: async () => {
          throw new Error("job route should block this tool call");
        }
      }
    );
    const body = readMcpBody(await response.text());

    expect(response.status).toBe(200);
    expect(body.error.message).toBe(
      `Scheduled job route ${route.id} is bound to a different runtime.`
    );
    store.close();
  });

  test("executes Google Drive create text file under the runtime principal", async () => {
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
      provider: "google",
      email: "person@example.com",
      slackUserId: "U123",
      providerLogin: "google-user@example.com",
      accessToken: "google-token",
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
            name: "google_create_drive_text_file",
            arguments: { name: "Test", text: "Test One" }
          }
        },
        token
      ),
      {
        createGoogleDriveTextFile: async (accessToken, input) => {
          expect(accessToken).toBe("google-token");
          expect(input).toEqual({ name: "Test", text: "Test One" });
          return {
            id: "file-1",
            name: "Test",
            mimeType: "text/plain",
            webViewLink: "https://drive.google.com/file-1"
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
        id: "file-1",
        name: "Test",
        mimeType: "text/plain",
        webViewLink: "https://drive.google.com/file-1"
      }
    });
    store.close();
  });

  test("defaults Google Drive create text file content to empty text", async () => {
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
      provider: "google",
      email: "person@example.com",
      slackUserId: "U123",
      providerLogin: "google-user@example.com",
      accessToken: "google-token",
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
            name: "google_create_drive_text_file",
            arguments: { name: "Blank" }
          }
        },
        token
      ),
      {
        createGoogleDriveTextFile: async (accessToken, input) => {
          expect(accessToken).toBe("google-token");
          expect(input).toEqual({ name: "Blank", text: "" });
          return {
            id: "file-2",
            name: "Blank"
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
        id: "file-2",
        name: "Blank"
      }
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
              url: "https://example.atlassian.net/jira/projects/DM",
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
          url: "https://example.atlassian.net/jira/projects/DM",
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
                cloudId: "https://example.atlassian.net",
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
  result: { content: Array<{ text: string }>; tools: Array<{ name: string }> };
  error: { message: string };
} {
  const dataLine = text
    .split("\n")
    .find((line) => line.startsWith("data: "));
  if (!dataLine) {
    throw new Error(`Missing MCP data line in response: ${text}`);
  }

  return JSON.parse(dataLine.slice("data: ".length));
}
