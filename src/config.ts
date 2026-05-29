import { validateAgentModelId } from "./agent/providers";
import type { AgentRuntimeEngine } from "./db";

export type Config = {
  slackBotToken: string;
  slackAppToken: string;
  slackClientId: string | null;
  slackClientSecret: string | null;
  slackRedirectUri: string;
  githubClientId: string;
  githubClientSecret: string;
  jiraClientId: string | null;
  jiraClientSecret: string | null;
  googleClientId: string | null;
  googleClientSecret: string | null;
  baseUrl: string;
  port: number;
  databasePath: string;
  slackLogLevel: SlackLogLevel;
  agentMode: AgentMode;
  agentRuntime: AgentRuntime;
  agentRuntimeFactory: AgentRuntimeFactory;
  aiModel: string;
  openClawNemoClawUrl: string | null;
  agentRuntimeEngine: AgentRuntimeEngine;
  openClawNemoClawEngine: OpenClawNemoClawEngine;
  agentRuntimeDataRoot: string;
  agentRuntimeDockerNetwork: string;
  agentRuntimeImage: string;
  agentRuntimeIdleTtlMs: number;
  agentRuntimeReaperEnabled: boolean;
  agentRuntimeReaperIntervalMs: number;
  agentRuntimeJwtTtlSeconds: number;
  agentRuntimeTokenSecret: string | null;
  agentRuntimeToolGatewayUrl: string;
  agentRuntimeMcpGatewayUrl: string | null;
  agentRuntimeMcpAudience: string | null;
  atlassianMcpUrl: string;
  runtimeJwtIssuer: string;
  runtimeJwtPrivateKeyPath: string | null;
  openClawConfigPatchHostPath: string | null;
  internalApiToken: string | null;
};

type Env = Record<string, string | undefined>;
export type SlackLogLevel = "debug" | "info" | "warn" | "error";
export type AgentMode = "deterministic" | "llm";
export type AgentRuntime = "ai-sdk" | "burble-runtime";
export type AgentRuntimeFactory = "static" | "docker";
export type OpenClawNemoClawEngine = AgentRuntimeEngine;
const slackLogLevels = ["debug", "info", "warn", "error"] as const;
const agentModes = ["deterministic", "llm"] as const;
const agentRuntimes = ["ai-sdk", "burble-runtime"] as const;
const agentRuntimeFactories = ["static", "docker"] as const;
const agentRuntimeEngines = [
  "deterministic",
  "openclaw",
  "openclaw-gateway",
  "burble-direct",
  "hermes"
] as const;

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

function optionalBoolEnv(env: Env, name: string, fallback: boolean): boolean {
  const value = env[name]?.trim().toLowerCase();
  if (!value) {
    return fallback;
  }

  if (["1", "true", "yes", "on"].includes(value)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(value)) {
    return false;
  }

  throw new Error(
    `Environment variable ${name} must be a boolean (true/false)`
  );
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
  const value = env[name]?.trim().toLowerCase();
  if (!value) {
    return fallback;
  }

  const normalized = value === "openclaw-nemoclaw" ? "burble-runtime" : value;

  if (!agentRuntimes.includes(normalized as AgentRuntime)) {
    throw new Error(
      `Environment variable ${name} must be one of ${agentRuntimes.join(", ")}`
    );
  }

  return normalized as AgentRuntime;
}

function optionalAgentRuntimeFactoryEnv(
  env: Env,
  name: string,
  fallback: AgentRuntimeFactory
): AgentRuntimeFactory {
  const value = env[name]?.toLowerCase();
  if (!value) {
    return fallback;
  }

  if (!agentRuntimeFactories.includes(value as AgentRuntimeFactory)) {
    throw new Error(
      `Environment variable ${name} must be one of ${agentRuntimeFactories.join(", ")}`
    );
  }

  return value as AgentRuntimeFactory;
}

function optionalAgentRuntimeEngineEnv(
  env: Env,
  name: string,
  fallback: AgentRuntimeEngine
): AgentRuntimeEngine {
  const value = env[name]?.trim().toLowerCase();
  if (!value) {
    return fallback;
  }

  const normalized =
    value === "openclaw-cli"
      ? "openclaw"
      : value === "direct-provider"
        ? "burble-direct"
        : value === "nemo-hermes"
          ? "hermes"
        : value;
  if (!agentRuntimeEngines.includes(normalized as AgentRuntimeEngine)) {
    throw new Error(
      `Environment variable ${name} must be one of ${agentRuntimeEngines.join(", ")}`
    );
  }

  return normalized as AgentRuntimeEngine;
}

function optionalUrlEnv(env: Env, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value.replace(/\/+$/, "") : null;
}

