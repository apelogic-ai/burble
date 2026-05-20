import { validateAgentModelId } from "./agent/providers";

export type Config = {
  slackBotToken: string;
  slackAppToken: string;
  githubClientId: string;
  githubClientSecret: string;
  baseUrl: string;
  port: number;
  databasePath: string;
  slackLogLevel: SlackLogLevel;
  agentMode: AgentMode;
  agentRuntime: AgentRuntime;
  aiModel: string;
  openClawNemoClawUrl: string | null;
};

type Env = Record<string, string | undefined>;
export type SlackLogLevel = "debug" | "info" | "warn" | "error";
export type AgentMode = "deterministic" | "llm";
export type AgentRuntime = "ai-sdk" | "openclaw-nemoclaw";
const slackLogLevels = ["debug", "info", "warn", "error"] as const;
const agentModes = ["deterministic", "llm"] as const;
const agentRuntimes = ["ai-sdk", "openclaw-nemoclaw"] as const;

function requiredEnv(env: Env, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalIntEnv(env: Env, name: string, fallback: number): number {
  const value = env[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer`);
  }
  return parsed;
}

function optionalSlackLogLevelEnv(
  env: Env,
  name: string,
  fallback: SlackLogLevel
): SlackLogLevel {
  const value = env[name]?.toLowerCase();
  if (!value) {
    return fallback;
  }

  if (!slackLogLevels.includes(value as SlackLogLevel)) {
    throw new Error(
      `Environment variable ${name} must be one of ${slackLogLevels.join(", ")}`
    );
  }

  return value as SlackLogLevel;
}

function optionalAgentModeEnv(
  env: Env,
  name: string,
  fallback: AgentMode
): AgentMode {
  const value = env[name]?.toLowerCase();
  if (!value) {
    return fallback;
  }

  if (!agentModes.includes(value as AgentMode)) {
    throw new Error(
      `Environment variable ${name} must be one of ${agentModes.join(", ")}`
    );
  }

  return value as AgentMode;
}

function optionalAgentRuntimeEnv(
  env: Env,
  name: string,
  fallback: AgentRuntime
): AgentRuntime {
  const value = env[name]?.toLowerCase();
  if (!value) {
    return fallback;
  }

  if (!agentRuntimes.includes(value as AgentRuntime)) {
    throw new Error(
      `Environment variable ${name} must be one of ${agentRuntimes.join(", ")}`
    );
  }

  return value as AgentRuntime;
}

function optionalUrlEnv(env: Env, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value.replace(/\/+$/, "") : null;
}

export function readConfig(env: Env): Config {
  const baseUrl = requiredEnv(env, "BASE_URL").replace(/\/+$/, "");

  return {
    slackBotToken: requiredEnv(env, "SLACK_BOT_TOKEN"),
    slackAppToken: requiredEnv(env, "SLACK_APP_TOKEN"),
    githubClientId: requiredEnv(env, "GITHUB_CLIENT_ID"),
    githubClientSecret: requiredEnv(env, "GITHUB_CLIENT_SECRET"),
    baseUrl,
    port: optionalIntEnv(env, "PORT", 3000),
    databasePath: env.DATABASE_PATH ?? "burble.db",
    slackLogLevel: optionalSlackLogLevelEnv(env, "SLACK_LOG_LEVEL", "info"),
    agentMode: optionalAgentModeEnv(env, "AGENT_MODE", "deterministic"),
    agentRuntime: optionalAgentRuntimeEnv(env, "AGENT_RUNTIME", "ai-sdk"),
    aiModel: validateAgentModelId(env.AI_MODEL ?? "openai:gpt-5.4"),
    openClawNemoClawUrl: optionalUrlEnv(env, "OPENCLAW_NEMOCLAW_URL")
  };
}

export function loadConfig(): Config {
  return readConfig(Bun.env);
}
