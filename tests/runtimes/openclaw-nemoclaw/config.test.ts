import { describe, expect, test } from "bun:test";
import { readRuntimeConfig } from "../../../runtimes/openclaw-nemoclaw/src/config";

describe("readRuntimeConfig", () => {
  test("reads runtime settings", () => {
    expect(
      readRuntimeConfig({
        PORT: "9090",
        BURBLE_TOOL_GATEWAY_URL: "http://burble-app:3000/internal/tools/",
        BURBLE_INTERNAL_TOKEN: "secret",
        OPENCLAW_NEMOCLAW_ENGINE: "openclaw-cli",
        OPENCLAW_COMMAND: "/usr/local/bin/openclaw",
        OPENCLAW_AGENT: "burble",
        OPENCLAW_TIMEOUT_MS: "120000"
      })
    ).toEqual({
      port: 9090,
      toolGatewayUrl: "http://burble-app:3000/internal/tools",
      internalToken: "secret",
      engine: "openclaw-cli",
      openClawCommand: "/usr/local/bin/openclaw",
      openClawAgent: "burble",
      openClawTimeoutMs: 120000
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
      openClawCommand: "openclaw",
      openClawAgent: "main",
      openClawTimeoutMs: 60000
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
      "Environment variable OPENCLAW_NEMOCLAW_ENGINE must be one of deterministic, openclaw-cli"
    );
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
