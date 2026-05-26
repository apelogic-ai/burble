import { describe, expect, test } from "bun:test";
import { createBurbleToolExecutor } from "../../../runtimes/openclaw-nemoclaw/src/burble-tools";
import type { RuntimeConfig } from "../../../runtimes/openclaw-nemoclaw/src/config";

const config: RuntimeConfig = {
  port: 8080,
  toolGatewayUrl: "http://burble-app:3000/internal/tools",
  internalToken: "runtime-secret",
  mcpGatewayUrl: null,
  runtimeJwt: null,
  engine: "deterministic",
  openClawCommand: "openclaw",
  openClawAgent: "main",
  openClawTimeoutMs: 60000,
  openClawStateDir: "/data/openclaw/state",
  openClawConfigPath: "/data/openclaw/config/openclaw.json",
  openClawWorkspaceDir: "/data/openclaw/workspace",
  openClawSetupOnStart: true,
  openClawConfigPatchPath: null,
  openClawValidateOnStart: true,
  openClawStreamDebug: false,
  openClawRawStreamDebug: false,
  openClawGatewayPort: 18789,
  openClawGatewayBind: "loopback",
  openClawGatewayToken: "gateway-token",
  llmModel: "openai:gpt-5.4",
  ollamaBaseUrl: "https://ollama.com"
};

