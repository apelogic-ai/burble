import { describe, expect, test } from "bun:test";
import {
  buildRuntimeBearerHeaders,
  createRuntimeContractServer,
  createRuntimeToolGatewayClient,
  type RuntimeEventWebSocket
} from "@burble/runtime-sdk";

type TestRunRequest = {
  runId: string;
  input: {
    text: string;
  };
};

type TestRunEvent =
  | { type: "status"; text: string }
  | { type: "message_delta"; text: string }
  | { type: "final"; response: { text: string } }
  | { type: "error"; message: string };

type TestRunResponse = {
  response: {
    text: string;
  };
};

class FakeRuntimeWebSocket implements RuntimeEventWebSocket {
  readonly messages: string[] = [];
  closeCode: number | undefined;
  closeReason: string | undefined;

  send(message: string): void {
    this.messages.push(message);
  }

  close(code?: number, reason?: string): void {
    this.closeCode = code;
    this.closeReason = reason;
  }
}

const server = createRuntimeContractServer<
  { suffix: string },
  TestRunRequest,
  TestRunEvent,
  TestRunResponse
>({
  getCapabilityManifest: (context) => ({
    runtimeType: `test-${context.suffix}`,
    version: "1",
    transports: ["http", "sse", "ndjson", "websocket"],
    streaming: true,
    cancellation: false,
    nativeScheduler: false,
    scheduledProviderCalls: true,
    toolCalls: true,
    toolBridgeModes: ["tool_gateway"],
    usageReporting: "exact",
    multimodalInput: false,
    multimodalOutput: false,
    memory: false,
    durableWorkflowState: false,
    attachments: false,
    conversationSend: true,
    jobScopedAuth: true
  }),
  normalizeRunRequest(raw, runId) {
    if (
      typeof raw !== "object" ||
      raw === null ||
      Array.isArray(raw) ||
      typeof (raw as { input?: { text?: unknown } }).input?.text !== "string"
    ) {
      return null;
    }
    return {
      runId,
      input: {
        text: (raw as { input: { text: string } }).input.text
      }
    };
  },
  async *streamRun(request, context) {
    yield { type: "status", text: "working" };
    yield { type: "message_delta", text: request.input.text };
    yield {
      type: "final",
      response: {
        text: `${request.input.text} ${context.suffix}`
      }
    };
  },
  responseFromEvent(event) {
    return event.type === "final" ? { response: event.response } : null;
  }
});

describe("runtime SDK contract server", () => {
  test("serves health and capability endpoints", async () => {
    const health = await server.handleRequest(
      new Request("http://runtime/healthz"),
      { suffix: "runtime" }
    );
    const capabilities = await server.handleRequest(
      new Request("http://runtime/capabilities"),
      { suffix: "runtime" }
    );

    expect(health?.status).toBe(200);
    expect(await health?.text()).toBe("ok");
    expect(capabilities?.status).toBe(200);
    expect(await capabilities?.json()).toMatchObject({
      runtimeType: "test-runtime",
      toolBridgeModes: ["tool_gateway"]
    });
  });

  test("runs synchronously and returns the final response", async () => {
    const response = await server.handleRequest(
      new Request("http://runtime/runs", {
        method: "POST",
        body: JSON.stringify({ input: { text: "hello" } })
      }),
      { suffix: "world" }
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      response: {
        text: "hello world"
      }
    });
  });

  test("shares async run events through WebSocket subscribers", async () => {
    const started = await server.handleRequest(
      new Request("http://runtime/runs", {
        method: "POST",
        headers: {
          prefer: "respond-async"
        },
        body: JSON.stringify({ runId: "run-123", input: { text: "hello" } })
      }),
      { suffix: "world" }
    );
    const startPayload = (await started?.json()) as { runId: string };
    const socket = new FakeRuntimeWebSocket();

    server.attachEventWebSocket(startPayload.runId, socket);
    await waitFor(() => socket.closeCode !== undefined);

    expect(socket.closeCode).toBe(1000);
    expect(socket.messages.map((message) => JSON.parse(message))).toEqual([
      { type: "status", text: "working" },
      { type: "message_delta", text: "hello" },
      { type: "final", response: { text: "hello world" } }
    ]);
  });

  test("streams run events as SSE and NDJSON", async () => {
    const sse = await server.handleRequest(
      new Request("http://runtime/runs", {
        method: "POST",
        headers: {
          accept: "text/event-stream"
        },
        body: JSON.stringify({ runId: "run-sse", input: { text: "hello" } })
      }),
      { suffix: "world" }
    );
    const ndjson = await server.handleRequest(
      new Request("http://runtime/runs", {
        method: "POST",
        headers: {
          accept: "application/x-ndjson"
        },
        body: JSON.stringify({ runId: "run-ndjson", input: { text: "hi" } })
      }),
      { suffix: "there" }
    );

    expect(sse?.headers.get("content-type")).toStartWith("text/event-stream");
    expect(await sse?.text()).toContain("event: final");
    expect(ndjson?.headers.get("content-type")).toStartWith(
      "application/x-ndjson"
    );
    const ndjsonText = await ndjson?.text();
    expect(
      (ndjsonText ?? "")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    ).toContainEqual({
      type: "final",
      response: { text: "hi there" }
    });
  });
});

