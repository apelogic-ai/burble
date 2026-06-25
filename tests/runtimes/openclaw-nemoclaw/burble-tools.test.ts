import { describe, expect, test } from "bun:test";
import { createBurbleToolExecutor } from "../../../runtimes/openclaw-nemoclaw/src/burble-tools";
import type { RuntimeConfig } from "../../../runtimes/openclaw-nemoclaw/src/config";
import type { RunRequest } from "../../../runtimes/openclaw-nemoclaw/src/types";
import { providerToolCatalog } from "../../../src/providers/catalog";

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
  openClawCodeMode: false,
  openClawFastMode: false,
  openClawRawStreamDebug: false,
  openClawGatewayPort: 18789,
  openClawGatewayBind: "loopback",
  openClawGatewayToken: "gateway-token",
  llmModel: "openai:gpt-5.4",
  ollamaBaseUrl: "https://ollama.com"
};

function providerManifestRequest(): RunRequest {
  return {
    runId: "run_provider_tools",
    runtime: {
      id: "rt_u123",
      manifest: {
        version: "1",
        policyHash: "policy-123",
        skills: [],
        memory: {
          userMemoryEnabled: false,
          workspaceMemoryEnabled: false,
          jobMemoryEnabled: false
        },
        tools: providerToolCatalog.map((tool) => ({
          name: tool.name,
          alias: tool.alias,
          provider: tool.provider,
          title: tool.title,
          description: tool.description,
          enabled: true,
          risk: tool.risk ?? "read",
          routeRequired: true,
          confirmation: tool.confirmation ?? "none",
          input: Object.entries(tool.input)
            .map(([name, spec]) => ({
              name,
              type:
                spec.type === "array"
                  ? "string[]"
                  : spec.type === "enum"
                    ? "enum"
                    : spec.type,
              required: spec.optional !== true,
              ...(spec.nullable ? { nullable: true } : {}),
              ...(spec.description ? { description: spec.description } : {}),
              ...("values" in spec ? { values: spec.values } : {}),
              ...(spec.aliases?.length ? { aliases: spec.aliases } : {})
            }))
            .sort((left, right) => left.name.localeCompare(right.name))
        }))
      }
    },
    input: {
      text: "test",
      connections: {
        github: { connected: true, email: "person@example.com" },
        google: { connected: true, email: "person@example.com" },
        hubspot: { connected: true, email: "person@example.com" },
        jira: { connected: true, email: "person@example.com" },
        slack: { connected: true, email: "person@example.com" }
      }
    }
  };
}

function createMcpProviderExecutor() {
  return createBurbleToolExecutor(
    {
      ...config,
      mcpGatewayUrl: "http://agentgateway:3000/mcp",
      runtimeJwt: "runtime-jwt"
    },
    "rt_u123",
    providerManifestRequest()
  );
}

function mockMcpGatewayPayloads() {
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
  return {
    payloads,
    restore() {
      globalThis.fetch = originalFetch;
    }
  };
}

