import { describe, expect, test } from "bun:test";
import type { AgentRunEvent, AgentRunner } from "../../src/agent/types";
import { createTokenStore } from "../../src/db";
import { createSchedulerRunExecutor } from "../../src/scheduler/run-executor";

type ContractScenario = {
  name: string;
  events: AgentRunEvent[];
  expectedStatus: "succeeded" | "failed";
  expectedFailure?: string;
  expectedDeliveries: number;
};

const readCall: AgentRunEvent = {
  type: "tool_call",
  toolName: "google.getDriveFile",
  callId: "read-state",
};
const readSuccess: AgentRunEvent = {
  type: "tool_result",
  toolName: "google.getDriveFile",
  callId: "read-state",
  classification: "user_private",
  status: "ok",
};
const writeCall: AgentRunEvent = {
  type: "tool_call",
  toolName: "google.appendDriveTextFile",
  callId: "write-state",
};
const writeSuccess: AgentRunEvent = {
  type: "tool_result",
  toolName: "google.appendDriveTextFile",
  callId: "write-state",
  classification: "user_private",
  status: "ok",
};
const writeFailure: AgentRunEvent = {
  ...writeSuccess,
  status: "error",
};

const scenarios: ContractScenario[] = [
  {
    name: "delivers after required reads and writes succeed",
    events: [readCall, readSuccess, writeCall, writeSuccess],
    expectedStatus: "succeeded",
    expectedDeliveries: 1,
  },
  {
    name: "blocks delivery when a required read is skipped",
    events: [writeCall, writeSuccess],
    expectedStatus: "failed",
    expectedFailure:
      "Scheduled run did not complete required tool google_get_drive_file.",
    expectedDeliveries: 0,
  },
  {
    name: "blocks delivery when a state write fails",
    events: [readCall, readSuccess, writeCall, writeFailure],
    expectedStatus: "failed",
    expectedFailure:
      "Scheduled run tool google_append_to_drive_text_file failed before delivery.",
    expectedDeliveries: 0,
  },
];

describe("scheduled execution contract matrix", () => {
  for (const scenario of scenarios) {
    test(scenario.name, async () => {
      const store = createTokenStore(":memory:");
      const route = store.upsertConversationRoute({
        workspaceId: "T123",
        slackUserId: "U123",
        transport: "slack",
        destination: {
          channelId: "C123",
          isDirectMessage: false,
          rootId: "channel:C123",
        },
      });
      const job = store.upsertScheduledJob({
        jobId: "job-stateful-report",
        workspaceId: "T123",
        slackUserId: "U123",
        title: "Stateful report",
        prompt: "Read durable state, collect results, update state, and report.",
        schedule: { kind: "interval", every: { hours: 1 } },
        routeId: route.id,
        runtimeType: "burble-native",
        state: "scheduled",
      });
      store.upsertAgentJobCapability({
        jobId: job.jobId,
        workspaceId: job.workspaceId,
        slackUserId: job.slackUserId,
        expectedTools: [
          "google_get_drive_file",
          "google_append_to_drive_text_file",
        ],
        requiredTools: [
          "google_get_drive_file",
          "google_append_to_drive_text_file",
        ],
        stateRefs: [
          {
            provider: "google",
            kind: "document",
            id: "state-123",
          },
        ],
      });
      const run = store.createAgentJobRun({
        runId: "run-stateful-report",
        jobId: job.jobId,
        workspaceId: job.workspaceId,
        slackUserId: job.slackUserId,
        triggerSource: "manual",
        status: "queued",
      });
      const runner: AgentRunner = {
        name: "contract-matrix-runner",
        capabilities: { streaming: true, toolEvents: true, remote: true },
        async *run() {
          for (const event of scenario.events) {
            yield event;
          }
          yield {
            type: "final",
            response: {
              classification: "user_private",
              text: "Net-new results.",
            },
          };
        },
      };
      const deliveries: unknown[] = [];
      const executor = createSchedulerRunExecutor({
        store,
        agentRunner: runner,
        slackClient: {
          chat: {
            postMessage: async (message) => {
              deliveries.push(message);
              return {};
            },
          },
        },
      });

      await executor.executeRun(run.runId);

      const finished = store.getAgentJobRun(run.runId);
      expect(finished?.status).toBe(scenario.expectedStatus);
      expect(finished?.failureReason ?? undefined).toBe(
        scenario.expectedFailure,
      );
      expect(
        deliveries.filter(
          (delivery) =>
            (delivery as { text?: string }).text === "Net-new results.",
        ),
      ).toHaveLength(scenario.expectedDeliveries);

      store.close();
    });
  }
});
