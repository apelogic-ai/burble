import { describe, expect, test } from "bun:test";
import { handleRuntimeRequest } from "../../../runtimes/openclaw-nemoclaw/src/server";
import type { RuntimeConfig } from "../../../runtimes/openclaw-nemoclaw/src/config";

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

  test("streams run events as ndjson when requested", async () => {
    const response = await handleRuntimeRequest(
      new Request("http://runtime/runs", {
        method: "POST",
        headers: {
          accept: "application/x-ndjson",
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
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(events).toEqual([
      { type: "status", text: "Loading Burble context..." },
      {
        type: "final",
        response: {
          classification: "user_private",
          text: "Authenticated to GitHub as `octocat`."
        }
      }
    ]);
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
