import { readRuntimeConfig } from "./config";
import { startOpenClawGatewayIfNeeded } from "./gateway";
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
await gateway?.ready;

type RuntimeWebSocketData = {
  runId: string;
};

let server: Bun.Server;
server = Bun.serve<RuntimeWebSocketData>({
  port: config.port,
  fetch: (request) =>
    handleRuntimeRequest(request, config, undefined, {
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
  gateway?.stop();
  server.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  gateway?.stop();
  server.stop();
  process.exit(0);
});