describe("createBurbleToolExecutor", () => {
  test("requires MCP gateway settings for provider tools", () => {
    expect(() => createBurbleToolExecutor(config, "rt_u123")).toThrow(
      "Burble MCP gateway URL and runtime JWT are required for provider tools"
    );
  });

  test("uses the MCP gateway when runtime JWT settings are present", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Request[] = [];
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const payload = await request.clone().json();
      if (payload.method === "initialize") {
        return Response.json(
          {
            result: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              serverInfo: { name: "agentgateway", version: "test" }
            }
          },
          {
            headers: {
              "mcp-session-id": "session-123"
            }
          }
        );
      }
      if (payload.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      return new Response(
        [
          "event: message",
          `data: ${JSON.stringify({
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    classification: "user_private",
                    content: { login: "octocat" }
                  })
                }
              ]
            },
            jsonrpc: "2.0",
            id: "request-id"
          })}`,
          ""
        ].join("\n"),
        {
          headers: {
            "content-type": "text/event-stream"
          }
        }
      );
    }) as typeof fetch;

    try {
      const executor = createBurbleToolExecutor({
        ...config,
        mcpGatewayUrl: "http://agentgateway:3000/mcp",
        runtimeJwt: "runtime-jwt"
      });
      const result = await executor("github.getAuthenticatedUser", {
        user: { email: "person@example.com" }
      });

      expect(result.content).toEqual({ login: "octocat" });
      expect(requests[0].url).toBe("http://agentgateway:3000/mcp");
      expect(requests[0].headers.get("authorization")).toBe(
        "Bearer runtime-jwt"
      );
      expect(requests[0].headers.get("mcp-protocol-version")).toBe("2025-06-18");
      expect(await requests[0].json()).toMatchObject({
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18"
        }
      });
      expect(requests[1].headers.get("mcp-session-id")).toBe("session-123");
      expect(await requests[1].json()).toMatchObject({
        method: "notifications/initialized"
      });
      expect(requests[2].headers.get("mcp-session-id")).toBe("session-123");
      expect(await requests[2].json()).toMatchObject({
        method: "tools/call",
        params: {
          name: "github_get_authenticated_user",
          arguments: {}
        }
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("maps search tool inputs to MCP arguments", async () => {
    const originalFetch = globalThis.fetch;
    const payloads: unknown[] = [];
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      const payload = await request.json();
      payloads.push(payload);
      if (payload.method === "initialize") {
        return Response.json(
          { result: { protocolVersion: "2025-06-18", capabilities: {} } },
          { headers: { "mcp-session-id": "session-123" } }
        );
      }
      if (payload.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      return Response.json({
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                classification: "user_private",
                content: []
              })
            }
          ]
        }
      });
    }) as typeof fetch;

    try {
      const executor = createBurbleToolExecutor({
        ...config,
        mcpGatewayUrl: "http://agentgateway:3000/mcp",
        runtimeJwt: "runtime-jwt"
      });
      await executor("github.searchIssues", {
        user: { email: "person@example.com" },
        input: { query: "is:issue billing" }
      });
      await executor("jira.searchIssues", {
        user: { email: "person@example.com" },
        input: { jql: 'text ~ "billing"' }
      });
      await executor("jira.listAccessibleResources", {
        user: { email: "person@example.com" }
      });
      await executor("jira.listVisibleProjects", {
        user: { email: "person@example.com" },
        input: { query: "DM", action: "create", expandIssueTypes: true }
      });
      await executor("jira.searchUsers", {
        user: { email: "person@example.com" },
        input: { query: "alex.reviewer@example.com" }
      });
      await executor("slack.searchUsers", {
        user: { email: "person@example.com" },
        input: { query: "Alex Reviewer" }
      });
      await executor("slack.searchMessages", {
        user: { email: "person@example.com" },
        input: { query: "launch", fromUserId: "U123", limit: 3 }
      });
      await executor("jira.createIssue", {
        user: { email: "person@example.com" },
        input: {
          projectKey: "DM",
          issueTypeName: "Task",
          summary: "test ticket from slack",
          assigneeAccountId: "acct-boris"
        }
      });
      await executor("jira.editIssue", {
        user: { email: "person@example.com" },
        input: {
          issueKey: "DM-100",
          summary: "updated title",
          assigneeAccountId: null
        }
      });
      await executor("atlassian.listMcpTools", {
        user: { email: "person@example.com" }
      });
      await executor("atlassian.callMcpTool", {
        user: { email: "person@example.com" },
        input: {
          name: "searchJiraIssuesUsingJql",
          arguments: { jql: "assignee = currentUser()" }
        }
      });

      expect(payloads).toMatchObject([
        {
          method: "initialize"
        },
        {
          method: "notifications/initialized"
        },
        {
          method: "tools/call",
          params: {
            name: "github_search_issues",
            arguments: { query: "is:issue billing" }
          }
        },
        {
          method: "tools/call",
          params: {
            name: "jira_search_issues",
            arguments: { jql: 'text ~ "billing"' }
          }
        },
        {
          method: "tools/call",
          params: {
            name: "jira_list_accessible_resources",
            arguments: {}
          }
        },
        {
          method: "tools/call",
          params: {
            name: "jira_list_visible_projects",
            arguments: {
              query: "DM",
              action: "create",
              expandIssueTypes: true
            }
          }
        },
        {
          method: "tools/call",
          params: {
            name: "jira_search_users",
            arguments: { query: "alex.reviewer@example.com" }
          }
        },
        {
          method: "tools/call",
          params: {
            name: "slack_search_users",
            arguments: { query: "Alex Reviewer" }
          }
        },
        {
          method: "tools/call",
          params: {
            name: "slack_search_messages",
            arguments: { query: "launch", fromUserId: "U123", limit: 3 }
          }
        },
        {
          method: "tools/call",
          params: {
            name: "jira_create_issue",
            arguments: {
              projectKey: "DM",
              issueTypeName: "Task",
              summary: "test ticket from slack",
              assigneeAccountId: "acct-boris"
            }
          }
        },
        {
          method: "tools/call",
          params: {
            name: "jira_edit_issue",
            arguments: {
              issueKey: "DM-100",
              summary: "updated title",
              assigneeAccountId: null
            }
          }
        },
        {
          method: "tools/call",
          params: {
            name: "atlassian_list_mcp_tools",
            arguments: {}
          }
        },
        {
          method: "tools/call",
          params: {
            name: "atlassian_call_mcp_tool",
            arguments: {
              name: "searchJiraIssuesUsingJql",
              arguments: { jql: "assignee = currentUser()" }
            }
          }
        }
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("accepts plain text MCP tool results from gateways", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      const payload = await request.json();
      if (payload.method === "initialize") {
        return Response.json(
          { result: { protocolVersion: "2025-06-18", capabilities: {} } },
          { headers: { "mcp-session-id": "session-123" } }
        );
      }
      if (payload.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      return Response.json({
        result: {
          content: [
            {
              type: "text",
              text: "Jira assigned issues: none found."
            }
          ]
        }
      });
    }) as typeof fetch;

    try {
      const executor = createBurbleToolExecutor({
        ...config,
        mcpGatewayUrl: "http://agentgateway:3000/mcp",
        runtimeJwt: "runtime-jwt"
      });
      const result = await executor("jira.listAssignedIssues", {
        user: { email: "person@example.com" }
      });

      expect(result).toEqual({
        classification: "user_private",
        content: "Jira assigned issues: none found."
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
