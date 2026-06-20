import { describe, expect, test } from "bun:test";
import {
  runRuntimeContractSmokeTest,
  type RuntimeContractClient
} from "@burble/runtime-sdk/runtime-contract-harness";
import type {
  RuntimeCapabilityManifest,
  RuntimeRunEvent,
  RuntimeRunRequest
} from "@burble/runtime-sdk/runtime-contract";

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
      manifest,
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

  test("surfaces runtime error events instead of hiding them as missing finals", async () => {
    const client = fakeClient([
      { type: "status", text: "Starting..." },
      {
        type: "error",
        message: "Unsupported Burble MCP tool: runtime.conformance.echo",
        code: "unsupported_tool"
      }
    ]);

    await expect(
      runRuntimeContractSmokeTest({ client, request })
    ).rejects.toThrow(
      "Runtime contract check failed: final_response: runtime emitted error event unsupported_tool: Unsupported Burble MCP tool: runtime.conformance.echo"
    );
  });

  test("fails when final response leaks runtime tool-call protocol", async () => {
    const client = fakeClient([
      {
        type: "final",
        response: {
          classification: "user_private",
          text: `Done.\nto=burble_provider_call code\n{"toolName":"github_search_issues","input":{"jobId":"job-123"}}`,
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2
          }
        }
      }
    ]);

    await expect(
      runRuntimeContractSmokeTest({ client, request })
    ).rejects.toThrow(
      "Runtime contract check failed: final_response: runtime final response leaked tool-call protocol text"
    );
  });

  test("fails when streamed progress leaks runtime tool-call protocol", async () => {
    const client = fakeClient([
      {
        type: "message_delta",
        text: JSON.stringify({
          tool_call: {
            name: "google.getDriveFile",
            arguments: { fileId: "file-123" }
          }
        })
      },
      {
        type: "final",
        response: {
          classification: "user_private",
          text: "Done.",
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2
          }
        }
      }
    ]);

    await expect(
      runRuntimeContractSmokeTest({ client, request })
    ).rejects.toThrow(
      "Runtime contract check failed: events_stream: runtime message_delta leaked tool-call protocol text"
    );
  });

  test("fails when scheduled provider probe final claims the bridge is unavailable", async () => {
    const client = fakeClientByRunId({
      manifest: {
        ...manifest,
        toolCalls: false,
        attachments: false
      },
      eventsForRun: (runId) => {
        if (runId.includes("scheduled-provider")) {
          return [
            {
              type: "tool_call",
              toolName: "scheduledJob.registerCapability",
              callId: "scheduled-probe-1"
            },
            {
              type: "tool_result",
              toolName: "scheduledJob.registerCapability",
              callId: "scheduled-probe-1",
              classification: "user_private"
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
            {
              type: "final",
              response: {
                classification: "user_private",
                text: "Could not run this check: burble_provider_call is not exposed in this runtime.",
                usage: {
                  inputTokens: 1,
                  outputTokens: 1,
                  totalTokens: 2
                }
              }
            }
          ] satisfies RuntimeRunEvent[];
        }
        return [finalEvent()];
      }
    });

    await expect(
      runRuntimeContractSmokeTest({
        client,
        request,
        assertClaimedCapabilities: true
      })
    ).rejects.toThrow(
      "Runtime contract check failed: scheduled_provider_calls: runtime scheduled provider probe final response did not confirm scheduled provider capability"
    );
  });
});

function fakeClient(events: RuntimeRunEvent[]): RuntimeContractClient {
  return fakeClientByRunId({ eventsForRun: () => events });
}

function fakeClientByRunId(input: {
  manifest?: RuntimeCapabilityManifest;
  eventsForRun: (runId: string) => RuntimeRunEvent[];
}): RuntimeContractClient {
  let activeRunId = "run-contract-1";
  return {
    async getCapabilityManifest() {
      return input.manifest ?? manifest;
    },
    async health() {
      return { ok: true };
    },
    async startRun(request) {
      activeRunId = request.runId ?? "run-contract-1";
      return { runId: activeRunId };
    },
    async *streamRunEvents() {
      for (const event of input.eventsForRun(activeRunId)) {
        yield event;
      }
    }
  };
}

function finalEvent(): RuntimeRunEvent {
  return {
    type: "final",
    response: {
      classification: "user_private",
      text: "Hello.",
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2
      }
    }
  };
}
