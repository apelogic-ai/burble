import { describe, expect, test } from "bun:test";
import { resolveRuntimeConfigForRequest } from "../../../runtimes/openclaw-nemoclaw/src/runtime";
import type { RuntimeConfig } from "../../../runtimes/openclaw-nemoclaw/src/config";

const config: RuntimeConfig = {
  port: 8080,
  toolGatewayUrl: "http://burble-app:3000/internal/tools",
  internalToken: "secret",
  mcpGatewayUrl: null,
  runtimeJwt: null,
  engine: "burble-direct",
  openClawCommand: "openclaw",
  openClawAgent: "main",
  openClawTimeoutMs: 60000,
  openClawStateDir: "/data/openclaw/state",
  openClawConfigPath: "/data/openclaw/config/openclaw.json",
  openClawWorkspaceDir: "/data/openclaw/workspace",
  openClawSetupOnStart: false,
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

describe("resolveRuntimeConfigForRequest", () => {
  test("keeps the configured fast lane by default", () => {
    expect(resolveRuntimeConfigForRequest(config, {})).toBe(config);
  });

  test("routes native execution through OpenClaw Gateway in the same runtime", () => {
    const resolved = resolveRuntimeConfigForRequest(config, {
      executionMode: "openclaw-native"
    });

    expect(resolved).toMatchObject({
      engine: "openclaw-gateway",
      openClawSetupOnStart: true,
      openClawTimeoutMs: 600000,
      openClawConfigPath: "/data/openclaw/config/openclaw.json",
      openClawWorkspaceDir: "/data/openclaw/workspace"
    });
  });
});
