import { describe, expect, test } from "bun:test";
import { createTokenStore } from "../../src/db";
import { runRuntimeConformanceCheck } from "../../src/agent/runtime-conformance-harness";
import { createStaticRuntimeFactory } from "../../src/agent/runtime-factory";
import type {
  RuntimeContractFetch,
  RuntimeContractWebSocket
} from "../../src/agent/runtime-contract-http-client";

class FakeRuntimeWebSocket implements RuntimeContractWebSocket {
  private readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
  closed = false;

  constructor(events: unknown[]) {
    queueMicrotask(() => {
      for (const event of events) {
        this.dispatch("message", { data: JSON.stringify(event) });
      }
      this.dispatch("close", {});
    });
  }

  addEventListener(
    type: "message" | "error" | "close",
    listener: (event: { data?: unknown }) => void
  ): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  close(): void {
    this.closed = true;
  }

  private dispatch(type: "message" | "error" | "close", event: { data?: unknown }) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

describe("runtime conformance harness", () => {
  test("runs the SDK smoke test against a runtime factory endpoint", async () => {
    const store = createTokenStore(":memory:");
    const runtimeFactory = createStaticRuntimeFactory({
      store,
      engine: "hermes",
      endpointUrl: "http://runtime.local",
      authToken: "runtime-token",
      dataRoot: "/tmp/runtime-conformance-test"
    });
    const fetchCalls: string[] = [];
    const runtimeFetch: RuntimeContractFetch = async (url, init) => {
      fetchCalls.push(`${init?.method ?? "GET"} ${url}`);
      const parsed = new URL(url);
      if (parsed.pathname === "/healthz") {
        return new Response("ok");
      }
      if (parsed.pathname === "/capabilities") {
        return Response.json({
          runtimeType: "hermes",
          version: "1",
          transports: ["http", "websocket"],
          streaming: true,
          cancellation: false,
          nativeScheduler: true,
          scheduledProviderCalls: true,
          toolCalls: true,
          toolBridgeModes: ["tool_gateway"],
          usageReporting: "exact",
          multimodalInput: false,
          multimodalOutput: false,
          memory: false,
          durableWorkflowState: true,
          attachments: false,
          conversationSend: true,
          jobScopedAuth: true
        });
      }
      if (parsed.pathname === "/runs") {
        expect(init?.headers).toMatchObject({
          "x-burble-runtime-id": expect.any(String)
        });
        const request = JSON.parse(String(init?.body ?? "{}")) as {
          runId?: string;
        };
        return Response.json({ runId: request.runId });
      }
      return new Response("not found", { status: 404 });
    };

    const report = await runRuntimeConformanceCheck({
      engine: "hermes",
      principal: { workspaceId: "T123", slackUserId: "U123" },
      runtimeFactory,
      fetch: runtimeFetch,
      webSocketFactory: () =>
        new FakeRuntimeWebSocket([
          { type: "status", text: "accepted" },
          {
            type: "final",
            response: {
              classification: "user_private",
              text: "ok",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2
              }
            }
          }
        ])
    });

    expect(report).toMatchObject({
      engine: "hermes",
      runtimeType: "hermes",
      checks: [
        { name: "manifest", status: "ok" },
        { name: "health", status: "ok" },
        { name: "run_accepted", status: "ok" },
        { name: "events_stream", status: "ok" },
        { name: "final_response", status: "ok" },
        { name: "usage", status: "ok" }
      ]
    });
    expect(fetchCalls).toEqual([
      "GET http://runtime.local/capabilities",
      "GET http://runtime.local/healthz",
      "POST http://runtime.local/runs"
    ]);

    store.close();
  });
});
