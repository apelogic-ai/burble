import {
  attachRuntimeEventWebSocket,
  handleRuntimeRequest
} from "./server";

const port = readPort(Bun.env.PORT);

type RuntimeWebSocketData = {
  runId: string;
};

let server: Bun.Server<RuntimeWebSocketData>;
server = Bun.serve<RuntimeWebSocketData>({
  port,
  fetch: (request) =>
    handleRuntimeRequest(
      request,
      { env: Bun.env },
      {
        upgradeWebSocket: (runId) =>
          server.upgrade(request, {
            data: { runId }
          })
      }
    ),
  websocket: {
    open(ws) {
      attachRuntimeEventWebSocket(ws.data.runId, ws);
    },
    message() {}
  }
});

console.log(`Burble Native runtime listening on http://localhost:${server.port}`);

function readPort(value: string | undefined): number {
  const port = Number.parseInt(value ?? "8080", 10);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error("PORT must be a positive integer");
  }
  return port;
}
