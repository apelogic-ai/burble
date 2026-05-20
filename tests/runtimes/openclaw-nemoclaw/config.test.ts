import { describe, expect, test } from "bun:test";
import { readRuntimeConfig } from "../../../runtimes/openclaw-nemoclaw/src/config";

describe("readRuntimeConfig", () => {
  test("reads runtime settings", () => {
    expect(
      readRuntimeConfig({
        PORT: "9090",
        BURBLE_TOOL_GATEWAY_URL: "http://burble-app:3000/internal/tools/",
        BURBLE_INTERNAL_TOKEN: "secret"
      })
    ).toEqual({
      port: 9090,
      toolGatewayUrl: "http://burble-app:3000/internal/tools",
      internalToken: "secret"
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
