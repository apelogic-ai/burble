import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { createRoutedRuntimeWebSocketFactory } from "../../src/agent/runtime-websocket";

describe("runtime websocket routing", () => {
  test("uses ws package to replace Host for OpenShell virtual hosts", async () => {
    const { port, hostPromise, close } = await startUpgradeHostProbe();
    const factory = createRoutedRuntimeWebSocketFactory({
      openShellDialHost: `127.0.0.1:${port}`
    });

    const socket = factory(
      "ws://b-123--runtime.openshell.localhost:8080/runs/run-1/events",
      {
        headers: {
          authorization: "Bearer runtime-token"
        }
      }
    );

    expect(await hostPromise).toBe("b-123--runtime.openshell.localhost:8080");
    socket.close();
    await close();
  });
});

async function startUpgradeHostProbe(): Promise<{
  port: number;
  hostPromise: Promise<string | undefined>;
  close: () => Promise<void>;
}> {
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<Duplex>();
  let resolveHost!: (host: string | undefined) => void;
  const hostPromise = new Promise<string | undefined>((resolve) => {
    resolveHost = resolve;
  });

  server.on("upgrade", (request, socket, head) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    resolveHost(request.headers.host);
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.close();
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP server address");
  }

  return {
    port: address.port,
    hostPromise,
    close: async () => {
      for (const client of wss.clients) {
        client.terminate();
      }
      for (const socket of sockets) {
        socket.destroy();
      }
      server.closeAllConnections?.();
      server.closeIdleConnections?.();
      wss.close();
      if (!server.listening) {
        return;
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}
