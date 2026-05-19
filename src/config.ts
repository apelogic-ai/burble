export type Config = {
  slackBotToken: string;
  slackAppToken: string;
  githubClientId: string;
  githubClientSecret: string;
  baseUrl: string;
  port: number;
  databasePath: string;
};

type Env = Record<string, string | undefined>;

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

export function readConfig(env: Env): Config {
  const baseUrl = requiredEnv(env, "BASE_URL").replace(/\/+$/, "");

  return {
    slackBotToken: requiredEnv(env, "SLACK_BOT_TOKEN"),
    slackAppToken: requiredEnv(env, "SLACK_APP_TOKEN"),
    githubClientId: requiredEnv(env, "GITHUB_CLIENT_ID"),
    githubClientSecret: requiredEnv(env, "GITHUB_CLIENT_SECRET"),
    baseUrl,
    port: optionalIntEnv(env, "PORT", 3000),
    databasePath: env.DATABASE_PATH ?? "burble.db"
  };
}

export function loadConfig(): Config {
  return readConfig(Bun.env);
}
