import { loadConfig } from "./config";
import { createTokenStore } from "./db";
import { startRuntimeReaper } from "./agent/runtime-reaper";
import { startOAuthServer } from "./server";
import { createSlackRuntime } from "./slack";

const config = loadConfig();
const store = createTokenStore(config.databasePath);
const slack = createSlackRuntime(config, store);
const server = startOAuthServer(config, store, slack);
const runtimeReaper = slack.runtimeFactory
  ? startRuntimeReaper({
      factory: slack.runtimeFactory,
      intervalMs: config.agentRuntimeReaperIntervalMs,
      logInfo: (message) => console.log(message),
      logError: (error) => console.error(error)
    })
  : undefined;

console.log(`OAuth callback server listening on http://localhost:${server.port}`);

process.on("SIGINT", async () => {
  await shutdown();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await shutdown();
  process.exit(0);
});

await slack.app.start();
console.log("Slack Socket Mode app is running.");

async function shutdown(): Promise<void> {
  runtimeReaper?.stop();
  server.stop();
  await slack.app.stop();
  store.close();
}
