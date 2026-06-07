import {
  attachRuntimeEventWebSocket,
  handleRuntimeRequest
} from "./server";
import { createBurbleNativeToolExecutor } from "./tools";

const port = readPort(Bun.env.PORT);
const toolGatewayUrl = requiredEnv("BURBLE_TOOL_GATEWAY_URL");
const runtimeToken = requiredEnv("BURBLE_INTERNAL_TOKEN");
const executeTool = createBurbleNativeToolExecutor({
  toolGatewayUrl,
  runtimeToken
});

type RuntimeWebSocketData = {
  runId: string;
};

let server: Bun.Server<RuntimeWebSocketData>;
server = Bun.serve<RuntimeWebSocketData>({
  port,
  fetch: (request) =>
    handleRuntimeRequest(
      request,
      { executeTool },
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

function requiredEnv(name: string): string {
  const value = Bun.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function readPort(value: string | undefined): number {
  const port = Number.parseInt(value ?? "8080", 10);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error("PORT must be a positive integer");
  }
  return port;
}
