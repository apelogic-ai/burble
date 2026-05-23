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
  openClawStreamDebug: false
};

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
