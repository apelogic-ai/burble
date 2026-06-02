import { describe, expect, test } from "bun:test";
import { createRuntimeContractHttpClient } from "../../src/agent/runtime-contract-http-client";
import { runRuntimeContractSmokeTest } from "../../src/agent/runtime-contract-harness";
import type { RuntimeCapabilityManifest } from "../../src/agent/runtime-contract";

const manifest: RuntimeCapabilityManifest = {
  runtimeType: "openclaw-gateway",
  version: "2026.6.1",
  transports: ["http", "websocket"],
  streaming: true,
  cancellation: true,
  nativeScheduler: true,
  scheduledProviderCalls: true,
  toolCalls: true,
  toolBridgeModes: ["mcp", "tool_gateway"],
  usageReporting: "exact",
  multimodalInput: true,
  multimodalOutput: false,
  memory: true,
  durableWorkflowState: false,
  attachments: true,
  conversationSend: true,
  jobScopedAuth: true
};

const request = {
  runId: "run-http-contract",
  principal: {
    workspaceId: "T123",
    slackUserId: "U123"
  },
  runtime: {
    id: "rt_http",
    engine: "openclaw-gateway"
  },
  input: {
    text: "hello agent",
    connections: {
      github: { connected: false }
    }
  }
};

describe("runtime contract HTTP client", () => {
  test("adapts /healthz, /runs, and websocket events to the harness", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url, init });
      if (url === "http://runtime.local/healthz") {
        return new Response("ok");
      }
      if (url === "http://runtime.local/runs") {
        expect(init?.method).toBe("POST");
        expect(header(init, "prefer")).toBe("respond-async");
        return Response.json({
          runId: "run-http-contract",
          eventsUrl: "/runs/run-http-contract/events"
        });
      }
      throw new Error(`Unexpected fetch ${url}`);
    };

    const client = createRuntimeContractHttpClient({
      baseUrl: "http://runtime.local",
      manifest,
      fetch: fetchMock,
      webSocketFactory: (url) =>
        new FakeWebSocket(url, [
          { type: "status", text: "Working..." },
          {
            type: "final",
            response: {
              classification: "user_private",
              text: "Hello.",
              usage: {
                inputTokens: 4,
                outputTokens: 2,
                totalTokens: 6,
                usageSource: "provider-output"
              }
            }
          }
        ])
    });

    await expect(
      runRuntimeContractSmokeTest({ client, request })
    ).resolves.toMatchObject({
      runtimeType: "openclaw-gateway",
      runId: "run-http-contract"
    });
    expect(calls.map((call) => call.url)).toEqual([
      "http://runtime.local/healthz",
      "http://runtime.local/runs"
    ]);
  });

  test("discovers runtime capabilities over HTTP when no manifest is provided", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url, init });
      if (url === "http://runtime.local/capabilities") {
        return Response.json(manifest);
      }
      if (url === "http://runtime.local/healthz") {
        return new Response("ok");
      }
      if (url === "http://runtime.local/runs") {
        return Response.json({
          runId: "run-http-contract",
          eventsUrl: "/runs/run-http-contract/events"
        });
      }
      throw new Error(`Unexpected fetch ${url}`);
    };

    const client = createRuntimeContractHttpClient({
      baseUrl: "http://runtime.local",
      fetch: fetchMock,
      webSocketFactory: (url) =>
        new FakeWebSocket(url, [
          { type: "status", text: "Working..." },
          {
            type: "final",
            response: {
              classification: "user_private",
              text: "Hello.",
              usage: {
                totalTokens: 6,
                usageSource: "provider-output"
              }
            }
          }
        ])
    });

    await expect(
      runRuntimeContractSmokeTest({ client, request })
    ).resolves.toMatchObject({
      runtimeType: "openclaw-gateway",
      runId: "run-http-contract"
    });
    expect(calls.map((call) => call.url)).toEqual([
      "http://runtime.local/capabilities",
      "http://runtime.local/healthz",
      "http://runtime.local/runs"
    ]);
  });
});

function header(init: RequestInit | undefined, name: string): string | null {
  const headers = init?.headers;
  if (!headers || Array.isArray(headers)) {
    return null;
  }
  if (headers instanceof Headers) {
    return headers.get(name);
  }
  return headers[name] ?? null;
}

class FakeWebSocket {
  readonly url: string;
  private readonly events: unknown[];
  private readonly listeners = new Map<string, Array<(event: { data?: string }) => void>>();

  constructor(url: string, events: unknown[]) {
    this.url = url;
    this.events = events;
    queueMicrotask(() => {
      for (const event of this.events) {
        this.emit("message", { data: JSON.stringify(event) });
      }
    });
  }

  addEventListener(
    type: "message" | "error" | "close",
    listener: (event: { data?: string }) => void
  ) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  close() {
    this.emit("close", {});
  }

  private emit(type: string, event: { data?: string }) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}
