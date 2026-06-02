import { describe, expect, test } from "bun:test";
import {
  runRuntimeContractSmokeTest,
  type RuntimeContractClient
} from "../../src/agent/runtime-contract-harness";
import type {
  RuntimeCapabilityManifest,
  RuntimeRunEvent,
  RuntimeRunRequest
} from "../../src/agent/runtime-contract";

const manifest: RuntimeCapabilityManifest = {
  runtimeType: "hermes",
  version: "2026.6.1",
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
  durableWorkflowState: false,
  attachments: true,
  conversationSend: true,
  jobScopedAuth: true
};

const request: RuntimeRunRequest = {
  runId: "run-contract-1",
  principal: {
    workspaceId: "T123",
    slackUserId: "U123"
  },
  runtime: {
    id: "rt_contract",
    engine: "hermes"
  },
  input: {
    text: "hello agent",
    conversation: {
      source: "slack",
      workspaceId: "T123",
      channelId: "D123",
      rootId: "1780000000.000001",
      isDirectMessage: true
    },
    connections: {
      github: { connected: false }
    }
  }
};

describe("runtime contract harness", () => {
  test("passes a runtime that accepts a run and emits a final response", async () => {
    const client = fakeClient([
      { type: "status", text: "Working..." },
      {
        type: "usage",
        usage: {
          inputTokens: 4,
          outputTokens: 2,
          totalTokens: 6,
          usageSource: "provider-output"
        }
      },
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
    ]);

    await expect(
      runRuntimeContractSmokeTest({ client, request })
    ).resolves.toEqual({
      runtimeType: "hermes",
      runId: "run-contract-1",
      checks: [
        { name: "manifest", status: "ok" },
        { name: "health", status: "ok" },
        { name: "run_accepted", status: "ok" },
        { name: "events_stream", status: "ok" },
        { name: "final_response", status: "ok" },
        { name: "usage", status: "ok" }
      ]
    });
  });

  test("fails when exact-usage runtime omits usage", async () => {
    const client = fakeClient([
      {
        type: "final",
        response: {
          classification: "user_private",
          text: "Hello."
        }
      }
    ]);

    await expect(
      runRuntimeContractSmokeTest({ client, request })
    ).rejects.toThrow("Runtime contract check failed: usage");
  });

  test("fails when runtime never emits a final response", async () => {
    const client = fakeClient([{ type: "status", text: "Still working..." }]);

    await expect(
      runRuntimeContractSmokeTest({ client, request })
    ).rejects.toThrow("Runtime contract check failed: final_response");
  });
});

function fakeClient(events: RuntimeRunEvent[]): RuntimeContractClient {
  return {
    async getCapabilityManifest() {
      return manifest;
    },
    async health() {
      return { ok: true };
    },
    async startRun() {
      return { runId: "run-contract-1" };
    },
    async *streamRunEvents() {
      for (const event of events) {
        yield event;
      }
    }
  };
}
