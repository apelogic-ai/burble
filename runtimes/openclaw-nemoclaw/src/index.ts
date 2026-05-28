import { readRuntimeConfig } from "./config";
import { startOpenClawGatewayIfNeeded } from "./gateway";
import { startRuntimeHeartbeat } from "./heartbeat";
import { info } from "./logger";
import { attachRuntimeEventWebSocket, handleRuntimeRequest } from "./server";
import { ensureOpenClawSetup } from "./setup";

const config = readRuntimeConfig(Bun.env);

info(
  [
    "OpenClaw/NemoClaw runtime config",
    `engine=${config.engine}`,
    `mcpGatewayConfigured=${Boolean(config.mcpGatewayUrl)}`,
    `runtimeJwtConfigured=${Boolean(config.runtimeJwt)}`,
    `toolGatewayUrl=${config.toolGatewayUrl}`
  ].join(" ")
);

await ensureOpenClawSetup(config);
const gateway = startOpenClawGatewayIfNeeded(config);
const heartbeat = startRuntimeHeartbeat(config);
await gateway?.ready;
let nativeGateway = config.engine === "openclaw-gateway" ? gateway : null;
let nativeOpenClawReady: Promise<void> | null =
  config.engine === "openclaw-gateway" && gateway
    ? gateway.ready
    : null;

async function prepareNativeOpenClaw(nativeConfig: typeof config): Promise<void> {
  if (nativeOpenClawReady) {
    await nativeOpenClawReady;
    return;
  }

  const ready = (async () => {
    await ensureOpenClawSetup(nativeConfig);
    nativeGateway = startOpenClawGatewayIfNeeded(nativeConfig);
    await nativeGateway?.ready;
  })();
  nativeOpenClawReady = ready;
  ready.catch(() => {
    if (nativeOpenClawReady === ready) {
      nativeOpenClawReady = null;
    }
  });
  await nativeOpenClawReady;
}

type RuntimeWebSocketData = {
  runId: string;
};

let server: Bun.Server;
server = Bun.serve<RuntimeWebSocketData>({
  port: config.port,
  fetch: (request) =>
    handleRuntimeRequest(request, config, undefined, {
      prepareNativeOpenClaw,
      upgradeWebSocket: (runId) =>
        server.upgrade(request, {
          data: { runId }
        })
    }),
  websocket: {
    open(ws) {
      attachRuntimeEventWebSocket(ws.data.runId, ws);
    },
    message() {}
  }
});

info(
  `OpenClaw/NemoClaw Burble runtime listening on http://localhost:${server.port}`
);

process.on("SIGINT", () => {
  heartbeat?.stop();
  gateway?.stop();
  if (nativeGateway !== gateway) {
    nativeGateway?.stop();
  }
  server.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  heartbeat?.stop();
  gateway?.stop();
  if (nativeGateway !== gateway) {
    nativeGateway?.stop();
  }
  server.stop();
  process.exit(0);
});
