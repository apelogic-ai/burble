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
      githubClientId: "client-id",
      githubClientSecret: "client-secret",
      baseUrl: "https://example.ngrok-free.app",
      port: 4242,
      databasePath: "test.db",
      slackLogLevel: "info",
      agentMode: "deterministic",
      agentRuntime: "ai-sdk",
      agentRuntimeFactory: "static",
      aiModel: "openai:gpt-5.4",
      openClawNemoClawUrl: null,
      agentRuntimeDataRoot: "/data/runtimes",
      agentRuntimeDockerNetwork: "compose_default",
      agentRuntimeImage: "burble-openclaw-nemoclaw:dev",
      agentRuntimeTokenSecret: null,
      agentRuntimeToolGatewayUrl: "http://burble-app:3000/internal/tools",
      openClawConfigPatchHostPath: null,
      internalApiToken: null
    });
  });

  test("allows Slack log level override", () => {
    expect(readConfig({ ...validEnv, SLACK_LOG_LEVEL: "debug" }).slackLogLevel).toBe(
      "debug"
    );
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
      AGENT_RUNTIME: "openclaw-nemoclaw",
      AI_MODEL: "anthropic:claude-opus-4.6"
    });

    expect(config.agentMode).toBe("llm");
    expect(config.agentRuntime).toBe("openclaw-nemoclaw");
    expect(config.aiModel).toBe("anthropic:claude-opus-4.6");
  });

  test("allows docker runtime factory override", () => {
    const config = readConfig({
      ...validEnv,
      AGENT_RUNTIME_FACTORY: "docker",
      AGENT_RUNTIME_IMAGE: "burble-openclaw-nemoclaw-openclaw-cli:dev",
      AGENT_RUNTIME_DOCKER_NETWORK: "burble_default",
      AGENT_RUNTIME_TOKEN_SECRET: "runtime-secret",
      AGENT_RUNTIME_TOOL_GATEWAY_URL: "http://burble-app:3000/internal/tools",
      OPENCLAW_CONFIG_PATCH_HOST_PATH: "/srv/burble/openclaw-patches"
    });

    expect(config.agentRuntimeFactory).toBe("docker");
    expect(config.agentRuntimeImage).toBe(
      "burble-openclaw-nemoclaw-openclaw-cli:dev"
    );
    expect(config.agentRuntimeDockerNetwork).toBe("burble_default");
    expect(config.agentRuntimeTokenSecret).toBe("runtime-secret");
    expect(config.openClawConfigPatchHostPath).toBe(
      "/srv/burble/openclaw-patches"
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
      "Environment variable AGENT_RUNTIME must be one of ai-sdk, openclaw-nemoclaw"
    );
  });

  test("rejects invalid runtime factories", () => {
    expect(() =>
      readConfig({ ...validEnv, AGENT_RUNTIME_FACTORY: "kubernetes" })
    ).toThrow("Environment variable AGENT_RUNTIME_FACTORY must be one of static, docker");
  });

  test("normalizes OpenClaw/NemoClaw runtime URL", () => {
    const config = readConfig({
      ...validEnv,
      AGENT_RUNTIME: "openclaw-nemoclaw",
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
