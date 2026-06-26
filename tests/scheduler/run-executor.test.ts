import { describe, expect, test } from "bun:test";
import { parseRuntimeRunRequest } from "@burble/runtime-sdk/runtime-contract";
import type { ScheduledJobContext } from "../../src/agent/scheduled-job-context";
import { createTokenStore } from "../../src/db";
import { createSchedulerRunExecutor } from "../../src/scheduler/run-executor";
import type { AgentRunner } from "../../src/agent/types";

describe("scheduler run executor", () => {
  test("claims a queued run, executes the job prompt, delivers to the route, and marks success", async () => {
    const store = createTokenStore(":memory:");
    const route = store.upsertConversationRoute({
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destination: {
        channelId: "D123",
        isDirectMessage: true,
        rootId: "dm:D123",
      },
      now: new Date("2026-06-25T17:00:00.000Z"),
    });
    const job = store.upsertScheduledJob({
      jobId: "job-ai-news",
      workspaceId: "T123",
      slackUserId: "U123",
      title: "Hourly AI news summary",
      prompt: "Find fresh AI news and summarize it.",
      schedule: { kind: "interval", every: { hours: 1 } },
      routeId: route.id,
      runtimeType: "openclaw",
      state: "scheduled",
      now: new Date("2026-06-25T17:01:00.000Z"),
    });
    const run = store.createAgentJobRun({
      runId: "jobrun-ai-news",
      jobId: job.jobId,
      workspaceId: "T123",
      slackUserId: "U123",
      triggerSource: "manual",
      status: "queued",
      now: new Date("2026-06-25T17:02:00.000Z"),
    });
    const runnerInputs: unknown[] = [];
    const runner: AgentRunner = {
      name: "test-runner",
      capabilities: {
        streaming: true,
        toolEvents: true,
        remote: true,
      },
      async *run(input) {
        runnerInputs.push(input);
        yield {
          type: "final",
          response: {
            classification: "public",
            text: "AI news summary result.",
          },
        };
      },
    };
    const posts: Array<{ channel: string; text: string; thread_ts?: string }> =
      [];
    const executor = createSchedulerRunExecutor({
      store,
      agentRunner: runner,
      slackClient: {
        chat: {
          postMessage: async (message) => {
            posts.push(message);
            return {};
          },
        },
      },
    });

    await executor.executeRun(run.runId);

    expect(runnerInputs).toHaveLength(1);
    assertRuntimeContractScheduledJob(
      (runnerInputs[0] as { scheduledJob?: ScheduledJobContext }).scheduledJob,
      "openclaw",
    );
    expect(runnerInputs[0]).toMatchObject({
      principal: { workspaceId: "T123", slackUserId: "U123" },
      text: "Find fresh AI news and summarize it.",
      scheduledJob: {
        jobId: "job-ai-news",
        allowedTools: ["web_search"],
        routeId: route.id,
        runtimeType: "openclaw",
      },
      conversation: {
        routeId: route.id,
        channelId: "D123",
        rootId: "dm:D123",
        isDirectMessage: true,
      },
    });
    expect(posts).toEqual([
      {
        channel: "D123",
        text: "AI news summary result.",
      },
    ]);
    expect(store.getAgentJobRun(run.runId)).toMatchObject({
      runId: run.runId,
      status: "succeeded",
    });

    store.close();
  });

  test("uses registered scheduled job capability tools when present", async () => {
    const store = createTokenStore(":memory:");
    const route = store.upsertConversationRoute({
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destination: {
        channelId: "D123",
        isDirectMessage: true,
        rootId: "dm:D123",
      },
      now: new Date("2026-06-25T17:00:00.000Z"),
    });
    const job = store.upsertScheduledJob({
      jobId: "job-drive-summary",
      workspaceId: "T123",
      slackUserId: "U123",
      title: "Drive summary",
      prompt: "Summarize my latest Drive file.",
      schedule: { kind: "interval", every: { hours: 1 } },
      routeId: route.id,
      runtimeType: "hermes",
      state: "scheduled",
      now: new Date("2026-06-25T17:01:00.000Z"),
    });
    store.upsertAgentJobCapability({
      jobId: job.jobId,
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["google_get_drive_file", "google_search_drive_files"],
      routeId: route.id,
      runtimeType: "hermes",
      now: new Date("2026-06-25T17:01:30.000Z"),
    });
    const run = store.createAgentJobRun({
      runId: "jobrun-drive-summary",
      jobId: job.jobId,
      workspaceId: "T123",
      slackUserId: "U123",
      triggerSource: "manual",
      status: "queued",
      now: new Date("2026-06-25T17:02:00.000Z"),
    });
    const runnerInputs: unknown[] = [];
    const runner: AgentRunner = {
      name: "test-runner",
      capabilities: {
        streaming: true,
        toolEvents: true,
        remote: true,
      },
      async *run(input) {
        runnerInputs.push(input);
        yield {
          type: "final",
          response: {
            classification: "public",
            text: "Drive summary result.",
          },
        };
      },
    };
    const executor = createSchedulerRunExecutor({
      store,
      agentRunner: runner,
      slackClient: {
        chat: {
          postMessage: async () => ({}),
        },
      },
    });

    await executor.executeRun(run.runId);

    expect(runnerInputs[0]).toMatchObject({
      scheduledJob: {
        jobId: "job-drive-summary",
        allowedTools: ["google_get_drive_file", "google_search_drive_files"],
        routeId: route.id,
        runtimeType: "hermes",
      },
    });
    assertRuntimeContractScheduledJob(
      (runnerInputs[0] as { scheduledJob?: ScheduledJobContext }).scheduledJob,
      "hermes",
    );
    expect(store.getAgentJobRun(run.runId)).toMatchObject({
      status: "succeeded",
    });

    store.close();
  });

  test("posts a terminal failure message when the runtime run fails", async () => {
    const store = createTokenStore(":memory:");
    const route = store.upsertConversationRoute({
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destination: {
        channelId: "C123",
        isDirectMessage: false,
        rootId: "slack:C123:1710000000.000000",
        threadTs: "1710000000.000000",
      },
      now: new Date("2026-06-25T17:00:00.000Z"),
    });
    const job = store.upsertScheduledJob({
      jobId: "job-ai-news",
      workspaceId: "T123",
      slackUserId: "U123",
      title: "Hourly AI news summary",
      prompt: "Find fresh AI news and summarize it.",
      schedule: { kind: "interval", every: { hours: 1 } },
      routeId: route.id,
      runtimeType: "openclaw",
      state: "scheduled",
      now: new Date("2026-06-25T17:01:00.000Z"),
    });
    const run = store.createAgentJobRun({
      runId: "jobrun-ai-news",
      jobId: job.jobId,
      workspaceId: "T123",
      slackUserId: "U123",
      triggerSource: "manual",
      status: "queued",
      now: new Date("2026-06-25T17:02:00.000Z"),
    });
    const runner: AgentRunner = {
      name: "test-runner",
      capabilities: {
        streaming: true,
        toolEvents: true,
        remote: true,
      },
      async *run() {
        throw new Error(
          "Runtime run failed: Tool github_list_my_pull_requests is not available to scheduled job job-ai-news",
        );
      },
    };
    const posts: Array<{ channel: string; text: string; thread_ts?: string }> =
      [];
    const warnings: string[] = [];
    const executor = createSchedulerRunExecutor({
      store,
      agentRunner: runner,
      slackClient: {
        chat: {
          postMessage: async (message) => {
            posts.push(message);
            return {};
          },
        },
      },
      logWarn: (message) => warnings.push(message),
    });

    await executor.executeRun(run.runId);

    expect(store.getAgentJobRun(run.runId)).toMatchObject({
      status: "failed",
      failureReason:
        "Runtime run failed: Tool github_list_my_pull_requests is not available to scheduled job job-ai-news",
    });
    expect(posts).toEqual([
      {
        channel: "C123",
        thread_ts: "1710000000.000000",
        text: [
          "Scheduled job failed: Hourly AI news summary",
          "Job ID: job-ai-news",
          "Run ID: jobrun-ai-news",
          "Reason: Runtime run failed: Tool github_list_my_pull_requests is not available to scheduled job job-ai-news",
        ].join("\n"),
      },
    ]);
    expect(warnings[0]).toContain(
      "Scheduled job run failed runId=jobrun-ai-news",
    );

    store.close();
  });
});

function assertRuntimeContractScheduledJob(
  scheduledJob: ScheduledJobContext | undefined,
  engine: "openclaw" | "hermes",
): void {
  expect(scheduledJob).toBeDefined();
  const request = parseRuntimeRunRequest({
    principal: { workspaceId: "T123", slackUserId: "U123" },
    runtime: {
      id: `rt_${engine}`,
      engine,
      status: "ready",
    },
    input: {
      text: "scheduled job contract check",
      scheduledJob,
      connections: {},
    },
  });
  expect(request.input.scheduledJob).toEqual(scheduledJob);
}
