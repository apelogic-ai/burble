import type {
  RuntimeCapabilityManifest,
  RuntimeRunRequest
} from "./runtime-contract";
import type { RuntimeContractClient } from "./runtime-contract-harness";

export type RuntimeContractFetch = (
  url: string,
  init?: RequestInit
) => Promise<Response>;

export type RuntimeContractWebSocket = {
  addEventListener: (
    type: "message" | "error" | "close",
    listener: (event: { data?: unknown }) => void
  ) => void;
  close: () => void;
};

export type RuntimeContractWebSocketFactory = (
  url: string
) => RuntimeContractWebSocket;

export function createRuntimeContractHttpClient(input: {
  baseUrl: string;
  manifest: RuntimeCapabilityManifest;
  fetch?: RuntimeContractFetch;
  webSocketFactory?: RuntimeContractWebSocketFactory;
  headers?: HeadersInit;
}): RuntimeContractClient {
  const baseUrl = input.baseUrl.replace(/\/+$/, "");
  const requestFetch = input.fetch ?? fetch;
  const createWebSocket =
    input.webSocketFactory ?? ((url: string) => new WebSocket(url));

  return {
    async getCapabilityManifest() {
      return input.manifest;
    },
    async health() {
      const response = await requestFetch(`${baseUrl}/healthz`, {
        method: "GET",
        headers: input.headers
      });
      return {
        ok: response.ok,
        detail: response.ok ? undefined : await response.text()
      };
    },
    async startRun(request: RuntimeRunRequest) {
      const response = await requestFetch(`${baseUrl}/runs`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          prefer: "respond-async",
          ...toHeaderRecord(input.headers)
        },
        body: JSON.stringify(request)
      });
      if (!response.ok) {
        throw new Error(`Runtime returned HTTP ${response.status}`);
      }
      const payload = (await response.json()) as unknown;
      if (!isRecord(payload) || typeof payload.runId !== "string") {
        throw new Error("Runtime returned an invalid run start response");
      }
      return { runId: payload.runId };
    },
    streamRunEvents(runId: string) {
      return readWebSocketEvents(
        createWebSocket(
          toWebSocketUrl(`${baseUrl}/runs/${encodeURIComponent(runId)}/events`)
        )
      );
    }
  };
}

async function* readWebSocketEvents(
  socket: RuntimeContractWebSocket
): AsyncIterable<unknown> {
  const queue: unknown[] = [];
  let closed = false;
  let failed: Error | null = null;
  let wake: (() => void) | undefined;

  const wakeReader = () => {
    wake?.();
    wake = undefined;
  };

  socket.addEventListener("message", (event) => {
    try {
      queue.push(JSON.parse(String(event.data ?? "")));
    } catch (error) {
      failed = error instanceof Error ? error : new Error("Invalid runtime event");
    }
    wakeReader();
  });
  socket.addEventListener("error", () => {
    failed = new Error("Runtime event socket errored");
    wakeReader();
  });
  socket.addEventListener("close", () => {
    closed = true;
    wakeReader();
  });

  try {
    while (true) {
      while (queue.length > 0) {
        yield queue.shift();
      }
      if (failed) {
        throw failed;
      }
      if (closed) {
        return;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    socket.close();
  }
}

function toWebSocketUrl(url: string): string {
  const parsed = new URL(url);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  return parsed.toString();
}

function toHeaderRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) {
    return {};
  }
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return headers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
