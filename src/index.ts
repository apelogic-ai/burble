import { loadConfig } from "./config";
import { createTokenStore } from "./db";
import { startRuntimeReaper } from "./agent/runtime-reaper";
import { startOAuthServer } from "./server";
import { createSlackRuntime } from "./slack";
import { formatLogError, formatLogLine, withUtcTimestamp } from "./logging";
import { createRuntimeJwtIssuer } from "./runtime-jwt";
import { createMcpIdentityIssuer } from "./mcp-identity";
import { createObservabilitySink } from "./observability";
import { createConfiguredSandboxProvider } from "./agent/sandbox-providers/configured";
import {
  installSlackTestbed,
  testbedUserId,
  testbedWorkspaceId
} from "./testbed/slack";

const config = loadConfig();
const store = createTokenStore(config.databasePath);
if (config.testbed) {
  store.upsertWorkspacePolicy({
    workspaceId: testbedWorkspaceId,
    key: "runtime.allowedEngines",
    value: ["hermes", "openclaw"],
    updatedBySlackUserId: testbedUserId
  });
}
const observability = createObservabilitySink({
  path: config.observabilityJsonlPath,
  dir: config.observabilityJsonlDir,
  includeContent: config.observabilityIncludeContent
});
const runtimeJwtIssuer = createRuntimeJwtIssuer({
  issuer: config.runtimeJwtIssuer,
  privateKeyPath: config.runtimeJwtPrivateKeyPath
});
const mcpIdentityIssuer = createMcpIdentityIssuer({
  issuer: config.mcpIdentityIssuer,
  privateKeyPath: config.mcpIdentityPrivateKeyPath
});
const slack = createSlackRuntime(
  config,
  store,
  runtimeJwtIssuer,
  observability,
  config.agentRuntimeFactory === "sandbox"
    ? {
        ...(config.testbed ? { testbed: true } : {}),
        mcpIdentityIssuer,
        sandboxProvider: createConfiguredSandboxProvider(config),
        ...(config.agentRuntimeSandboxStartCommand
          ? { sandboxStartCommand: config.agentRuntimeSandboxStartCommand }
          : {})
      }
    : config.testbed
      ? { testbed: true, mcpIdentityIssuer }
      : { mcpIdentityIssuer }
);
const slackTestbed = config.testbed ? installSlackTestbed(slack) : undefined;
const server = startOAuthServer(
  config,
  store,
  slack,
  runtimeJwtIssuer,
  { observability, mcpIdentityIssuer },
  slackTestbed
);
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

if (config.testbed) {
  console.log(withUtcTimestamp("Burble local testbed is running."));
} else {
  await slack.app.start();
  console.log(withUtcTimestamp("Slack Socket Mode app is running."));
}

async function shutdown(): Promise<void> {
  runtimeReaper?.stop();
  server.stop();
  slack.close();
  if (!config.testbed) {
    await slack.app.stop();
  }
  store.close();
}
