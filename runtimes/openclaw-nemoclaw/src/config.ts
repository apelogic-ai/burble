import { randomUUID } from "node:crypto";

export type RuntimeConfig = {
  port: number;
  contractProbeMode?: boolean;
  fetch?: RuntimeFetch;
  runtimeId?: string | null;
  runtimeHeartbeatIntervalMs?: number;
  toolGatewayUrl: string;
  internalToken: string;
  mcpGatewayUrl: string | null;
  runtimeJwt: string | null;
  engine: RuntimeEngine;
  openClawCommand: string;
  openClawAgent: string;
  openClawTimeoutMs: number;
  openClawStateDir: string;
  openClawConfigPath: string;
  openClawWorkspaceDir: string;
  openClawSetupOnStart: boolean;
  openClawConfigPatchPath: string | null;
  openClawValidateOnStart: boolean;
  openClawStreamDebug: boolean;
  openClawLogLevel?: string | null;
  openClawDiagnostics?: string | null;
  openClawDebugModelTransport?: string | null;
  openClawDebugModelPayload?: string | null;
  openClawDebugSse?: string | null;
  openClawDebugCodeMode?: string | null;
  openClawCodeMode: boolean;
  openClawFastMode: boolean;
  openClawRawStreamDebug: boolean;
  openClawGatewayPort: number;
  openClawGatewayBind: string;
  openClawGatewayToken: string;
  llmModel: string;
  ollamaBaseUrl: string;
};

export type RuntimeFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

export type RuntimeEngine =
  | "deterministic"
  | "openclaw"
  | "openclaw-gateway";

type Env = Record<string, string | undefined>;
const runtimeEngines = [
  "deterministic",
  "openclaw",
  "openclaw-gateway"
] as const;