export function readConfig(env: Env): Config {
  const baseUrl = requiredEnv(env, "BASE_URL").replace(/\/+$/, "");
  const internalApiToken = optionalSecretEnv(env, "INTERNAL_API_TOKEN");
  const agentRuntimeEngine = optionalAgentRuntimeEngineEnv(
    env,
    env.AGENT_RUNTIME_ENGINE ? "AGENT_RUNTIME_ENGINE" : "OPENCLAW_NEMOCLAW_ENGINE",
    "openclaw"
  );
  const agentRuntimeFactory = optionalAgentRuntimeFactoryEnv(
    env,
    "AGENT_RUNTIME_FACTORY",
    "static"
  );
  const defaultAgentRuntimeMcpGatewayUrl =
    agentRuntimeFactory === "docker" ? "http://burble-app:3000/mcp" : null;
  const agentRuntimeMcpGatewayUrl =
    optionalUrlEnv(env, "AGENT_RUNTIME_MCP_GATEWAY_URL") ??
    defaultAgentRuntimeMcpGatewayUrl;

  return {
    slackBotToken: requiredEnv(env, "SLACK_BOT_TOKEN"),
    slackAppToken: requiredEnv(env, "SLACK_APP_TOKEN"),
    slackClientId: optionalSecretEnv(env, "SLACK_CLIENT_ID"),
    slackClientSecret: optionalSecretEnv(env, "SLACK_CLIENT_SECRET"),
    slackRedirectUri:
      optionalUrlEnv(env, "SLACK_REDIRECT_URI") ??
      `${baseUrl}/oauth/slack/callback`,
    githubClientId: requiredEnv(env, "GITHUB_CLIENT_ID"),
    githubClientSecret: requiredEnv(env, "GITHUB_CLIENT_SECRET"),
    jiraClientId: optionalSecretEnv(env, "JIRA_CLIENT_ID"),
    jiraClientSecret: optionalSecretEnv(env, "JIRA_CLIENT_SECRET"),
    googleClientId: optionalSecretEnv(env, "GOOGLE_CLIENT_ID"),
    googleClientSecret: optionalSecretEnv(env, "GOOGLE_CLIENT_SECRET"),
    baseUrl,
    port: optionalIntEnv(env, "PORT", 3000),
    databasePath: env.DATABASE_PATH ?? "burble.db",
    slackLogLevel: optionalSlackLogLevelEnv(env, "SLACK_LOG_LEVEL", "info"),
    agentMode: optionalAgentModeEnv(env, "AGENT_MODE", "deterministic"),
    agentRuntime: optionalAgentRuntimeEnv(env, "AGENT_RUNTIME", "ai-sdk"),
    agentRuntimeFactory,
    aiModel: validateAgentModelId(env.AI_MODEL ?? "openai:gpt-5.4"),
    openClawNemoClawUrl: optionalUrlEnv(env, "OPENCLAW_NEMOCLAW_URL"),
    agentRuntimeEngine,
    openClawNemoClawEngine: agentRuntimeEngine,
    agentRuntimeDataRoot: env.AGENT_RUNTIME_DATA_ROOT ?? "/data/runtimes",
    agentRuntimeDockerNetwork:
      env.AGENT_RUNTIME_DOCKER_NETWORK ?? "compose_default",
    agentRuntimeImage:
      env.AGENT_RUNTIME_IMAGE ??
      env.OPENCLAW_NEMOCLAW_IMAGE ??
      "burble-openclaw-nemoclaw:dev",
    agentRuntimeIdleTtlMs: optionalIntEnv(
      env,
      "AGENT_RUNTIME_IDLE_TTL_MS",
      24 * 60 * 60 * 1000
    ),
    agentRuntimeReaperEnabled: optionalBoolEnv(
      env,
      "AGENT_RUNTIME_REAPER_ENABLED",
      true
    ),
    agentRuntimeReaperIntervalMs: optionalIntEnv(
      env,
      "AGENT_RUNTIME_REAPER_INTERVAL_MS",
      60 * 1000
    ),
    agentRuntimeJwtTtlSeconds: optionalIntEnv(
      env,
      "AGENT_RUNTIME_JWT_TTL_SECONDS",
      7 * 24 * 60 * 60
    ),
    agentRuntimeTokenSecret:
      optionalSecretEnv(env, "AGENT_RUNTIME_TOKEN_SECRET") ?? internalApiToken,
    agentRuntimeToolGatewayUrl:
      env.AGENT_RUNTIME_TOOL_GATEWAY_URL ??
      "http://burble-app:3000/internal/tools",
    agentRuntimeMcpGatewayUrl,
    agentRuntimeMcpAudience:
      optionalUrlEnv(env, "AGENT_RUNTIME_MCP_AUDIENCE") ??
      agentRuntimeMcpGatewayUrl,
    atlassianMcpUrl:
      optionalUrlEnv(env, "ATLASSIAN_MCP_URL") ??
      "https://mcp.atlassian.com/v1/mcp",
    runtimeJwtIssuer:
      optionalUrlEnv(env, "RUNTIME_JWT_ISSUER") ?? baseUrl,
    runtimeJwtPrivateKeyPath: optionalSecretEnv(
      env,
      "RUNTIME_JWT_PRIVATE_KEY_PATH"
    ),
    openClawConfigPatchHostPath:
      optionalSecretEnv(env, "AGENT_RUNTIME_CONFIG_PATCH_HOST_PATH") ??
      optionalSecretEnv(env, "OPENCLAW_CONFIG_PATCH_HOST_PATH"),
    internalApiToken
  };
}

function optionalSecretEnv(env: Env, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

export function loadConfig(): Config {
  return readConfig(Bun.env);
}
