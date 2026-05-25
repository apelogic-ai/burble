import { describe, expect, test } from "bun:test";
import { readRuntimeConfig } from "../../../runtimes/openclaw-nemoclaw/src/config";

describe("readRuntimeConfig", () => {
  test("reads runtime settings", () => {
    expect(
      readRuntimeConfig({
        PORT: "9090",
        BURBLE_TOOL_GATEWAY_URL: "http://burble-app:3000/internal/tools/",
        BURBLE_INTERNAL_TOKEN: "secret",
        BURBLE_MCP_GATEWAY_URL: "http://agentgateway:3000/mcp/",
        BURBLE_RUNTIME_JWT: "runtime-jwt",
        OPENCLAW_NEMOCLAW_ENGINE: "openclaw",
        OPENCLAW_COMMAND: "/usr/local/bin/openclaw",
        OPENCLAW_AGENT: "burble",
        OPENCLAW_TIMEOUT_MS: "120000",
        OPENCLAW_STATE_DIR: "/data/openclaw/state",
        OPENCLAW_CONFIG_PATH: "/data/openclaw/config/openclaw.json",
        OPENCLAW_WORKSPACE_DIR: "/data/openclaw/workspace",
        OPENCLAW_SETUP_ON_START: "false",
        OPENCLAW_CONFIG_PATCH_PATH: "/etc/openclaw/patch.json5",
        OPENCLAW_VALIDATE_ON_START: "false",
        OPENCLAW_STREAM_DEBUG: "true",
        OPENCLAW_LOG_LEVEL: "debug",
        OPENCLAW_DIAGNOSTICS: "model.*",
        OPENCLAW_DEBUG_MODEL_TRANSPORT: "true",
        OPENCLAW_DEBUG_MODEL_PAYLOAD: "summary",
        OPENCLAW_DEBUG_SSE: "events",
        OPENCLAW_DEBUG_CODE_MODE: "true"
      })
    ).toEqual({
      port: 9090,
      toolGatewayUrl: "http://burble-app:3000/internal/tools",
      internalToken: "secret",
      mcpGatewayUrl: "http://agentgateway:3000/mcp",
      runtimeJwt: "runtime-jwt",
      engine: "openclaw",
      openClawCommand: "/usr/local/bin/openclaw",
      openClawAgent: "burble",
      openClawTimeoutMs: 120000,
      openClawStateDir: "/data/openclaw/state",
      openClawConfigPath: "/data/openclaw/config/openclaw.json",
      openClawWorkspaceDir: "/data/openclaw/workspace",
      openClawSetupOnStart: false,
      openClawConfigPatchPath: "/etc/openclaw/patch.json5",
      openClawValidateOnStart: false,
      openClawStreamDebug: true,
      openClawLogLevel: "debug",
      openClawDiagnostics: "model.*",
      openClawDebugModelTransport: "true",
      openClawDebugModelPayload: "summary",
      openClawDebugSse: "events",
      openClawDebugCodeMode: "true"
    });
  });

  test("defaults to the deterministic runtime engine", () => {
    expect(
      readRuntimeConfig({
        BURBLE_TOOL_GATEWAY_URL: "http://burble-app:3000/internal/tools",
        BURBLE_INTERNAL_TOKEN: "secret"
      })
    ).toMatchObject({
      engine: "deterministic",
      mcpGatewayUrl: null,
      runtimeJwt: null,
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
    });
  });

  test("rejects invalid runtime engines", () => {
    expect(() =>
      readRuntimeConfig({
        BURBLE_TOOL_GATEWAY_URL: "http://burble-app:3000/internal/tools",
        BURBLE_INTERNAL_TOKEN: "secret",
        OPENCLAW_NEMOCLAW_ENGINE: "magic"
      })
    ).toThrow(
      "Environment variable OPENCLAW_NEMOCLAW_ENGINE must be one of deterministic, openclaw, openclaw-gateway"
    );
  });

  test("accepts the old openclaw-cli engine value as an alias", () => {
    expect(
      readRuntimeConfig({
        BURBLE_TOOL_GATEWAY_URL: "http://burble-app:3000/internal/tools",
        BURBLE_INTERNAL_TOKEN: "secret",
        OPENCLAW_NEMOCLAW_ENGINE: "openclaw-cli"
      }).engine
    ).toBe("openclaw");
  });

  test("accepts the OpenClaw Gateway runtime engine", () => {
    expect(
      readRuntimeConfig({
        BURBLE_TOOL_GATEWAY_URL: "http://burble-app:3000/internal/tools",
        BURBLE_INTERNAL_TOKEN: "secret",
        OPENCLAW_NEMOCLAW_ENGINE: "openclaw-gateway"
      }).engine
    ).toBe("openclaw-gateway");
  });

  test("treats empty or quoted boolean settings as deploy-friendly values", () => {
    expect(
      readRuntimeConfig({
        BURBLE_TOOL_GATEWAY_URL: "http://burble-app:3000/internal/tools",
        BURBLE_INTERNAL_TOKEN: "secret",
        OPENCLAW_VALIDATE_ON_START: "",
        OPENCLAW_SETUP_ON_START: '"false"',
        OPENCLAW_CONFIG_PATCH_PATH: '"/etc/openclaw/patch.json5"'
      })
    ).toMatchObject({
      openClawValidateOnStart: true,
      openClawSetupOnStart: false,
      openClawConfigPatchPath: "/etc/openclaw/patch.json5",
      openClawStreamDebug: false
    });
  });

  test("requires gateway URL and internal token", () => {
    expect(() => readRuntimeConfig({ BURBLE_INTERNAL_TOKEN: "secret" })).toThrow(
      "Missing required environment variable: BURBLE_TOOL_GATEWAY_URL"
    );
    expect(() =>
      readRuntimeConfig({ BURBLE_TOOL_GATEWAY_URL: "http://burble-app" })
    ).toThrow("Missing required environment variable: BURBLE_INTERNAL_TOKEN");
  });
});
