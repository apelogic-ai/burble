import { loadConfig } from "./config";
import { createTokenStore } from "./db";
import { startRuntimeReaper } from "./agent/runtime-reaper";
import { startOAuthServer } from "./server";
import { createSlackRuntime } from "./slack";
import { formatLogError, formatLogLine, withUtcTimestamp } from "./logging";
import { createRuntimeJwtIssuer } from "./runtime-jwt";
import { createObservabilitySink } from "./observability";

const config = loadConfig();
const store = createTokenStore(config.databasePath);
const observability = createObservabilitySink({
  path: config.observabilityJsonlPath,
  includeContent: config.observabilityIncludeContent
});
const runtimeJwtIssuer = createRuntimeJwtIssuer({
  issuer: config.runtimeJwtIssuer,
  privateKeyPath: config.runtimeJwtPrivateKeyPath
});
const slack = createSlackRuntime(config, store, runtimeJwtIssuer, observability);
const server = startOAuthServer(config, store, slack, runtimeJwtIssuer);
const logDebug =
  config.slackLogLevel === "debug"
    ? (message: string) => console.debug(formatLogLine("debug", message))
    : () => undefined;
const runtimeReaper =
  config.agentRuntimeReaperEnabled && slack.runtimeFactory
  ? startRuntimeReaper({
      factory: slack.runtimeFactory,
      intervalMs: config.agentRuntimeReaperIntervalMs,
      logDebug,
      logError: (error) => console.error(formatLogError(error))
    })
  : undefined;

console.log(
  withUtcTimestamp(
    `OAuth callback server listening on http://localhost:${server.port}`
  )
);

process.on("SIGINT", async () => {
  await shutdown();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await shutdown();
  process.exit(0);
});

await slack.app.start();
console.log(withUtcTimestamp("Slack Socket Mode app is running."));

async function shutdown(): Promise<void> {
  runtimeReaper?.stop();
  server.stop();
  await slack.app.stop();
  store.close();
}
