import { describe, expect, test } from "bun:test";
import {
  attachRuntimeEventWebSocket,
  handleRuntimeRequest as handleRuntimeRequestRaw
} from "../../../runtimes/openclaw-nemoclaw/src/server";
import type { RuntimeConfig } from "../../../runtimes/openclaw-nemoclaw/src/config";
import { createRuntimeContractHttpClient } from "@burble/runtime-sdk/runtime-contract-http-client";
import { runRuntimeContractSmokeTest } from "@burble/runtime-sdk/runtime-contract-harness";

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
  openClawFastMode: false,
  openClawRawStreamDebug: false,
  openClawGatewayPort: 18789,
  openClawGatewayBind: "loopback",
  openClawGatewayToken: "gateway-token",
  llmModel: "openai:gpt-5.4",
  ollamaBaseUrl: "https://ollama.com"
};

describe("OpenClaw/NemoClaw runtime contract", () => {
  test("passes the shared smoke harness in deterministic mode", async () => {
    const client = createRuntimeContractHttpClient({
      baseUrl: "http://runtime.local",
      fetch: async (url, init) =>
        handleRuntimeRequestRaw(
          withRuntimeAuthorization(new Request(url, init), config.internalToken),
          config,
          async () => ({
            classification: "user_private",
            content: { login: "octocat" }
          })
        ),
      webSocketFactory: () => new RuntimeHarnessWebSocket()
    });

    await expect(
      runRuntimeContractSmokeTest({
        client,
        request: {
          runId: "run-openclaw-contract",
          principal: {
            workspaceId: "T123",
            slackUserId: "U123"
          },
          runtime: {
            id: "rt_openclaw_contract",
            engine: "deterministic"
          },
          input: {
            text: "who am I on GitHub?",
            connections: {
              github: {
                connected: true,
                email: "person@example.com"
              }
            }
          }
        }
      })
    ).resolves.toMatchObject({
      runtimeType: "deterministic",
      runId: "run-openclaw-contract",
      checks: [
        { name: "manifest", status: "ok" },
        { name: "health", status: "ok" },
        { name: "run_accepted", status: "ok" },
        { name: "events_stream", status: "ok" },
        { name: "final_response", status: "ok" },
        { name: "usage", status: "ok" }
      ]
    });
  });

  test("accepts the shared contract probe request without provider connections", async () => {
    const response = await handleRuntimeRequestRaw(
      withRuntimeAuthorization(
        new Request("http://runtime.local/runs", {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            runId: "run-openclaw-empty-connections",
            principal: {
              workspaceId: "T123",
              slackUserId: "U123"
            },
            runtime: {
              id: "rt_openclaw_empty_connections",
              engine: "deterministic"
            },
            input: {
              text: "runtime contract probe",
              conversation: {
                routeId: "convrt_openclaw_empty_connections",
                source: "slack",
                workspaceId: "T123",
                channelId: "D123",
                rootId: "dm:D123",
                isDirectMessage: true
              },
              connections: {}
            }
          })
        }),
        config.internalToken
      ),
      { ...config, contractProbeMode: true }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      response: {
        classification: "user_private",
        text: "Runtime contract probe response."
      }
    });
  });
});

function withRuntimeAuthorization(request: Request, token: string): Request {
  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${token}`);
  return new Request(request, { headers });
}

class RuntimeHarnessWebSocket {
  private readonly listeners = new Map<
    "message" | "error" | "close",
    Array<(event: { data?: unknown }) => void>
  >();

  constructor() {
    queueMicrotask(() => {
      // TODO(runtime-contract): replace this internal hook with a black-box
      // WebSocket exercise once the shared smoke harness can host a fake
      // runtime event endpoint.
      attachRuntimeEventWebSocket("run-openclaw-contract", {
        send: (message) => this.emit("message", { data: message }),
        close: () => this.emit("close", {})
      });
    });
  }

  addEventListener(
    type: "message" | "error" | "close",
    listener: (event: { data?: unknown }) => void
  ) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  close() {
    this.emit("close", {});
  }

  private emit(type: "message" | "error" | "close", event: { data?: unknown }) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}
