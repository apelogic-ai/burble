import { describe, expect, test } from "bun:test";
import {
  attachRuntimeEventWebSocket,
  handleRuntimeRequest
} from "../../../runtimes/openclaw-nemoclaw/src/server";
import type { RuntimeConfig } from "../../../runtimes/openclaw-nemoclaw/src/config";

class FakeRuntimeWebSocket {
  readonly messages: string[] = [];
  closeCode: number | undefined;
  closeReason: string | undefined;

  send(message: string): void {
    this.messages.push(message);
  }

  close(code?: number, reason?: string): void {
    this.closeCode = code;
    this.closeReason = reason;
  }
}

const config: RuntimeConfig = {
  port: 8080,
  toolGatewayUrl: "http://burble-app:3000/internal/tools",
  internalToken: "secret",
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
  openClawRawStreamDebug: false,
  openClawGatewayPort: 18789,
  openClawGatewayBind: "loopback",
  openClawGatewayToken: "gateway-token",
  llmModel: "openai:gpt-5.4",
  ollamaBaseUrl: "https://ollama.com"
};

async function withMockFetch<T>(
  mock: typeof fetch,
  run: () => Promise<T>
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe("handleRuntimeRequest", () => {
  test("serves health checks", async () => {
    const response = await handleRuntimeRequest(
      new Request("http://runtime/healthz"),
      config
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  test("handles run requests", async () => {
    const response = await handleRuntimeRequest(
      new Request("http://runtime/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runtime: { id: "rt_u123" },
          input: {
            text: "who am I on GitHub?",
            connections: {
              github: {
                connected: true,
                email: "person@example.com"
              }
            }
          }
        })
      }),
      config,
      async () => ({
        classification: "user_private",
        content: { login: "octocat" }
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      response: {
        classification: "user_private",
        text: "Authenticated to GitHub as `octocat`."
      }
    });
  });

  test("streams run events as SSE when requested", async () => {
    const response = await handleRuntimeRequest(
      new Request("http://runtime/runs", {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          runtime: { id: "rt_u123" },
          input: {
            text: "who am I on GitHub?",
            connections: {
              github: {
                connected: true,
                email: "person@example.com"
              }
            }
          }
        })
      }),
      config,
      async () => ({
        classification: "user_private",
        content: { login: "octocat" }
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const stream = await response.text();

    expect(stream).toContain(": stream-start\n\n");
    expect(stream).toContain(
      `event: status\ndata: ${JSON.stringify({
        type: "status",
        text: "Loading Burble context..."
      })}\n\n`
    );
    expect(stream).toContain(
      `event: final\ndata: ${JSON.stringify({
        type: "final",
        response: {
          classification: "user_private",
          text: "Authenticated to GitHub as `octocat`."
        }
      })}\n\n`
    );
  });

  test("shares in-flight runs by run id across streaming and json clients", async () => {
    let toolCalls = 0;
    let resolveTool!: () => void;
    const toolGate = new Promise<void>((resolve) => {
      resolveTool = resolve;
    });
    const body = JSON.stringify({
      runId: "run-shared",
      runtime: { id: "rt_u123" },
      input: {
        text: "who am I on GitHub?",
        connections: {
          github: {
            connected: true,
            email: "person@example.com"
          }
        }
      }
    });
    const executeTool = async () => {
      toolCalls += 1;
      await toolGate;
      return {
        classification: "user_private" as const,
        content: { login: "octocat" }
      };
    };

    const streamResponse = await handleRuntimeRequest(
      new Request("http://runtime/runs", {
        method: "POST",
        headers: {
          accept: "application/x-ndjson",
          "content-type": "application/json"
        },
        body
      }),
      config,
      executeTool
    );
    const reader = streamResponse.body!.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    expect(decoder.decode(first.value)).toContain("Loading Burble context");

    const jsonResponsePromise = handleRuntimeRequest(
      new Request("http://runtime/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body
      }),
      config,
      executeTool
    );

    resolveTool();

    let streamText = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      streamText += decoder.decode(chunk.value);
    }

    const jsonResponse = await jsonResponsePromise;
    expect(jsonResponse.status).toBe(200);
    expect(await jsonResponse.json()).toEqual({
      response: {
        classification: "user_private",
        text: "Authenticated to GitHub as `octocat`."
      }
    });
    expect(streamText).toContain("\"type\":\"final\"");
    expect(streamText).toContain("Authenticated to GitHub as `octocat`.");
    expect(toolCalls).toBe(1);
  });

  test("starts runs asynchronously and exposes the final run snapshot", async () => {
    let resolveTool!: () => void;
    const toolGate = new Promise<void>((resolve) => {
      resolveTool = resolve;
    });

    const startResponse = await handleRuntimeRequest(
      new Request("http://runtime/runs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          prefer: "respond-async"
        },
        body: JSON.stringify({
          runId: "run-async",
          runtime: { id: "rt_u123" },
          input: {
            text: "who am I on GitHub?",
            connections: {
              github: {
                connected: true,
                email: "person@example.com"
              }
            }
          }
        })
      }),
      config,
      async () => {
        await toolGate;
        return {
          classification: "user_private" as const,
          content: { login: "octocat" }
        };
      }
    );

    expect(startResponse.status).toBe(200);
    expect(await startResponse.json()).toEqual({
      runId: "run-async",
      eventsUrl: "/runs/run-async/events"
    });

    const snapshotPromise = handleRuntimeRequest(
      new Request("http://runtime/runs/run-async"),
      config
    );
    resolveTool();

    const snapshotResponse = await snapshotPromise;
    expect(snapshotResponse.status).toBe(200);
    expect(await snapshotResponse.json()).toEqual({
      response: {
        classification: "user_private",
        text: "Authenticated to GitHub as `octocat`."
      }
    });
  });

  test("attaches WebSocket clients to existing run events", async () => {
    let resolveTool!: () => void;
    const toolGate = new Promise<void>((resolve) => {
      resolveTool = resolve;
    });

    const startResponse = await handleRuntimeRequest(
      new Request("http://runtime/runs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          prefer: "respond-async"
        },
        body: JSON.stringify({
          runId: "run-ws",
          runtime: { id: "rt_u123" },
          input: {
            text: "who am I on GitHub?",
            connections: {
              github: {
                connected: true,
                email: "person@example.com"
              }
            }
          }
        })
      }),
      config,
      async () => {
        await toolGate;
        return {
          classification: "user_private" as const,
          content: { login: "octocat" }
        };
      }
    );
    expect(await startResponse.json()).toMatchObject({ runId: "run-ws" });

    const ws = new FakeRuntimeWebSocket();
    attachRuntimeEventWebSocket("run-ws", ws);

    resolveTool();
    for (let index = 0; index < 20 && ws.closeCode === undefined; index += 1) {
      await Bun.sleep(1);
    }

    const events = ws.messages.map((message) => JSON.parse(message));
    expect(events).toContainEqual({
      type: "status",
      text: "Loading Burble context..."
    });
    expect(events.at(-1)).toEqual({
      type: "final",
      response: {
        classification: "user_private",
        text: "Authenticated to GitHub as `octocat`."
      }
    });
    expect(ws.closeCode).toBe(1000);
  });

  test("streams sanitized runtime errors with the underlying message", async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (message?: unknown) => {
      errors.push(String(message));
    };

    try {
      const response = await handleRuntimeRequest(
        new Request("http://runtime/runs", {
          method: "POST",
          headers: {
            accept: "application/x-ndjson",
            "content-type": "application/json"
          },
          body: JSON.stringify({
            runId: "run-timeout",
            runtime: { id: "rt_u123" },
            input: {
              text: "who am I on GitHub?",
              connections: {
                github: {
                  connected: true,
                  email: "person@example.com"
                }
              }
            }
          })
        }),
        config,
        async () => {
          throw new Error("OpenClaw CLI timed out");
        }
      );

      const events = (await response.text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

      expect(events.at(-1)).toEqual({
        type: "error",
        message: "Runtime run failed: OpenClaw CLI timed out"
      });
      expect(errors.join("\n")).toContain("runId=run-timeout");
      expect(errors.join("\n")).toContain("OpenClaw CLI timed out");
    } finally {
      console.error = originalError;
    }
  });

  test("summarizes OpenClaw model quota failures", async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (message?: unknown) => {
      errors.push(String(message));
    };

    try {
      const response = await handleRuntimeRequest(
        new Request("http://runtime/runs", {
          method: "POST",
          headers: {
            accept: "application/x-ndjson",
            "content-type": "application/json"
          },
          body: JSON.stringify({
            runId: "run-quota",
            runtime: { id: "rt_u123" },
            input: {
              text: "who am I on GitHub?",
              connections: {
                github: {
                  connected: true,
                  email: "person@example.com"
                }
              }
            }
          })
        }),
        config,
        async () => {
          throw new Error(
            "OpenClaw CLI exited with code 1: code=insufficient_quota message=You exceeded your current quota"
          );
        }
      );

      const events = (await response.text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

      expect(events.at(-1)).toEqual({
        type: "error",
        message:
          "Runtime run failed: Agent model provider quota is exhausted. Update the selected provider key/billing or switch AI_MODEL to a provider/model with available quota."
      });
      expect(errors.join("\n")).toContain("runId=run-quota");
      expect(errors.join("\n")).toContain("model provider quota is exhausted");
    } finally {
      console.error = originalError;
    }
  });

  test("does not report a runtime failure when the stream client disconnects", async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (message?: unknown) => {
      errors.push(String(message));
    };
    let resolveTool!: () => void;
    const toolGate = new Promise<void>((resolve) => {
      resolveTool = resolve;
    });

    try {
      const response = await handleRuntimeRequest(
        new Request("http://runtime/runs", {
          method: "POST",
          headers: {
            accept: "application/x-ndjson",
            "content-type": "application/json"
          },
          body: JSON.stringify({
            runId: "run-cancelled",
            runtime: { id: "rt_u123" },
            input: {
              text: "who am I on GitHub?",
              connections: {
                github: {
                  connected: true,
                  email: "person@example.com"
                }
              }
            }
          })
        }),
        config,
        async () => {
          await toolGate;
          return {
            classification: "user_private",
            content: { login: "octocat" }
          };
        }
      );

      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      const first = await reader!.read();
      expect(new TextDecoder().decode(first.value)).toContain(
        "Loading Burble context"
      );

      await reader!.cancel();
      resolveTool();
      await Bun.sleep(5);

      expect(errors).toEqual([]);
    } finally {
      console.error = originalError;
    }
  });

  test("delivers local conversation messages through the Burble tool gateway", async () => {
    const requests: Request[] = [];
    const response = await withMockFetch(
      (async (input, init) => {
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
      }) as typeof fetch,
      () =>
        handleRuntimeRequest(
          new Request("http://runtime/internal/conversation/messages", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              routeId: "convrt_abc123",
              text: "hello"
            })
          }),
          {
            ...config,
            runtimeId: "rt_u123"
          }
        )
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
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(
      "http://burble-app:3000/internal/tools/conversation.sendMessage/execute"
    );
    expect(requests[0].headers.get("authorization")).toBe("Bearer secret");
    expect(requests[0].headers.get("x-burble-runtime-id")).toBe("rt_u123");
    expect(await requests[0].json()).toEqual({
      input: {
        routeId: "convrt_abc123",
        text: "hello"
      }
    });
  });

  test("delivers attachment-only local conversation messages", async () => {
    const requests: Request[] = [];
    const response = await withMockFetch(
      (async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return Response.json({
          classification: "user_private",
          content: { ok: true }
        });
      }) as typeof fetch,
      () =>
        handleRuntimeRequest(
          new Request("http://runtime/internal/burble/channel/routes/convrt_abc123/messages", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              text: "",
              attachments: [
                {
                  id: "agent:image-1",
                  source: "agent",
                  kind: "image",
                  mimeType: "image/png",
                  name: "preview.png"
                }
              ]
            })
          }),
          {
            ...config,
            runtimeId: "rt_u123"
          }
        )
    );

    expect(response.status).toBe(200);
    expect(await requests[0].json()).toEqual({
      input: {
        routeId: "convrt_abc123",
        text: "",
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
    });
  });

  test("proxies Burble MCP calls with the runtime JWT", async () => {
    const requests: Request[] = [];
    const response = await withMockFetch(
      (async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return new Response(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { content: [] }
          })}\n\n`,
          {
            headers: {
              "content-type": "text/event-stream",
              "mcp-session-id": "session-123"
            }
          }
        );
      }) as typeof fetch,
      () =>
        handleRuntimeRequest(
          new Request("http://runtime/internal/burble/mcp", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              "mcp-protocol-version": "2025-06-18",
              "mcp-session-id": "session-123"
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: {
                name: "github_search_issues",
                arguments: {
                  routeId: "convrt_abc123",
                  query: "repo:apelogic/burble is:pr"
                }
              }
            })
          }),
          {
            ...config,
            mcpGatewayUrl: "http://burble-app:3000/mcp",
            runtimeJwt: "runtime-jwt"
          }
        )
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBe("session-123");
    expect(await response.text()).toContain('"result":{"content":[]}');
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("http://burble-app:3000/mcp");
    expect(requests[0].headers.get("authorization")).toBe("Bearer runtime-jwt");
    expect(requests[0].headers.get("mcp-protocol-version")).toBe("2025-06-18");
    expect(requests[0].headers.get("mcp-session-id")).toBe("session-123");
    expect(await requests[0].json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "github_search_issues",
        arguments: {
          routeId: "convrt_abc123",
          query: "repo:apelogic/burble is:pr"
        }
      }
    });
  });

  test("requires route ids for local Burble MCP tool calls", async () => {
    const requests: Request[] = [];
    const response = await withMockFetch(
      (async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({});
      }) as typeof fetch,
      () =>
        handleRuntimeRequest(
          new Request("http://runtime/internal/burble/mcp", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: {
                name: "github_search_issues",
                arguments: { query: "is:pr" }
              }
            })
          }),
          {
            ...config,
            mcpGatewayUrl: "http://burble-app:3000/mcp",
            runtimeJwt: "runtime-jwt"
          }
        )
    );

    expect(response.status).toBe(200);
    const body = readMcpData(await response.text());
    expect(body.error.message).toBe(
      "Burble provider tools require a routeId argument."
    );
    expect(requests).toEqual([]);
  });

  test("adds required route ids to local Burble MCP tool schemas", async () => {
    const upstreamPayload = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [
          {
            name: "github_search_issues",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string" }
              },
              required: ["query"]
            }
          }
        ]
      }
    };

    const response = await withMockFetch(
      (async (_input, _init) =>
        new Response(`event: message\ndata: ${JSON.stringify(upstreamPayload)}\n\n`, {
          headers: { "content-type": "text/event-stream" }
        })) as typeof fetch,
      () =>
        handleRuntimeRequest(
          new Request("http://runtime/internal/burble/mcp", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/list"
            })
          }),
          {
            ...config,
            mcpGatewayUrl: "http://burble-app:3000/mcp",
            runtimeJwt: "runtime-jwt"
          }
        )
    );

    const body = readMcpData(await response.text());
    const schema = body.result.tools[0].inputSchema;
    expect(schema.properties.routeId).toMatchObject({
      type: "string",
      minLength: 1
    });
    expect(schema.required).toEqual(["query", "routeId"]);
  });

  test("delivers Burble channel events through the Burble tool gateway", async () => {
    const requests: Request[] = [];
    const response = await withMockFetch(
      (async (input, init) => {
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
      }) as typeof fetch,
      () =>
        handleRuntimeRequest(
          new Request(
            "http://runtime/internal/burble/channel/routes/convrt_abc123/events",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                jobId: "job-123",
                runId: "run-123",
                result: {
                  summary: "Open GitHub PRs: none found."
                }
              })
            }
          ),
          {
            ...config,
            runtimeId: "rt_u123"
          }
        )
    );

    expect(response.status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(
      "http://burble-app:3000/internal/tools/conversation.sendMessage/execute"
    );
    expect(await requests[0].json()).toEqual({
      input: {
        routeId: "convrt_abc123",
        text: "Open GitHub PRs: none found."
      }
    });
  });

  test("rejects invisible-only Burble channel messages without posting", async () => {
    const requests: Request[] = [];
    const response = await withMockFetch(
      (async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({});
      }) as typeof fetch,
      () =>
        handleRuntimeRequest(
          new Request(
            "http://runtime/internal/burble/channel/routes/convrt_abc123/messages",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ text: "\u200B" })
            }
          ),
          {
            ...config,
            runtimeId: "rt_u123"
          }
        )
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Invalid Burble channel message input");
    expect(requests).toEqual([]);
  });

  test("accepts Burble channel events without deliverable text without posting", async () => {
    const requests: Request[] = [];
    const response = await withMockFetch(
      (async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({});
      }) as typeof fetch,
      () =>
        handleRuntimeRequest(
          new Request(
            "http://runtime/internal/burble/channel/routes/convrt_abc123/events",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ jobId: "job-123", status: "ok" })
            }
          ),
          {
            ...config,
            runtimeId: "rt_u123"
          }
        )
    );

    expect(response.status).toBe(202);
    expect(await response.text()).toBe(
      "Burble channel event did not contain deliverable text"
    );
    expect(requests).toEqual([]);
  });

  test("delivers Burble channel events with attachments but no text", async () => {
    const requests: Request[] = [];
    const response = await withMockFetch(
      (async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return Response.json({
          classification: "user_private",
          content: { ok: true }
        });
      }) as typeof fetch,
      () =>
        handleRuntimeRequest(
          new Request(
            "http://runtime/internal/burble/channel/routes/convrt_abc123/events",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                result: {
                  attachments: [
                    {
                      id: "agent:report-1",
                      source: "agent",
                      kind: "file",
                      mimeType: "text/plain",
                      name: "report.txt"
                    }
                  ]
                }
              })
            }
          ),
          {
            ...config,
            runtimeId: "rt_u123"
          }
        )
    );

    expect(response.status).toBe(200);
    expect(await requests[0].json()).toEqual({
      input: {
        routeId: "convrt_abc123",
        text: "",
        attachments: [
          {
            id: "agent:report-1",
            source: "agent",
            kind: "file",
            mimeType: "text/plain",
            name: "report.txt"
          }
        ]
      }
    });
  });

  test("ignores invisible-only Burble channel events without posting", async () => {
    const requests: Request[] = [];
    const response = await withMockFetch(
      (async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({});
      }) as typeof fetch,
      () =>
        handleRuntimeRequest(
          new Request(
            "http://runtime/internal/burble/channel/routes/convrt_abc123/events",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                result: {
                  summary: "\u200B"
                }
              })
            }
          ),
          {
            ...config,
            runtimeId: "rt_u123"
          }
        )
    );

    expect(response.status).toBe(202);
    expect(await response.text()).toBe(
      "Burble channel event did not contain deliverable text"
    );
    expect(requests).toEqual([]);
  });

  test("keeps the previous conversation webhook endpoint as a compatibility alias", async () => {
    const requests: Request[] = [];
    const response = await withMockFetch(
      (async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return Response.json({
          classification: "user_private",
          content: { ok: true }
        });
      }) as typeof fetch,
      () =>
        handleRuntimeRequest(
          new Request(
            "http://runtime/internal/conversation/routes/convrt_abc123/webhook",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ text: "hello through old path" })
            }
          ),
          {
            ...config,
            runtimeId: "rt_u123"
          }
        )
    );

    expect(response.status).toBe(200);
    expect(await requests[0].json()).toEqual({
      input: {
        routeId: "convrt_abc123",
        text: "hello through old path"
      }
    });
  });

  test("rejects malformed run requests", async () => {
    const response = await handleRuntimeRequest(
      new Request("http://runtime/runs", {
        method: "POST",
        body: JSON.stringify({ input: { text: "" } })
      }),
      config
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Invalid run request");
  });

  test("rejects malformed runtime metadata", async () => {
    const response = await handleRuntimeRequest(
      new Request("http://runtime/runs", {
        method: "POST",
        body: JSON.stringify({
          runtime: { id: "" },
          input: {
            text: "who am I on GitHub?",
            connections: {
              github: { connected: true }
            }
          }
        })
      }),
      config
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Invalid run request");
  });
});

function readMcpData(text: string): any {
  const dataLine = text
    .split("\n")
    .find((line) => line.startsWith("data: "));
  if (!dataLine) {
    throw new Error(`Missing MCP data line in response: ${text}`);
  }
  return JSON.parse(dataLine.slice("data: ".length));
}