export function readRuntimeConfig(env: Env): RuntimeConfig {
  const runtimeId = readOptionalEnv(env.BURBLE_RUNTIME_ID);
  return {
    port: readPort(env.PORT ?? "8080"),
    contractProbeMode: readBooleanEnv(
      env.BURBLE_RUNTIME_CONTRACT_PROBE ?? "false",
      "BURBLE_RUNTIME_CONTRACT_PROBE"
    ),
    ...(runtimeId ? { runtimeId } : {}),
    runtimeHeartbeatIntervalMs: readPositiveInt(
      env.BURBLE_RUNTIME_HEARTBEAT_INTERVAL_MS ?? "300000",
      "BURBLE_RUNTIME_HEARTBEAT_INTERVAL_MS"
    ),
    toolGatewayUrl: requiredEnv(env, "BURBLE_TOOL_GATEWAY_URL").replace(
      /\/+$/,
      ""
    ),
    internalToken: requiredEnv(env, "BURBLE_INTERNAL_TOKEN"),
    mcpGatewayUrl: readOptionalUrlEnv(env.BURBLE_MCP_GATEWAY_URL),
    runtimeJwt: readOptionalEnv(env.BURBLE_RUNTIME_JWT),
    engine: readRuntimeEngine(
      readOptionalEnv(env.AGENT_RUNTIME_ENGINE) ??
        readOptionalEnv(env.OPENCLAW_NEMOCLAW_ENGINE) ??
        "deterministic",
      readOptionalEnv(env.AGENT_RUNTIME_ENGINE)
        ? "AGENT_RUNTIME_ENGINE"
        : "OPENCLAW_NEMOCLAW_ENGINE"
    ),
    openClawCommand: env.OPENCLAW_COMMAND?.trim() || "openclaw",
    openClawAgent: env.OPENCLAW_AGENT?.trim() || "main",
    openClawTimeoutMs: readPositiveInt(
      env.OPENCLAW_TIMEOUT_MS ?? "60000",
      "OPENCLAW_TIMEOUT_MS"
    ),
    openClawStateDir:
      env.AGENT_RUNTIME_STATE_DIR?.trim() ||
      env.OPENCLAW_STATE_DIR?.trim() ||
      "/data/openclaw/state",
    openClawConfigPath:
      env.AGENT_RUNTIME_CONFIG_PATH?.trim() ||
      env.OPENCLAW_CONFIG_PATH?.trim() ||
      "/data/openclaw/config/openclaw.json",
    openClawWorkspaceDir:
      env.AGENT_RUNTIME_WORKSPACE_DIR?.trim() ||
      env.OPENCLAW_WORKSPACE_DIR?.trim() ||
      "/data/openclaw/workspace",
    openClawSetupOnStart: readBooleanEnv(
      env.OPENCLAW_SETUP_ON_START ?? "true",
      "OPENCLAW_SETUP_ON_START"
    ),
    openClawConfigPatchPath: readOptionalEnv(env.OPENCLAW_CONFIG_PATCH_PATH),
    openClawValidateOnStart: readBooleanEnv(
      env.OPENCLAW_VALIDATE_ON_START ?? "true",
      "OPENCLAW_VALIDATE_ON_START"
    ),
    openClawStreamDebug: readBooleanEnv(
      env.OPENCLAW_STREAM_DEBUG ?? "false",
      "OPENCLAW_STREAM_DEBUG"
    ),
    openClawLogLevel: readOptionalEnv(env.OPENCLAW_LOG_LEVEL),
    openClawDiagnostics: readOptionalEnv(env.OPENCLAW_DIAGNOSTICS),
    openClawDebugModelTransport: readOptionalEnv(
      env.OPENCLAW_DEBUG_MODEL_TRANSPORT
    ),
    openClawDebugModelPayload: readOptionalEnv(env.OPENCLAW_DEBUG_MODEL_PAYLOAD),
    openClawDebugSse: readOptionalEnv(env.OPENCLAW_DEBUG_SSE),
    openClawDebugCodeMode: readOptionalEnv(env.OPENCLAW_DEBUG_CODE_MODE),
    openClawCodeMode: readBooleanEnv(
      env.OPENCLAW_CODE_MODE ?? "false",
      "OPENCLAW_CODE_MODE"
    ),
    openClawFastMode: readBooleanEnv(
      env.OPENCLAW_FAST_MODE ?? "false",
      "OPENCLAW_FAST_MODE"
    ),
    openClawRawStreamDebug: readBooleanEnv(
      env.OPENCLAW_RAW_STREAM_DEBUG ?? "false",
      "OPENCLAW_RAW_STREAM_DEBUG"
    ),
    openClawGatewayPort: readPositiveInt(
      env.OPENCLAW_GATEWAY_PORT ?? "18789",
      "OPENCLAW_GATEWAY_PORT"
    ),
    openClawGatewayBind: env.OPENCLAW_GATEWAY_BIND?.trim() || "loopback",
    openClawGatewayToken:
      env.OPENCLAW_GATEWAY_TOKEN?.trim() || randomUUID().replace(/-/g, ""),
    llmModel: validateLlmModelId(
      readOptionalEnv(env.AI_MODEL) ??
        readOptionalEnv(env.OPENCLAW_MODEL) ??
        "openai:gpt-5.4"
    ),
    ollamaBaseUrl:
      readOptionalUrlEnv(env.OLLAMA_BASE_URL) ?? "https://ollama.com"
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

function readRuntimeEngine(value: string, name: string): RuntimeEngine {
  const normalized = value.trim().toLowerCase();
  if (normalized === "openclaw-cli") {
    return "openclaw";
  }

  if (!runtimeEngines.includes(normalized as RuntimeEngine)) {
    throw new Error(
      `Environment variable ${name} must be one of ${runtimeEngines.join(", ")}`
    );
  }

  return normalized as RuntimeEngine;
}

function readBooleanEnv(value: string, name: string): boolean {
  const normalized = stripOptionalQuotes(value).trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }

  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }

  throw new Error(`Environment variable ${name} must be true or false`);
}

function readOptionalEnv(value: string | undefined): string | null {
  const trimmed = stripOptionalQuotes(value ?? "").trim();
  if (trimmed === "undefined" || trimmed === "null") {
    return null;
  }
  return trimmed ? trimmed : null;
}

function readOptionalUrlEnv(value: string | undefined): string | null {
  return readOptionalEnv(value)?.replace(/\/+$/, "") ?? null;
}

function stripOptionalQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function validateLlmModelId(modelId: string): string {
  const separatorIndex = modelId.indexOf(":");
  const provider = separatorIndex >= 0 ? modelId.slice(0, separatorIndex) : "";
  const model = separatorIndex >= 0 ? modelId.slice(separatorIndex + 1) : "";

  if (!provider || !model) {
    throw new Error("AI_MODEL must use provider:model format");
  }

  if (!["openai", "anthropic", "ollama"].includes(provider)) {
    throw new Error("AI_MODEL provider must be one of openai, anthropic, ollama");
  }

  return modelId;
}
