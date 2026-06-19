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
          authorization: "Bearer runtime-token",
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
      assertClaimedCapabilities: false,
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

  test("asserts claimed tool-call and scheduled-provider capabilities", async () => {
    const store = createTokenStore(":memory:");
    const runtimeFactory = createStaticRuntimeFactory({
      store,
      engine: "hermes",
      endpointUrl: "http://runtime.local",
      authToken: "runtime-token",
      dataRoot: "/tmp/runtime-conformance-test"
    });
    const runRequests: Array<{
      runId?: string;
      text?: string;
      scheduled?: boolean;
      attachments?: boolean;
    }> = [];
    const manifestToolsByRunId = new Map<
      string,
      Array<{ name: string; alias: string; enabled: boolean }>
    >();
    const runtimeFetch: RuntimeContractFetch = async (url, init) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/healthz") {
        return new Response("ok");
      }
      if (parsed.pathname === "/capabilities") {
        return Response.json({ ...capabilityManifest(), attachments: true });
      }
      if (parsed.pathname === "/runs") {
        const request = JSON.parse(String(init?.body ?? "{}")) as {
          runId?: string;
          input?: {
            text?: string;
            scheduledJob?: unknown;
            attachments?: unknown[];
          };
          runtime?: {
            manifest?: {
              tools?: Array<{ name: string; alias: string; enabled: boolean }>;
            };
          };
        };
        if (request.runId) {
          manifestToolsByRunId.set(
            request.runId,
            request.runtime?.manifest?.tools ?? []
          );
        }
        runRequests.push({
          runId: request.runId,
          text: request.input?.text,
          scheduled: Boolean(request.input?.scheduledJob),
          attachments: Boolean(request.input?.attachments?.length)
        });
        return Response.json({ runId: request.runId });
      }
      return new Response("not found", { status: 404 });
    };

    const report = await runRuntimeConformanceCheck({
      engine: "hermes",
      principal: { workspaceId: "T123", slackUserId: "U123" },
      runtimeFactory,
      fetch: runtimeFetch,
      webSocketFactory: (url) => {
        if (url.includes("tool-capability")) {
          return new FakeRuntimeWebSocket([
            {
              type: "tool_call",
              toolName: "runtime.conformance.echo",
              callId: "tool-probe-1",
              input: { text: "tool capability probe" }
            },
            {
              type: "tool_result",
              toolName: "runtime.conformance.echo",
              callId: "tool-probe-1",
              classification: "user_private",
              content: { ok: true }
            },
            finalEvent()
          ]);
        }
        if (url.includes("tool-reachability")) {
          const runId = url.match(/\/runs\/([^/]+)\//)?.[1] ?? "";
          const tools = manifestToolsByRunId.get(runId) ?? [];
          return new FakeRuntimeWebSocket([
            ...tools
              .filter((tool) => tool.enabled)
              .flatMap((tool, index) => {
                const callId = `reachability-${index}`;
                return [
                  {
                    type: "tool_call",
                    toolName: tool.alias,
                    callId,
                    input: {}
                  },
                  {
                    type: "tool_result",
                    toolName: tool.alias,
                    callId,
                    classification: "user_private",
                    content: { ok: true }
                  }
                ];
              }),
            finalEvent()
          ]);
        }
        if (url.includes("scheduled-provider")) {
          return new FakeRuntimeWebSocket([
            {
              type: "tool_call",
              toolName: "scheduledJob.registerCapability",
              callId: "scheduled-probe-1",
              input: {
                jobId: "contract-scheduled-job",
                requiredTools: ["runtime.conformance.echo"]
              }
            },
            {
              type: "tool_result",
              toolName: "scheduledJob.registerCapability",
              callId: "scheduled-probe-1",
              classification: "user_private",
              content: { ok: true }
            },
            {
              type: "tool_call",
              toolName: "burble_provider_call",
              callId: "scheduled-provider-bridge-probe",
              input: {
                toolName: "runtime.conformance.echo",
                input: {
                  jobId: "contract-scheduled-job",
                  message: "scheduled provider bridge probe"
                }
              }
            },
            {
              type: "tool_result",
              toolName: "burble_provider_call",
              callId: "scheduled-provider-bridge-probe",
              classification: "user_private",
              content: {
                ok: true,
                toolName: "runtime.conformance.echo",
                input: {
                  jobId: "contract-scheduled-job",
                  message: "scheduled provider bridge probe"
                }
              }
            },
            finalEvent("Runtime contract scheduled provider capability response.")
          ]);
        }
        if (url.includes("attachment-capability")) {
          return new FakeRuntimeWebSocket([
            {
              type: "tool_call",
              toolName: "conversation.getAttachment",
              callId: "attachment-probe-1",
              input: { attachmentId: "attcap_contract_probe" }
            },
            {
              type: "tool_result",
              toolName: "conversation.getAttachment",
              callId: "attachment-probe-1",
              classification: "user_private",
              content: { text: "contract attachment content" }
            },
            finalEvent()
          ]);
        }
        return new FakeRuntimeWebSocket([
          { type: "status", text: "accepted" },
          finalEvent()
        ]);
      }
    });

    expect(report.checks.map((check) => check.name)).toEqual([
      "manifest",
      "health",
      "run_accepted",
      "events_stream",
      "final_response",
      "usage",
      "tool_calls",
      "tool_reachability",
      "scheduled_provider_calls",
      "attachments"
    ]);
    expect(runRequests).toHaveLength(5);
    expect(runRequests[0].runId).toContain("contract-rt_");
    expect(runRequests[1].runId).toContain("tool-capability");
    expect(runRequests[2].runId).toContain("tool-reachability");
    expect(runRequests[3].runId).toContain("scheduled-provider");
    expect(runRequests[1]).toMatchObject({
      text: "runtime contract tool capability probe",
      scheduled: false
    });
    expect(runRequests[2]).toMatchObject({
      text: "runtime contract tool reachability probe",
      scheduled: false
    });
    expect(runRequests[3]).toMatchObject({
      text: "runtime contract scheduled provider capability probe",
      scheduled: true
    });
    expect(runRequests[4]).toMatchObject({
      text: "runtime contract attachment capability probe",
      attachments: true
    });

    store.close();
  });

  test("skips capability assertions when the manifest does not claim them", async () => {
    const store = createTokenStore(":memory:");
    const runtimeFactory = createStaticRuntimeFactory({
      store,
      engine: "burble-native",
      endpointUrl: "http://runtime.local",
      authToken: "runtime-token",
      dataRoot: "/tmp/runtime-conformance-test"
    });
    let runs = 0;
    const runtimeFetch: RuntimeContractFetch = async (url, init) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/healthz") {
        return new Response("ok");
      }
      if (parsed.pathname === "/capabilities") {
        return Response.json({
          ...capabilityManifest(),
          runtimeType: "burble-native",
          toolCalls: false,
          scheduledProviderCalls: false
        });
      }
      if (parsed.pathname === "/runs") {
        runs += 1;
        const request = JSON.parse(String(init?.body ?? "{}")) as {
          runId?: string;
        };
        return Response.json({ runId: request.runId });
      }
      return new Response("not found", { status: 404 });
    };

    const report = await runRuntimeConformanceCheck({
      engine: "burble-native",
      principal: { workspaceId: "T123", slackUserId: "U123" },
      runtimeFactory,
      fetch: runtimeFetch,
      webSocketFactory: () =>
        new FakeRuntimeWebSocket([
          { type: "status", text: "accepted" },
          finalEvent()
        ])
    });

    expect(report.checks.map((check) => check.name)).toEqual([
      "manifest",
      "health",
      "run_accepted",
      "events_stream",
      "final_response",
      "usage"
    ]);
    expect(runs).toBe(1);

    store.close();
  });
});

function capabilityManifest() {
  return {
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
  };
}

function finalEvent(text = "ok") {
  return {
    type: "final",
    response: {
      classification: "user_private",
      text,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2
      }
    }
  };
}
