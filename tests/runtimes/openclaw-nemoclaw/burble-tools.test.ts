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
  openClawStreamDebug: false
};

describe("createBurbleToolExecutor", () => {
  test("uses the HTTP gateway and sends the runtime id header when MCP is not configured", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Request[] = [];
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json({
        classification: "user_private",
        content: { login: "octocat" }
      });
    }) as typeof fetch;

    try {
      const executor = createBurbleToolExecutor(config, "rt_u123");
      const result = await executor("github.getAuthenticatedUser", {
        user: { email: "person@example.com" }
      });

      expect(result.content).toEqual({ login: "octocat" });
      expect(requests[0].url).toBe(
        "http://burble-app:3000/internal/tools/github.getAuthenticatedUser/execute"
      );
      expect(requests[0].headers.get("authorization")).toBe(
        "Bearer runtime-secret"
      );
      expect(requests[0].headers.get("x-burble-runtime-id")).toBe("rt_u123");
      expect(await requests[0].json()).toEqual({
        user: { email: "person@example.com" }
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
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
      await executor("atlassian.listMcpTools", {
        user: { email: "person@example.com" }
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
            name: "atlassian_list_mcp_tools",
            arguments: {}
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
