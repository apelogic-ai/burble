import { describe, expect, test } from "bun:test";
import { buildOpenClawProcessEnv } from "../../../runtimes/openclaw-nemoclaw/src/process-env";

describe("buildOpenClawProcessEnv", () => {
  test("keeps Burble MCP credentials outside the OpenClaw process", () => {
    const env = buildOpenClawProcessEnv(
      {
        BURBLE_RUNTIME_JWT: "override-runtime-jwt",
        OPENCLAW_CONFIG_PATH: "/data/openclaw/config/openclaw.json",
        OPENCLAW_GATEWAY_TOKEN: "local-gateway-token"
      },
      {
        PATH: "/usr/local/bin:/usr/bin",
        HOME: "/data/openclaw",
        OPENAI_API_KEY: "model-api-key",
        BURBLE_RUNTIME_JWT: "runtime-jwt",
        BURBLE_MCP_GATEWAY_URL: "http://agentgateway:3000/mcp",
        BURBLE_INTERNAL_TOKEN: "internal-token",
        AGENT_RUNTIME_MCP_GATEWAY_URL: "http://agentgateway:3000/mcp",
        GITHUB_TOKEN: "github-token",
        GOOGLE_CLIENT_SECRET: "google-secret",
        SLACK_BOT_TOKEN: "slack-token",
        SOME_REFRESH_TOKEN: "refresh-token"
      }
    );

    expect(env).toEqual({
      PATH: "/usr/local/bin:/usr/bin",
      HOME: "/data/openclaw",
      OPENAI_API_KEY: "model-api-key",
      OPENCLAW_CONFIG_PATH: "/data/openclaw/config/openclaw.json",
      OPENCLAW_GATEWAY_TOKEN: "local-gateway-token"
    });
  });
});
