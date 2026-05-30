import { describe, expect, test } from "bun:test";
import {
  sendRuntimeHeartbeat,
  startRuntimeHeartbeat
} from "../../../runtimes/openclaw-nemoclaw/src/heartbeat";
import type { RuntimeConfig } from "../../../runtimes/openclaw-nemoclaw/src/config";

const config: RuntimeConfig = {
  port: 8080,
  runtimeId: "rt_u123",
  runtimeHeartbeatIntervalMs: 300000,
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

describe("runtime heartbeat", () => {
  test("sends a runtime-authenticated heartbeat to the tool gateway", async () => {
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
      await sendRuntimeHeartbeat(config);

      expect(requests).toHaveLength(1);
      expect(requests[0].url).toBe(
        "http://burble-app:3000/internal/tools/runtime.heartbeat/execute"
      );
      expect(requests[0].headers.get("authorization")).toBe(
        "Bearer runtime-secret"
      );
      expect(requests[0].headers.get("x-burble-runtime-id")).toBe("rt_u123");
      expect(await requests[0].json()).toEqual({});
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("does not start a heartbeat when the runtime id is unavailable", () => {
    const heartbeat = startRuntimeHeartbeat({
      ...config,
      runtimeId: null
    });

    expect(heartbeat).toBeNull();
  });
});
