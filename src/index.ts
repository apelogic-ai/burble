import { loadConfig } from "./config";
import { createTokenStore } from "./db";
import { startOAuthServer } from "./server";
import { createSlackRuntime } from "./slack";

const config = loadConfig();
const store = createTokenStore(config.databasePath);
const slack = createSlackRuntime(config, store);
const server = startOAuthServer(config, store, slack);

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
  server.stop();
  await slack.app.stop();
  store.close();
}
