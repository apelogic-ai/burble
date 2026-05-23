import { validateAgentModelId } from "./agent/providers";

export type Config = {
  slackBotToken: string;
  slackAppToken: string;
  githubClientId: string;
  githubClientSecret: string;
  jiraClientId: string | null;
  jiraClientSecret: string | null;
  baseUrl: string;
  port: number;
  databasePath: string;
  slackLogLevel: SlackLogLevel;
  agentMode: AgentMode;
  agentRuntime: AgentRuntime;
  agentRuntimeFactory: AgentRuntimeFactory;
  aiModel: string;
  openClawNemoClawUrl: string | null;
  agentRuntimeDataRoot: string;
  agentRuntimeDockerNetwork: string;
  agentRuntimeImage: string;
  agentRuntimeIdleTtlMs: number;
  agentRuntimeReaperIntervalMs: number;
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
export type AgentRuntime = "ai-sdk" | "openclaw-nemoclaw";
export type AgentRuntimeFactory = "static" | "docker";
const slackLogLevels = ["debug", "info", "warn", "error"] as const;
const agentModes = ["deterministic", "llm"] as const;
const agentRuntimes = ["ai-sdk", "openclaw-nemoclaw"] as const;
const agentRuntimeFactories = ["static", "docker"] as const;

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

function optionalUrlEnv(env: Env, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value.replace(/\/+$/, "") : null;
}

export function readConfig(env: Env): Config {
  const baseUrl = requiredEnv(env, "BASE_URL").replace(/\/+$/, "");
  const internalApiToken = optionalSecretEnv(env, "INTERNAL_API_TOKEN");

  return {
    slackBotToken: requiredEnv(env, "SLACK_BOT_TOKEN"),
    slackAppToken: requiredEnv(env, "SLACK_APP_TOKEN"),
    githubClientId: requiredEnv(env, "GITHUB_CLIENT_ID"),
    githubClientSecret: requiredEnv(env, "GITHUB_CLIENT_SECRET"),
    jiraClientId: optionalSecretEnv(env, "JIRA_CLIENT_ID"),
    jiraClientSecret: optionalSecretEnv(env, "JIRA_CLIENT_SECRET"),
    baseUrl,
    port: optionalIntEnv(env, "PORT", 3000),
    databasePath: env.DATABASE_PATH ?? "burble.db",
    slackLogLevel: optionalSlackLogLevelEnv(env, "SLACK_LOG_LEVEL", "info"),
    agentMode: optionalAgentModeEnv(env, "AGENT_MODE", "deterministic"),
    agentRuntime: optionalAgentRuntimeEnv(env, "AGENT_RUNTIME", "ai-sdk"),
    agentRuntimeFactory: optionalAgentRuntimeFactoryEnv(
      env,
      "AGENT_RUNTIME_FACTORY",
      "static"
    ),
    aiModel: validateAgentModelId(env.AI_MODEL ?? "openai:gpt-5.4"),
    openClawNemoClawUrl: optionalUrlEnv(env, "OPENCLAW_NEMOCLAW_URL"),
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
      30 * 60 * 1000
    ),
    agentRuntimeReaperIntervalMs: optionalIntEnv(
      env,
      "AGENT_RUNTIME_REAPER_INTERVAL_MS",
      60 * 1000
    ),
    agentRuntimeTokenSecret:
      optionalSecretEnv(env, "AGENT_RUNTIME_TOKEN_SECRET") ?? internalApiToken,
    agentRuntimeToolGatewayUrl:
      env.AGENT_RUNTIME_TOOL_GATEWAY_URL ??
      "http://burble-app:3000/internal/tools",
    agentRuntimeMcpGatewayUrl: optionalUrlEnv(
      env,
      "AGENT_RUNTIME_MCP_GATEWAY_URL"
    ),
    agentRuntimeMcpAudience:
      optionalUrlEnv(env, "AGENT_RUNTIME_MCP_AUDIENCE") ??
      optionalUrlEnv(env, "AGENT_RUNTIME_MCP_GATEWAY_URL"),
    atlassianMcpUrl:
      optionalUrlEnv(env, "ATLASSIAN_MCP_URL") ??
      "https://mcp.atlassian.com/v1/mcp",
    runtimeJwtIssuer:
      optionalUrlEnv(env, "RUNTIME_JWT_ISSUER") ?? baseUrl,
    runtimeJwtPrivateKeyPath: optionalSecretEnv(
      env,
      "RUNTIME_JWT_PRIVATE_KEY_PATH"
    ),
    openClawConfigPatchHostPath: optionalSecretEnv(
      env,
      "OPENCLAW_CONFIG_PATCH_HOST_PATH"
    ),
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
