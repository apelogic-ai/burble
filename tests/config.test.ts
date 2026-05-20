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
      aiModel: "openai:gpt-5.4"
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
      AI_MODEL: "anthropic:claude-opus-4.6"
    });

    expect(config.agentMode).toBe("llm");
    expect(config.aiModel).toBe("anthropic:claude-opus-4.6");
  });

  test("rejects invalid agent modes", () => {
    expect(() => readConfig({ ...validEnv, AGENT_MODE: "robot" })).toThrow(
      "Environment variable AGENT_MODE must be one of deterministic, llm"
    );
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