describe("createBurbleToolExecutor", () => {
  test("requires MCP gateway settings for provider tools", async () => {
    const executor = createBurbleToolExecutor(config, "rt_u123");
    await expect(executor("github.getAuthenticatedUser", {})).rejects.toThrow(
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
      const executor = createMcpProviderExecutor();
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

  test("supports the generic Burble provider bridge envelope", async () => {
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
          { headers: { "mcp-session-id": "session-123" } }
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
                    content: { name: "Scratchpad" }
                  })
                }
              ]
            },
            jsonrpc: "2.0",
            id: "request-id"
          })}`,
          ""
        ].join("\n"),
        { headers: { "content-type": "text/event-stream" } }
      );
    }) as typeof fetch;

    try {
      const executor = createMcpProviderExecutor();
      const result = await executor("burble_provider_call", {
        input: {
          toolName: "google.getDriveFile",
          input: {
            fileId: "file-123",
            jobId: "job-123"
          }
        }
      });

      expect(result.content).toEqual({ name: "Scratchpad" });
      expect(await requests[2].json()).toMatchObject({
        method: "tools/call",
        params: {
          name: "google_get_drive_file",
          arguments: {
            fileId: "file-123",
            jobId: "job-123"
          }
        }
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("adds trusted scheduled job identity to provider bridge calls", async () => {
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
          { headers: { "mcp-session-id": "session-123" } }
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
                    content: { name: "Scratchpad" }
                  })
                }
              ]
            },
            jsonrpc: "2.0",
            id: "request-id"
          })}`,
          ""
        ].join("\n"),
        { headers: { "content-type": "text/event-stream" } }
      );
    }) as typeof fetch;

    try {
      const scheduledRequest = providerManifestRequest();
      scheduledRequest.input.scheduledJob = {
        jobId: "job-123",
        capabilityProfile: "scheduled_job",
        allowedTools: ["google.getDriveFile"],
        routeId: "convrt_abc123",
        runtimeType: "openclaw",
        stateRefs: [],
        visibilityPolicy: {}
      };
      const executor = createBurbleToolExecutor(
        {
          ...config,
          mcpGatewayUrl: "http://agentgateway:3000/mcp",
          runtimeJwt: "runtime-jwt"
        },
        "rt_u123",
        scheduledRequest
      );
      const result = await executor("burble_provider_call", {
        input: {
          toolName: "google.getDriveFile",
          input: {
            fileId: "file-123"
          }
        }
      });

      expect(result.content).toEqual({ name: "Scratchpad" });
      expect(await requests[2].json()).toMatchObject({
        method: "tools/call",
        params: {
          name: "google_get_drive_file",
          arguments: {
            fileId: "file-123",
            jobId: "job-123"
          }
        }
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("maps manifest provider tool aliases to MCP names with generic input", async () => {
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
          { headers: { "mcp-session-id": "session-123" } }
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
                    content: { ok: true }
                  })
                }
              ]
            },
            jsonrpc: "2.0",
            id: "request-id"
          })}`,
          ""
        ].join("\n"),
        { headers: { "content-type": "text/event-stream" } }
      );
    }) as typeof fetch;

    try {
      const executor = createBurbleToolExecutor(
        {
          ...config,
          mcpGatewayUrl: "http://agentgateway:3000/mcp",
          runtimeJwt: "runtime-jwt"
        },
        "rt_u123",
        {
          runId: "run_123",
          runtime: {
            id: "rt_u123",
            manifest: {
              version: "1",
              policyHash: "policy-123",
              skills: [],
              memory: {
                userMemoryEnabled: false,
                workspaceMemoryEnabled: false,
                jobMemoryEnabled: false
              },
              tools: [
                {
                  name: "google_future_tool",
                  alias: "google.futureTool",
                  provider: "google",
                  enabled: true
                }
              ]
            }
          },
          input: {
            text: "use a new Google tool",
            connections: {
              github: { connected: false },
              google: { connected: true, email: "person@example.com" }
            }
          }
        }
      );
      const result = await executor("google.futureTool", {
        input: {
          first: "value",
          nested: { ok: true }
        }
      });

      expect(result.content).toEqual({ ok: true });
      expect(await requests[2].json()).toMatchObject({
        method: "tools/call",
        params: {
          name: "google_future_tool",
          arguments: {
            first: "value",
            nested: { ok: true }
          }
        }
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("requires the documented provider bridge input wrapper", async () => {
    const executor = createBurbleToolExecutor({
      ...config,
      mcpGatewayUrl: "http://agentgateway:3000/mcp",
      runtimeJwt: "runtime-jwt"
    });

    await expect(
      executor("burble_provider_call", {
        toolName: "google.getDriveFile",
        input: {
          fileId: "file-123",
          jobId: "job-123"
        }
      })
    ).rejects.toThrow("burble_provider_call requires input.toolName");
  });

  test("preserves scheduled job identity for direct provider MCP calls", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
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
          { headers: { "mcp-session-id": "session-123" } }
        );
      }
      if (payload.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (payload.method === "tools/call") {
        calls.push(payload.params);
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
                    content: { ok: true }
                  })
                }
              ]
            },
            jsonrpc: "2.0",
            id: "request-id"
          })}`,
          ""
        ].join("\n"),
        { headers: { "content-type": "text/event-stream" } }
      );
    }) as typeof fetch;

    try {
      const executor = createMcpProviderExecutor();

      await executor("github.listMyPullRequests", {
        input: { limit: 3, jobId: "job-123" }
      });
      await executor("jira.searchIssues", {
        input: { jql: "assignee = currentUser()", jobId: "job-123" }
      });
      await executor("google.getDriveFile", {
        input: { fileId: "file-123", jobId: "job-123" }
      });

      expect(calls).toEqual([
        {
          name: "github_list_my_pull_requests",
          arguments: { limit: 3, jobId: "job-123" }
        },
        {
          name: "jira_search_issues",
          arguments: { jql: "assignee = currentUser()", jobId: "job-123" }
        },
        {
          name: "google_get_drive_file",
          arguments: { fileId: "file-123", jobId: "job-123" }
        }
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("passes GitHub pull request list arguments to MCP", async () => {
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
          { headers: { "mcp-session-id": "session-123" } }
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
                    content: []
                  })
                }
              ]
            },
            jsonrpc: "2.0",
            id: "request-id"
          })}`,
          ""
        ].join("\n"),
        { headers: { "content-type": "text/event-stream" } }
      );
    }) as typeof fetch;

    try {
      const executor = createMcpProviderExecutor();
      await executor("github.listMyPullRequests", {
        input: {
          limit: 3,
          state: "closed",
          sort: "created",
          order: "asc",
          owner: "example-org",
          repo: "acme/app"
        }
      });

      expect(await requests[2].json()).toMatchObject({
        method: "tools/call",
        params: {
          name: "github_list_my_pull_requests",
          arguments: {
            limit: 3,
            state: "closed",
            sort: "created",
            order: "asc",
            owner: "example-org",
            repo: "acme/app"
          }
        }
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("passes GitHub write arguments to MCP", async () => {
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
          { headers: { "mcp-session-id": "session-123" } }
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
                    content: {
                      title: "New issue",
                      url: "https://github.com/acme/app/issues/12",
                      number: 12
                    }
                  })
                }
              ]
            },
            jsonrpc: "2.0",
            id: "request-id"
          })}`,
          ""
        ].join("\n"),
        { headers: { "content-type": "text/event-stream" } }
      );
    }) as typeof fetch;

    try {
      const executor = createMcpProviderExecutor();
      await executor("github.createIssue", {
        input: {
          repo: "acme/app",
          title: "New issue",
          labels: ["bug"]
        }
      });

      expect(await requests[2].json()).toMatchObject({
        method: "tools/call",
        params: {
          name: "github_create_issue",
          arguments: {
            repo: "acme/app",
            title: "New issue",
            labels: ["bug"]
          }
        }
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("lists MCP provider tools from the gateway", async () => {
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
              tools: [
                {
                  name: "github_list_my_pull_requests",
                  title: "GitHub open pull requests",
                  description: "List open GitHub pull requests.",
                  inputSchema: {}
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
      const executor = createMcpProviderExecutor();
      const result = await executor("burble.mcp.listTools", {});

      expect(result.content).toEqual([
        {
          name: "github_list_my_pull_requests",
          title: "GitHub open pull requests",
          description: "List open GitHub pull requests.",
          inputSchema: {}
        }
      ]);
      expect(await requests[2].json()).toMatchObject({
        method: "tools/list"
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("sends active conversation messages through the internal gateway", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Request[] = [];
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json({
        classification: "user_private",
        content: {
          ok: true,
          transport: "slack",
          conversationId: "C123",
          messageId: "1779841120.000"
        }
      });
    }) as typeof fetch;

    try {
      const executor = createBurbleToolExecutor(
        {
          ...config,
          mcpGatewayUrl: "http://agentgateway:3000/mcp",
          runtimeJwt: "runtime-jwt"
        },
        "rt_u123",
        {
          runtime: { id: "rt_u123" },
          input: {
            text: "run a long task",
            conversation: {
              routeId: "convrt_abc123",
              source: "slack",
              workspaceId: "T123",
              channelId: "C123",
              rootId: "channel:C123:thread:1779841118.237",
              isDirectMessage: false
            },
            connections: {
              github: { connected: false }
            }
          }
        }
      );
      const result = await executor("conversation.sendMessage", {
        input: {
          text: "Long task finished.",
          channelId: "C999"
        }
      });

      expect(result.content).toEqual({
        ok: true,
        transport: "slack",
        conversationId: "C123",
        messageId: "1779841120.000"
      });
      expect(requests).toHaveLength(1);
      expect(requests[0].url).toBe(
        "http://burble-app:3000/internal/tools/conversation.sendMessage/execute"
      );
      expect(requests[0].headers.get("authorization")).toBe(
        "Bearer runtime-secret"
      );
      expect(requests[0].headers.get("x-burble-runtime-id")).toBe("rt_u123");
      expect(await requests[0].json()).toEqual({
        input: { text: "Long task finished.", routeId: "convrt_abc123" },
        conversation: {
          routeId: "convrt_abc123",
          source: "slack",
          workspaceId: "T123",
          channelId: "C123",
          rootId: "channel:C123:thread:1779841118.237",
          isDirectMessage: false
        }
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("sends scheduled job messages with the stored route and job id", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Request[] = [];
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json({
        classification: "user_private",
        content: {
          ok: true,
          transport: "slack",
          conversationId: "CENG",
          routeId: "convrt_grant",
          messageId: "1779841120.000"
        }
      });
    }) as typeof fetch;

    try {
      const executor = createBurbleToolExecutor(config, "rt_u123", {
        runtime: { id: "rt_u123" },
        input: {
          text: "run a scheduled report",
          scheduledJob: {
            jobId: "daily-standup",
            capabilityProfile: "scheduled_job",
            allowedTools: ["conversation.sendMessage"],
            routeId: "convrt_grant",
            runtimeType: "openclaw",
            stateRefs: [],
            visibilityPolicy: {
              maxOutputVisibility: "public"
            }
          },
          connections: {
            github: { connected: false }
          }
        }
      });
      const result = await executor("conversation.sendMessage", {
        input: {
          text: "Daily standup is ready.",
          routeId: "convrt_prompt_supplied",
          jobId: "prompt-supplied-job"
        }
      });

      expect(result.content).toMatchObject({
        ok: true,
        transport: "slack",
        conversationId: "CENG",
        routeId: "convrt_grant",
        messageId: "1779841120.000"
      });
      expect(requests).toHaveLength(1);
      expect(await requests[0].json()).toEqual({
        scheduledJob: {
          jobId: "daily-standup",
          capabilityProfile: "scheduled_job",
          allowedTools: ["conversation.sendMessage"],
          routeId: "convrt_grant",
          runtimeType: "openclaw",
          stateRefs: [],
          visibilityPolicy: {
            maxOutputVisibility: "public"
          }
        },
        input: {
          text: "Daily standup is ready.",
          routeId: "convrt_grant",
          jobId: "daily-standup"
        }
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("does not use model-supplied route ids for scheduled delivery", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Request[] = [];
    globalThis.fetch = (async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({
        classification: "user_private",
        content: { ok: true }
      });
    }) as typeof fetch;

    try {
      const executor = createBurbleToolExecutor(config, "rt_u123", {
        runtime: { id: "rt_u123" },
        input: {
          text: "run a scheduled report",
          scheduledJob: {
            jobId: "daily-standup",
            capabilityProfile: "scheduled_job",
            allowedTools: ["conversation.sendMessage"],
            runtimeType: "openclaw",
            stateRefs: [],
            visibilityPolicy: {
              maxOutputVisibility: "public"
            }
          },
          connections: {
            github: { connected: false }
          }
        }
      });

      await expect(
        executor("conversation.sendMessage", {
          input: {
            text: "Daily standup is ready.",
            routeId: "#burble-test"
          }
        })
      ).rejects.toThrow(
        "conversation.sendMessage requires a trusted scheduled route id or active conversation"
      );

      expect(requests).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("falls back to the active conversation for scheduled delivery without a stored route", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Request[] = [];
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json({
        classification: "user_private",
        content: {
          ok: true,
          transport: "slack",
          conversationId: "D123",
          routeId: "convrt_dm",
          messageId: "1779841120.000"
        }
      });
    }) as typeof fetch;

    try {
      const executor = createBurbleToolExecutor(config, "rt_u123", {
        runtime: { id: "rt_u123" },
        input: {
          text: "run a scheduled report",
          scheduledJob: {
            jobId: "daily-standup",
            capabilityProfile: "scheduled_job",
            allowedTools: ["conversation.sendMessage"],
            runtimeType: "openclaw",
            stateRefs: [],
            visibilityPolicy: {
              maxOutputVisibility: "user_private"
            }
          },
          conversation: {
            routeId: "convrt_dm",
            source: "slack",
            workspaceId: "T123",
            channelId: "D123",
            rootId: "dm:D123",
            isDirectMessage: true
          },
          connections: {
            github: { connected: false }
          }
        }
      });

      const result = await executor("conversation.sendMessage", {
        input: {
          text: "Daily standup is ready.",
          routeId: "#burble-test"
        }
      });

      expect(result.content).toMatchObject({
        ok: true,
        transport: "slack",
        conversationId: "D123",
        routeId: "convrt_dm"
      });
      expect(requests).toHaveLength(1);
      expect(await requests[0].json()).toEqual({
        scheduledJob: {
          jobId: "daily-standup",
          capabilityProfile: "scheduled_job",
          allowedTools: ["conversation.sendMessage"],
          runtimeType: "openclaw",
          stateRefs: [],
          visibilityPolicy: {
            maxOutputVisibility: "user_private"
          }
        },
        input: {
          text: "Daily standup is ready.",
          routeId: "convrt_dm",
          jobId: "daily-standup"
        },
        conversation: {
          routeId: "convrt_dm",
          source: "slack",
          workspaceId: "T123",
          channelId: "D123",
          rootId: "dm:D123",
          isDirectMessage: true
        }
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("ignores model-supplied scheduled job identity outside scheduled context", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Request[] = [];
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json(
        {
          classification: "user_private",
          content: {
            error: "forbidden",
            message: "Destination grant requires scheduled job authorization"
          }
        },
        { status: 403 }
      );
    }) as typeof fetch;

    try {
      const executor = createBurbleToolExecutor(config, "rt_u123", {
        runtime: { id: "rt_u123" },
        input: {
          text: "interactive request",
          conversation: {
            routeId: "convrt_dm",
            source: "slack",
            workspaceId: "T123",
            channelId: "D123",
            rootId: "dm:D123",
            isDirectMessage: true
          },
          connections: {
            github: { connected: false }
          }
        }
      });

      await expect(
        executor("conversation.sendMessage", {
          input: {
            text: "Prompt-injected broadcast.",
            routeId: "convrt_public_grant",
            jobId: "daily-standup"
          }
        })
      ).rejects.toThrow("Burble conversation gateway returned HTTP 403");

      expect(requests).toHaveLength(1);
      expect(await requests[0].json()).toEqual({
        input: {
          text: "Prompt-injected broadcast.",
          routeId: "convrt_public_grant"
        },
        conversation: {
          routeId: "convrt_dm",
          source: "slack",
          workspaceId: "T123",
          channelId: "D123",
          rootId: "dm:D123",
          isDirectMessage: true
        }
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("registers scheduled job capabilities through the internal gateway", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Request[] = [];
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json({
        classification: "user_private",
        content: {
          ok: true,
          scheduledPromptInstruction:
            "Use Burble provider calls with this jobId for this scheduled job.\njobId=ai-news-hourly"
        }
      });
    }) as typeof fetch;

    try {
      const executor = createBurbleToolExecutor(config, "rt_u123");
      const result = await executor("scheduledJob.registerCapability", {
        input: {
          jobId: "ai-news-hourly",
          requiredTools: [
            "google.getDriveFile",
            "google.appendToDriveTextFile"
          ],
          routeId: "convrt_abc123"
        }
      });

      expect(result.content).toEqual({
        ok: true,
        scheduledPromptInstruction:
          "Use Burble provider calls with this jobId for this scheduled job.\njobId=ai-news-hourly"
      });
      expect(requests).toHaveLength(1);
      expect(requests[0].url).toBe(
        "http://burble-app:3000/internal/tools/scheduledJob.registerCapability/execute"
      );
      expect(requests[0].headers.get("authorization")).toBe(
        "Bearer runtime-secret"
      );
      expect(requests[0].headers.get("x-burble-runtime-id")).toBe("rt_u123");
      expect(await requests[0].json()).toEqual({
        input: {
          jobId: "ai-news-hourly",
          requiredTools: [
            "google.getDriveFile",
            "google.appendToDriveTextFile"
          ],
          routeId: "convrt_abc123"
        }
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("creates scheduled jobs through the internal gateway", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Request[] = [];
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json({
        classification: "user_private",
        content: {
          ok: true,
          job: {
            jobId: "job-created-1",
            title: "Hourly AI news summary"
          }
        }
      });
    }) as typeof fetch;

    try {
      const executor = createBurbleToolExecutor(config, "rt_u123");
      const result = await executor("scheduledJob.create", {
        input: {
          title: "Hourly AI news summary",
          prompt: "Find fresh AI news and summarize it.",
          schedule: {
            kind: "interval",
            every: { hours: 1 }
          }
        }
      });

      expect(result.content).toEqual({
        ok: true,
        job: {
          jobId: "job-created-1",
          title: "Hourly AI news summary"
        }
      });
      expect(requests).toHaveLength(1);
      expect(requests[0].url).toBe(
        "http://burble-app:3000/internal/tools/scheduledJob.create/execute"
      );
      expect(requests[0].headers.get("authorization")).toBe(
        "Bearer runtime-secret"
      );
      expect(requests[0].headers.get("x-burble-runtime-id")).toBe("rt_u123");
      expect(await requests[0].json()).toEqual({
        input: {
          title: "Hourly AI news summary",
          prompt: "Find fresh AI news and summarize it.",
          schedule: {
            kind: "interval",
            every: { hours: 1 }
          }
        }
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("executes runtime conformance echo through the internal gateway", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Request[] = [];
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json({
        classification: "user_private",
        content: {
          ok: true,
          toolName: "runtime.conformance.echo",
          input: {
            message: "scheduled provider bridge probe"
          }
        }
      });
    }) as typeof fetch;

    try {
      const executor = createBurbleToolExecutor(config, "rt_u123", {
        input: {
          scheduledJob: {
            jobId: "contract-scheduled-job",
            routeId: "convrt_abc123"
          }
        }
      } as never);
      const result = await executor("burble_provider_call", {
        input: {
          toolName: "runtime.conformance.echo",
          input: {
            jobId: "contract-scheduled-job",
            message: "scheduled provider bridge probe"
          }
        }
      });

      expect(result.content).toEqual({
        ok: true,
        toolName: "runtime.conformance.echo",
        input: {
          message: "scheduled provider bridge probe"
        }
      });
      expect(requests).toHaveLength(1);
      expect(requests[0].url).toBe(
        "http://burble-app:3000/internal/tools/runtime.conformance.echo/execute"
      );
      expect(requests[0].headers.get("authorization")).toBe(
        "Bearer runtime-secret"
      );
      expect(requests[0].headers.get("x-burble-runtime-id")).toBe("rt_u123");
      expect(await requests[0].json()).toEqual({
        input: {
          jobId: "contract-scheduled-job",
          message: "scheduled provider bridge probe"
        },
        scheduledJob: {
          jobId: "contract-scheduled-job",
          routeId: "convrt_abc123"
        }
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("forwards object scheduled state refs before registration", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Request[] = [];
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json({
        classification: "user_private",
        content: { ok: true }
      });
    }) as typeof fetch;

    try {
      const executor = createBurbleToolExecutor(config, "rt_u123");
      await executor("scheduledJob.registerCapability", {
        input: {
          jobId: "ai-news-hourly",
          requiredTools: ["google.getDriveFile"],
          routeId: "convrt_abc123",
          stateRefs: [
            {
              provider: "google",
              kind: "drive_file",
              id: "file-123"
            }
          ]
        }
      });

      expect(requests).toHaveLength(1);
      expect(await requests[0].json()).toEqual({
        input: {
          jobId: "ai-news-hourly",
          requiredTools: ["google.getDriveFile"],
          routeId: "convrt_abc123",
          stateRefs: [
            {
              provider: "google",
              kind: "drive_file",
              id: "file-123"
            }
          ]
        }
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns scheduled registration validation errors as tool results", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, _init) =>
      Response.json(
        {
          classification: "user_private",
          content: {
            error: "invalid_scheduled_job_capability_input",
            message:
              "scheduledJob.registerCapability requires every stateRefs entry to include provider and kind strings."
          }
        },
        { status: 400 }
      )) as typeof fetch;

    try {
      const executor = createBurbleToolExecutor(config, "rt_u123");
      const result = await executor("scheduledJob.registerCapability", {
        input: {
          jobId: "ai-news-hourly",
          requiredTools: ["google.getDriveFile"],
          stateRefs: [{ provider: "google" }]
        }
      });

      expect(result).toEqual({
        classification: "user_private",
        content: {
          error: "invalid_scheduled_job_capability_input",
          message:
            "scheduledJob.registerCapability requires every stateRefs entry to include provider and kind strings."
        }
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("fetches current request attachments through the internal gateway", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Request[] = [];
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json({
        classification: "user_private",
        content: {
          attachment: {
            id: "slack:F123",
            externalId: "F123",
            source: "slack",
            kind: "image",
            mimeType: "image/png",
            name: "screenshot.png"
          },
          contentBase64: "aW1hZ2U="
        }
      });
    }) as typeof fetch;

    try {
      const executor = createBurbleToolExecutor(config, "rt_u123", {
        runId: "run_123",
        runtime: { id: "rt_u123" },
        input: {
          text: "what is in this image?",
          attachments: [
            {
              id: "slack:F123",
              externalId: "F123",
              source: "slack",
              kind: "image",
              mimeType: "image/png",
              name: "screenshot.png"
            }
          ],
          connections: {
            github: { connected: false }
          }
        }
      });
      const result = await executor("conversation.getAttachment", {
        input: { attachmentId: "slack:F123" }
      });

      expect(result.content).toMatchObject({
        attachment: {
          id: "slack:F123",
          externalId: "F123"
        },
        contentBase64: "aW1hZ2U="
      });
      expect(requests).toHaveLength(1);
      expect(requests[0].url).toBe(
        "http://burble-app:3000/internal/tools/conversation.getAttachment/execute"
      );
      expect(requests[0].headers.get("authorization")).toBe(
        "Bearer runtime-secret"
      );
      expect(requests[0].headers.get("x-burble-runtime-id")).toBe("rt_u123");
      expect(await requests[0].json()).toEqual({
        runId: "run_123",
        input: { attachmentId: "slack:F123" },
        attachments: [
          {
            id: "slack:F123",
            externalId: "F123",
            source: "slack",
            kind: "image",
            mimeType: "image/png",
            name: "screenshot.png"
          }
        ]
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
      const executor = createMcpProviderExecutor();
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
      await executor("google.searchDriveFiles", {
        user: { email: "person@example.com" },
        input: { query: "roadmap", limit: 5 }
      });
      await executor("google.createDriveTextFile", {
        user: { email: "person@example.com" },
        input: { name: "Test", text: "Test One" }
      });
      await executor("google.createDriveTextFile", {
        user: { email: "person@example.com" },
        input: { name: "Blank" }
      });
      await executor("google.searchCalendarEvents", {
        user: { email: "person@example.com" },
        input: {
          query: "standup",
          timeMin: "2026-05-26T00:00:00.000Z",
          limit: 3
        }
      });
      await executor("google.searchMailMessages", {
        user: { email: "person@example.com" },
        input: { query: "from:alex", limit: 2 }
      });
      await executor("google.slidesSearchPresentations", {
        user: { email: "person@example.com" },
        input: { query: "roadmap", limit: 4 }
      });
      await executor("google.slidesGetPresentation", {
        user: { email: "person@example.com" },
        input: { presentationId: "deck-123", includeSlides: false }
      });
      await executor("google.slidesProbeTemplate", {
        user: { email: "person@example.com" },
        input: { presentationId: "template-123" }
      });
      await executor("google.slidesCopyPresentation", {
        user: { email: "person@example.com" },
        input: {
          presentationId: "template-123",
          name: "ApeLogic Template Copy"
        }
      });
      await executor("google.slidesCreateSlide", {
        user: { email: "person@example.com" },
        input: {
          presentation_id: "deck-copy",
          slide_index: 2,
          predefined_layout: "TITLE_AND_TWO_COLUMNS",
          placeholders: [
            { placeholder_type: "TITLE", value: "Test slide 3" },
            { role: "BODY", index: 0, content: "Left text" },
            { role: "BODY", index: 1, content: "Right text" }
          ]
        }
      });
      await executor("google.slidesFillPlaceholders", {
        user: { email: "person@example.com" },
        input: {
          presentation_id: "deck-copy",
          slide_object_id: "slide-2",
          placeholders: [
            { placeholder_type: "TITLE", value: "ApeLogic" },
            {
              role: "BODY",
              content: "Test presentation from template"
            }
          ]
        }
      });
      await executor("google.analyticsListProperties", {
        user: { email: "person@example.com" },
        input: { limit: 6 }
      });
      await executor("google.analyticsGetMetadata", {
        user: { email: "person@example.com" },
        input: {
          propertyId: "properties/1234",
          dimensionQuery: "page",
          metricQuery: "views",
          limit: 8
        }
      });
      await executor("google.analyticsRunReport", {
        user: { email: "person@example.com" },
        input: {
          propertyId: "properties/1234",
          startDate: "7daysAgo",
          endDate: "yesterday",
          metrics: ["activeUsers"],
          dimensions: ["country"],
          limit: 10
        }
      });
      await executor("hubspot.getAuthenticatedUser", {
        user: { email: "person@example.com" }
      });
      await executor("hubspot.searchContacts", {
        user: { email: "person@example.com" },
        input: { query: "Acme", limit: 5 }
      });
      await executor("hubspot.searchCompanies", {
        user: { email: "person@example.com" },
        input: { query: "Acme", limit: 5 }
      });
      await executor("hubspot.searchDeals", {
        user: { email: "person@example.com" },
        input: { query: "renewal", limit: 3 }
      });
      await executor("hubspot.searchCrmObjects", {
        user: { email: "person@example.com" },
        input: {
          objectType: "users",
          limit: 3,
          properties: ["hs_email"]
        }
      });
      await executor("hubspot.listOwners", {
        user: { email: "person@example.com" },
        input: { limit: 10 }
      });
      await executor("hubspot.listUsers", {
        user: { email: "person@example.com" },
        input: { limit: 10 }
      });
      await executor("hubspot.readApiResource", {
        user: { email: "person@example.com" },
        input: {
          path: "/crm/v3/schemas/deals",
          query: { archived: false }
        }
      });
      await executor("jira.createIssue", {
        user: { email: "person@example.com" },
        input: {
          projectKey: "DM",
          issueTypeName: "Task",
          summary: "test ticket from slack",
          assigneeAccountId: "acct-example"
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
            name: "google_search_drive_files",
            arguments: { query: "roadmap", limit: 5 }
          }
        },
        {
          method: "tools/call",
          params: {
            name: "google_create_drive_text_file",
            arguments: { name: "Test", text: "Test One" }
          }
        },
        {
          method: "tools/call",
          params: {
            name: "google_create_drive_text_file",
            arguments: { name: "Blank" }
          }
        },
        {
          method: "tools/call",
          params: {
            name: "google_search_calendar_events",
            arguments: {
              query: "standup",
              timeMin: "2026-05-26T00:00:00.000Z",
              limit: 3
            }
          }
        },
        {
          method: "tools/call",
          params: {
            name: "google_search_mail_messages",
            arguments: { query: "from:alex", limit: 2 }
          }
        },
        {
          method: "tools/call",
          params: {
            name: "google_slides_search_presentations",
            arguments: { query: "roadmap", limit: 4 }
          }
        },
        {
          method: "tools/call",
          params: {
            name: "google_slides_get_presentation",
            arguments: { presentationId: "deck-123", includeSlides: false }
          }
        },
        {
          method: "tools/call",
          params: {
            name: "google_slides_probe_template",
            arguments: { presentationId: "template-123" }
          }
        },
        {
          method: "tools/call",
          params: {
            name: "google_slides_copy_presentation",
            arguments: {
              presentationId: "template-123",
              name: "ApeLogic Template Copy"
            }
          }
        },
        {
          method: "tools/call",
          params: {
            name: "google_slides_create_slide",
            arguments: {
              presentation_id: "deck-copy",
              slide_index: 2,
              predefined_layout: "TITLE_AND_TWO_COLUMNS",
              placeholders: [
                { placeholder_type: "TITLE", value: "Test slide 3" },
                { role: "BODY", index: 0, content: "Left text" },
                { role: "BODY", index: 1, content: "Right text" }
              ]
            }
          }
        },
        {
          method: "tools/call",
          params: {
            name: "google_slides_fill_placeholders",
            arguments: {
              presentation_id: "deck-copy",
              slide_object_id: "slide-2",
              placeholders: [
                { placeholder_type: "TITLE", value: "ApeLogic" },
                {
                  role: "BODY",
                  content: "Test presentation from template"
                }
              ]
            }
          }
        },
        {
          method: "tools/call",
          params: {
            name: "google_analytics_list_properties",
            arguments: { limit: 6 }
          }
        },
        {
          method: "tools/call",
          params: {
            name: "google_analytics_get_metadata",
            arguments: {
              propertyId: "properties/1234",
              dimensionQuery: "page",
              metricQuery: "views",
              limit: 8
            }
          }
        },
        {
          method: "tools/call",
          params: {
            name: "google_analytics_run_report",
            arguments: {
              propertyId: "properties/1234",
              startDate: "7daysAgo",
              endDate: "yesterday",
              metrics: ["activeUsers"],
              dimensions: ["country"],
              limit: 10
            }
          }
        },
        {
          method: "tools/call",
          params: {
            name: "hubspot_get_authenticated_user",
            arguments: {}
          }
        },
        {
          method: "tools/call",
          params: {
            name: "hubspot_search_contacts",
            arguments: { query: "Acme", limit: 5 }
          }
        },
        {
          method: "tools/call",
          params: {
            name: "hubspot_search_companies",
            arguments: { query: "Acme", limit: 5 }
          }
        },
        {
          method: "tools/call",
          params: {
            name: "hubspot_search_deals",
            arguments: { query: "renewal", limit: 3 }
          }
        },
        {
          method: "tools/call",
          params: {
            name: "hubspot_search_crm_objects",
            arguments: {
              objectType: "users",
              limit: 3,
              properties: ["hs_email"]
            }
          }
        },
        {
          method: "tools/call",
          params: {
            name: "hubspot_list_owners",
            arguments: { limit: 10 }
          }
        },
        {
          method: "tools/call",
          params: {
            name: "hubspot_list_users",
            arguments: { limit: 10 }
          }
        },
        {
          method: "tools/call",
          params: {
            name: "hubspot_read_api_resource",
            arguments: {
              path: "/crm/v3/schemas/deals",
              query: { archived: false }
            }
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
              assigneeAccountId: "acct-example"
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

  test("forwards model-style manifest inputs to the gateway for shared coercion", async () => {
    const mock = mockMcpGatewayPayloads();
    try {
      const executor = createMcpProviderExecutor();
      await executor("google.slidesGetPresentation", {
        user: { email: "person@example.com" },
        input: { presentationId: "deck-123", includeSlides: "false" }
      });
      await executor("google.analyticsListProperties", {
        user: { email: "person@example.com" },
        input: { limit: "6" }
      });
      await executor("google.slidesCreateSlide", {
        user: { email: "person@example.com" },
        input: {
          presentation_id: "deck-copy",
          slide_index: "2",
          predefined_layout: "TITLE_AND_BODY",
          title: "Test slide"
        }
      });

      expect(mock.payloads).toMatchObject([
        { method: "initialize" },
        { method: "notifications/initialized" },
        {
          method: "tools/call",
          params: {
            name: "google_slides_get_presentation",
            arguments: { presentationId: "deck-123", includeSlides: "false" }
          }
        },
        {
          method: "tools/call",
          params: {
            name: "google_analytics_list_properties",
            arguments: { limit: "6" }
          }
        },
        {
          method: "tools/call",
          params: {
            name: "google_slides_create_slide",
            arguments: {
              presentation_id: "deck-copy",
              slide_index: "2",
              predefined_layout: "TITLE_AND_BODY",
              title: "Test slide"
            }
          }
        }
      ]);
    } finally {
      mock.restore();
    }
  });

  test("keeps Google Slides placeholder synonym payloads intact", async () => {
    const mock = mockMcpGatewayPayloads();
    try {
      const executor = createMcpProviderExecutor();
      await executor("google.slidesFillPlaceholders", {
        user: { email: "person@example.com" },
        input: {
          deck_id: "deck-copy",
          slide_id: "slide-2",
          update: [
            { placeholder_type: "TITLE", value: "ApeLogic" },
            { role: "BODY", placeholderIndex: 1, content: "Right text" }
          ]
        }
      });

      expect(mock.payloads).toMatchObject([
        { method: "initialize" },
        { method: "notifications/initialized" },
        {
          method: "tools/call",
          params: {
            name: "google_slides_fill_placeholders",
            arguments: {
              deck_id: "deck-copy",
              slide_id: "slide-2",
              update: [
                { placeholder_type: "TITLE", value: "ApeLogic" },
                { role: "BODY", placeholderIndex: 1, content: "Right text" }
              ]
            }
          }
        }
      ]);
    } finally {
      mock.restore();
    }
  });

  test("forwards mistyped required manifest inputs to the gateway", async () => {
    const mock = mockMcpGatewayPayloads();
    try {
      const executor = createMcpProviderExecutor();
      await executor("google.analyticsGetMetadata", {
        user: { email: "person@example.com" },
        input: { propertyId: 1234 }
      });
      expect(mock.payloads).toMatchObject([
        { method: "initialize" },
        { method: "notifications/initialized" },
        {
          method: "tools/call",
          params: {
            name: "google_analytics_get_metadata",
            arguments: { propertyId: 1234 }
          }
        }
      ]);
    } finally {
      mock.restore();
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
      const executor = createMcpProviderExecutor();
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
