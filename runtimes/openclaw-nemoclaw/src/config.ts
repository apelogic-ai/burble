export type RuntimeConfig = {
  port: number;
  toolGatewayUrl: string;
  internalToken: string;
  engine: RuntimeEngine;
  openClawCommand: string;
  openClawAgent: string;
  openClawTimeoutMs: number;
};

export type RuntimeEngine = "deterministic" | "openclaw-cli";

type Env = Record<string, string | undefined>;
const runtimeEngines = ["deterministic", "openclaw-cli"] as const;

export function readRuntimeConfig(env: Env): RuntimeConfig {
  return {
    port: readPort(env.PORT ?? "8080"),
    toolGatewayUrl: requiredEnv(env, "BURBLE_TOOL_GATEWAY_URL").replace(
      /\/+$/,
      ""
    ),
    internalToken: requiredEnv(env, "BURBLE_INTERNAL_TOKEN"),
    engine: readRuntimeEngine(env.OPENCLAW_NEMOCLAW_ENGINE ?? "deterministic"),
    openClawCommand: env.OPENCLAW_COMMAND?.trim() || "openclaw",
    openClawAgent: env.OPENCLAW_AGENT?.trim() || "main",
    openClawTimeoutMs: readPositiveInt(env.OPENCLAW_TIMEOUT_MS ?? "60000", "OPENCLAW_TIMEOUT_MS")
  };
}

function requiredEnv(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function readPort(value: string): number {
  return readPositiveInt(value, "PORT");
}

function readPositiveInt(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function readRuntimeEngine(value: string): RuntimeEngine {
  const normalized = value.trim().toLowerCase();
  if (!runtimeEngines.includes(normalized as RuntimeEngine)) {
    throw new Error(
      `Environment variable OPENCLAW_NEMOCLAW_ENGINE must be one of ${runtimeEngines.join(", ")}`
    );
  }

  return normalized as RuntimeEngine;
}
