import { describe, expect, test } from "bun:test";
import { buildOpenClawProcessEnv } from "../../../runtimes/openclaw-nemoclaw/src/process-env";

describe("buildOpenClawProcessEnv", () => {
  test("keeps Burble MCP credentials outside the OpenClaw process", () => {
    const env = buildOpenClawProcessEnv(
      {
        BURBLE_RUNTIME_JWT: "override-runtime-jwt",
        OPENCLAW_CONFIG_PATH: "/data/openclaw/config/openclaw.json",
        OPENCLAW_GATEWAY_TOKEN: "local-gateway-token",
        XDG_CACHE_HOME: "/tmp/openclaw-cache",
        npm_config_cache: "/tmp/npm-cache",
        npm_config_audit: "false",
        npm_config_fund: "false",
        npm_config_update_notifier: "false",
        npm_config_offline: "true",
        JITI_FS_CACHE: "false"
      },
      {
        PATH: "/usr/local/bin:/usr/bin",
        HOME: "/data/openclaw",
        NODE_OPTIONS: "--max-old-space-size=2048",
        OPENAI_API_KEY: "sk-BURBLE-INFERENCE-PROXY",
        ANTHROPIC_API_KEY: "anthropic-key",
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
      NODE_OPTIONS: "--max-old-space-size=2048 --require /tmp/ciao-network-guard.cjs",
      OPENAI_API_KEY: "sk-BURBLE-INFERENCE-PROXY",
      OPENCLAW_CONFIG_PATH: "/data/openclaw/config/openclaw.json",
      XDG_CACHE_HOME: "/tmp/openclaw-cache",
      npm_config_cache: "/tmp/npm-cache",
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
      npm_config_offline: "true",
      JITI_FS_CACHE: "false"
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
  });
});
