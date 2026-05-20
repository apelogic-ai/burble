export type RuntimeConfig = {
  port: number;
  toolGatewayUrl: string;
  internalToken: string;
};

type Env = Record<string, string | undefined>;

export function readRuntimeConfig(env: Env): RuntimeConfig {
  return {
    port: readPort(env.PORT ?? "8080"),
    toolGatewayUrl: requiredEnv(env, "BURBLE_TOOL_GATEWAY_URL").replace(
      /\/+$/,
      ""
    ),
    internalToken: requiredEnv(env, "BURBLE_INTERNAL_TOKEN")
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
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("PORT must be a positive integer");
  }

  return parsed;
}