describe("runtime SDK tool gateway client", () => {
  test("builds bearer headers without dropping caller headers", () => {
    expect(
      Object.fromEntries(
        buildRuntimeBearerHeaders("runtime-token", {
          accept: "application/json"
        }).entries()
      )
    ).toEqual({
      accept: "application/json",
      authorization: "Bearer runtime-token"
    });
  });

  test("builds runtime-scoped bearer headers", () => {
    expect(
      Object.fromEntries(
        buildRuntimeBearerHeaders(
          "runtime-token",
          {
            accept: "application/json"
          },
          "rt_u123"
        ).entries()
      )
    ).toEqual({
      accept: "application/json",
      authorization: "Bearer runtime-token",
      "x-burble-runtime-id": "rt_u123"
    });
  });

  test("executes tools through the Burble internal tool gateway", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = createRuntimeToolGatewayClient({
      baseUrl: "http://burble-app:3000/internal/tools/",
      runtimeToken: "runtime-token",
      runtimeId: "rt_u123",
      fetch: async (url, init) => {
        calls.push({ url, init });
        return Response.json({
          classification: "user_private",
          content: { ok: true }
        });
      }
    });

    await expect(
      client.execute("github.searchIssues", { input: { query: "repo:burble" } })
    ).resolves.toEqual({
      classification: "user_private",
      content: { ok: true }
    });
    expect(calls[0].url).toBe(
      "http://burble-app:3000/internal/tools/github.searchIssues/execute"
    );
    expect(calls[0].init?.headers).toMatchObject({
      authorization: "Bearer runtime-token",
      "content-type": "application/json",
      "x-burble-runtime-id": "rt_u123"
    });
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      input: { query: "repo:burble" }
    });
  });

  test("retries transient Burble internal tool gateway failures", async () => {
    const statuses = [503, 200];
    const client = createRuntimeToolGatewayClient({
      baseUrl: "http://burble-app:3000/internal/tools/",
      runtimeToken: "runtime-token",
      runtimeId: "rt_u123",
      retryBaseDelayMs: 0,
      fetch: async () => {
        const status = statuses.shift() ?? 200;
        return status === 200
          ? Response.json({ classification: "user_private", content: { ok: true } })
          : new Response("temporarily unavailable", { status });
      }
    });

    await expect(client.execute("github.searchIssues", {})).resolves.toEqual({
      classification: "user_private",
      content: { ok: true }
    });
    expect(statuses).toEqual([]);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not met");
}
