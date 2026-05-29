import { describe, expect, test } from "bun:test";
import { readConfig } from "../src/config";

const validEnv = {
  SLACK_BOT_TOKEN: "xoxb-test",
  SLACK_APP_TOKEN: "xapp-test",
  GITHUB_CLIENT_ID: "client-id",
  GITHUB_CLIENT_SECRET: "client-secret",
  BASE_URL: "https://example.ngrok-free.app/",
  PORT: "4242",
  DATABASE_PATH: "test.db"
};

describe("readConfig", () => {
  test("normalizes base URL and parses optional settings", () => {
    expect(readConfig(validEnv)).toEqual({
      slackBotToken: "xoxb-test",
      slackAppToken: "xapp-test",
      slackClientId: null,
      slackClientSecret: null,
      slackRedirectUri: "https://example.ngrok-free.app/oauth/slack/callback",
      githubClientId: "client-id",
      githubClientSecret: "client-secret",
      jiraClientId: null,
      jiraClientSecret: null,
      googleClientId: null,
      googleClientSecret: null,
      baseUrl: "https://example.ngrok-free.app",
      port: 4242,
      databasePath: "test.db",
      slackLogLevel: "info",
      agentMode: "deterministic",
      agentRuntime: "ai-sdk",
      agentRuntimeFactory: "static",
      aiModel: "openai:gpt-5.4",
      openClawNemoClawUrl: null,
      agentRuntimeEngine: "openclaw",
      openClawNemoClawEngine: "openclaw",
      agentRuntimeDataRoot: "/data/runtimes",
      agentRuntimeDockerNetwork: "compose_default",
      agentRuntimeImage: "burble-openclaw-nemoclaw:dev",
      agentRuntimeIdleTtlMs: 86400000,
      agentRuntimeReaperEnabled: true,
      agentRuntimeReaperIntervalMs: 60000,
      agentRuntimeJwtTtlSeconds: 604800,
      agentRuntimeTokenSecret: null,
      agentRuntimeToolGatewayUrl: "http://burble-app:3000/internal/tools",
      agentRuntimeMcpGatewayUrl: null,
      agentRuntimeMcpAudience: null,
      atlassianMcpUrl: "https://mcp.atlassian.com/v1/mcp",
      runtimeJwtIssuer: "https://example.ngrok-free.app",
      runtimeJwtPrivateKeyPath: null,
      openClawConfigPatchHostPath: null,
      internalApiToken: null
    });
  });

  test("allows Slack log level override", () => {
    expect(readConfig({ ...validEnv, SLACK_LOG_LEVEL: "debug" }).slackLogLevel).toBe(
      "debug"
    );
  });

  test("reads optional Slack OAuth settings", () => {
    const config = readConfig({
      ...validEnv,
      SLACK_CLIENT_ID: "slack-client-id",
      SLACK_CLIENT_SECRET: "slack-client-secret",
      SLACK_REDIRECT_URI: "https://slack-callback.example.com/callback"
    });

    expect(config.slackClientId).toBe("slack-client-id");
    expect(config.slackClientSecret).toBe("slack-client-secret");
    expect(config.slackRedirectUri).toBe(
      "https://slack-callback.example.com/callback"
    );
  });

  test("reads optional Jira OAuth settings", () => {
    const config = readConfig({
      ...validEnv,
      JIRA_CLIENT_ID: "jira-client-id",
      JIRA_CLIENT_SECRET: "jira-client-secret"
    });

    expect(config.jiraClientId).toBe("jira-client-id");
    expect(config.jiraClientSecret).toBe("jira-client-secret");
  });

  test("reads optional Google OAuth settings", () => {
    const config = readConfig({
      ...validEnv,
      GOOGLE_CLIENT_ID: "google-client-id",
      GOOGLE_CLIENT_SECRET: "google-client-secret"
    });

    expect(config.googleClientId).toBe("google-client-id");
    expect(config.googleClientSecret).toBe("google-client-secret");
  });

  test("rejects invalid Slack log levels", () => {
    expect(() => readConfig({ ...validEnv, SLACK_LOG_LEVEL: "loud" })).toThrow(
      "Environment variable SLACK_LOG_LEVEL must be one of debug, info, warn, error"
    );
  });

  test("allows LLM agent mode and model override", () => {
    const config = readConfig({
      ...validEnv,
      AGENT_MODE: "llm",
      AGENT_RUNTIME: "burble-runtime",
      AI_MODEL: "anthropic:claude-opus-4.6"
    });

    expect(config.agentMode).toBe("llm");
    expect(config.agentRuntime).toBe("burble-runtime");
    expect(config.aiModel).toBe("anthropic:claude-opus-4.6");
  });

  test("accepts the legacy OpenClaw runtime adapter name", () => {
    const config = readConfig({
      ...validEnv,
      AGENT_MODE: "llm",
      AGENT_RUNTIME: "openclaw-nemoclaw"
    });

    expect(config.agentRuntime).toBe("burble-runtime");
  });

  test("allows Ollama model tags in normalized model ids", () => {
    const config = readConfig({
      ...validEnv,
      AI_MODEL: "ollama:qwen3-coder:30b-cloud"
    });

    expect(config.aiModel).toBe("ollama:qwen3-coder:30b-cloud");
  });

  test("allows docker runtime factory override", () => {
    const config = readConfig({
      ...validEnv,
      AGENT_RUNTIME_FACTORY: "docker",
      AGENT_RUNTIME_IMAGE: "burble-openclaw-nemoclaw-openclaw-cli:dev",
      AGENT_RUNTIME_DOCKER_NETWORK: "burble_default",
      AGENT_RUNTIME_IDLE_TTL_MS: "120000",
      AGENT_RUNTIME_REAPER_ENABLED: "false",
      AGENT_RUNTIME_REAPER_INTERVAL_MS: "5000",
      AGENT_RUNTIME_JWT_TTL_SECONDS: "86400",
      AGENT_RUNTIME_TOKEN_SECRET: "runtime-secret",
      AGENT_RUNTIME_TOOL_GATEWAY_URL: "http://burble-app:3000/internal/tools",
      AGENT_RUNTIME_MCP_GATEWAY_URL: "http://agentgateway:3000/mcp/",
      AGENT_RUNTIME_MCP_AUDIENCE: "http://agentgateway:3000/mcp/",
      AGENT_RUNTIME_CONFIG_PATCH_HOST_PATH: "/srv/burble/runtime-patches",
      RUNTIME_JWT_ISSUER: "http://burble-app:3000/",
      RUNTIME_JWT_PRIVATE_KEY_PATH: "/data/runtime-jwt-private.pem",
      OPENCLAW_CONFIG_PATCH_HOST_PATH: "/srv/burble/openclaw-patches"
    });

    expect(config.agentRuntimeFactory).toBe("docker");
    expect(config.agentRuntimeEngine).toBe("openclaw");
    expect(config.openClawNemoClawEngine).toBe("openclaw");
    expect(config.agentRuntimeImage).toBe(
      "burble-openclaw-nemoclaw-openclaw-cli:dev"
    );
    expect(config.agentRuntimeDockerNetwork).toBe("burble_default");
    expect(config.agentRuntimeIdleTtlMs).toBe(120000);
    expect(config.agentRuntimeReaperEnabled).toBe(false);
    expect(config.agentRuntimeReaperIntervalMs).toBe(5000);
    expect(config.agentRuntimeJwtTtlSeconds).toBe(86400);
    expect(config.agentRuntimeTokenSecret).toBe("runtime-secret");
    expect(config.agentRuntimeMcpGatewayUrl).toBe("http://agentgateway:3000/mcp");
    expect(config.agentRuntimeMcpAudience).toBe("http://agentgateway:3000/mcp");
    expect(config.runtimeJwtIssuer).toBe("http://burble-app:3000");
    expect(config.runtimeJwtPrivateKeyPath).toBe("/data/runtime-jwt-private.pem");
    expect(config.openClawConfigPatchHostPath).toBe("/srv/burble/runtime-patches");
  });

  test("defaults to the Hermes runtime image for Hermes engine", () => {
    const config = readConfig({
      ...validEnv,
      AGENT_RUNTIME: "burble-runtime",
      AGENT_RUNTIME_FACTORY: "docker",
      AGENT_RUNTIME_ENGINE: "hermes"
    });

    expect(config.agentRuntimeImage).toBe("burble-nemo-hermes:dev");
  });

  test("falls back to the legacy OpenClaw config patch host path", () => {
    const config = readConfig({
      ...validEnv,
      OPENCLAW_CONFIG_PATCH_HOST_PATH: "/srv/burble/openclaw-patches"
    });

    expect(config.openClawConfigPatchHostPath).toBe(
      "/srv/burble/openclaw-patches"
    );
  });

  test("defaults Docker runtimes to Burble MCP", () => {
    const config = readConfig({
      ...validEnv,
      AGENT_RUNTIME_FACTORY: "docker"
    });

    expect(config.agentRuntimeMcpGatewayUrl).toBe("http://burble-app:3000/mcp");
    expect(config.agentRuntimeMcpAudience).toBe("http://burble-app:3000/mcp");
  });

  test("allows Atlassian MCP URL override", () => {
    expect(
      readConfig({
        ...validEnv,
        ATLASSIAN_MCP_URL: "https://mcp.atlassian.com/v1/mcp/authv2/"
      }).atlassianMcpUrl
    ).toBe("https://mcp.atlassian.com/v1/mcp/authv2");
  });

  test("allows OpenClaw gateway runtime engine override", () => {
    const config = readConfig({
      ...validEnv,
      OPENCLAW_NEMOCLAW_ENGINE: "openclaw-gateway"
    });

    expect(config.agentRuntimeEngine).toBe("openclaw-gateway");
    expect(config.openClawNemoClawEngine).toBe("openclaw-gateway");
  });

  test("allows generic agent runtime engine override", () => {
    const config = readConfig({
      ...validEnv,
      AGENT_RUNTIME_ENGINE: "nemo-hermes"
    });

    expect(config.agentRuntimeEngine).toBe("hermes");
    expect(config.openClawNemoClawEngine).toBe("hermes");
  });

  test("prefers generic agent runtime engine over legacy OpenClaw engine", () => {
    const config = readConfig({
      ...validEnv,
      AGENT_RUNTIME_ENGINE: "hermes",
      OPENCLAW_NEMOCLAW_ENGINE: "openclaw"
    });

    expect(config.agentRuntimeEngine).toBe("hermes");
    expect(config.openClawNemoClawEngine).toBe("hermes");
  });

  test("falls back to the legacy OpenClaw engine when generic engine is blank", () => {
    const config = readConfig({
      ...validEnv,
      AGENT_RUNTIME_ENGINE: "",
      OPENCLAW_NEMOCLAW_ENGINE: "openclaw-gateway"
    });

    expect(config.agentRuntimeEngine).toBe("openclaw-gateway");
    expect(config.openClawNemoClawEngine).toBe("openclaw-gateway");
  });

  test("allows Burble direct provider runtime engine override", () => {
    const config = readConfig({
      ...validEnv,
      OPENCLAW_NEMOCLAW_ENGINE: "burble-direct"
    });

    expect(config.openClawNemoClawEngine).toBe("burble-direct");
  });

  test("rejects invalid OpenClaw runtime engines", () => {
    expect(() =>
      readConfig({ ...validEnv, OPENCLAW_NEMOCLAW_ENGINE: "magic" })
    ).toThrow(
      "Environment variable OPENCLAW_NEMOCLAW_ENGINE must be one of deterministic, openclaw, openclaw-gateway, burble-direct, hermes"
    );
  });

  test("rejects invalid generic agent runtime engines", () => {
    expect(() =>
      readConfig({ ...validEnv, AGENT_RUNTIME_ENGINE: "magic" })
    ).toThrow(
      "Environment variable AGENT_RUNTIME_ENGINE must be one of deterministic, openclaw, openclaw-gateway, burble-direct, hermes"
    );
  });

  test("falls back to the internal API token as the runtime token secret", () => {
    const config = readConfig({
      ...validEnv,
      INTERNAL_API_TOKEN: "internal-secret"
    });

    expect(config.agentRuntimeTokenSecret).toBe("internal-secret");
  });

  test("rejects invalid agent modes", () => {
    expect(() => readConfig({ ...validEnv, AGENT_MODE: "robot" })).toThrow(
      "Environment variable AGENT_MODE must be one of deterministic, llm"
    );
  });

  test("rejects invalid agent runtimes", () => {
    expect(() => readConfig({ ...validEnv, AGENT_RUNTIME: "robot" })).toThrow(
      "Environment variable AGENT_RUNTIME must be one of ai-sdk, burble-runtime"
    );
  });

  test("rejects invalid runtime factories", () => {
    expect(() =>
      readConfig({ ...validEnv, AGENT_RUNTIME_FACTORY: "kubernetes" })
    ).toThrow("Environment variable AGENT_RUNTIME_FACTORY must be one of static, docker");
  });

  test("rejects invalid runtime reaper enabled values", () => {
    expect(() =>
      readConfig({ ...validEnv, AGENT_RUNTIME_REAPER_ENABLED: "sometimes" })
    ).toThrow(
      "Environment variable AGENT_RUNTIME_REAPER_ENABLED must be a boolean"
    );
  });

  test("normalizes OpenClaw/NemoClaw runtime URL", () => {
    const config = readConfig({
      ...validEnv,
      AGENT_RUNTIME: "burble-runtime",
      OPENCLAW_NEMOCLAW_URL: "http://openclaw-runtime:8080/"
    });

    expect(config.openClawNemoClawUrl).toBe("http://openclaw-runtime:8080");
  });

  test("reads optional agent runtime data root", () => {
    expect(
      readConfig({ ...validEnv, AGENT_RUNTIME_DATA_ROOT: "/var/lib/burble" })
        .agentRuntimeDataRoot
    ).toBe("/var/lib/burble");
  });

  test("reads optional internal API token", () => {
    expect(
      readConfig({ ...validEnv, INTERNAL_API_TOKEN: "internal-secret" })
        .internalApiToken
    ).toBe("internal-secret");
  });

  test("rejects gateway-style model ids", () => {
    expect(() => readConfig({ ...validEnv, AI_MODEL: "openai/gpt-5.4" })).toThrow(
      "AI_MODEL must use provider:model format"
    );
  });

  test("rejects missing required settings", () => {
    const env = { ...validEnv, SLACK_BOT_TOKEN: "" };

    expect(() => readConfig(env)).toThrow(
      "Missing required environment variable: SLACK_BOT_TOKEN"
    );
  });

  test("rejects invalid port values", () => {
    const env = { ...validEnv, PORT: "nope" };

    expect(() => readConfig(env)).toThrow(
      "Environment variable PORT must be a positive integer"
    );
  });
});
