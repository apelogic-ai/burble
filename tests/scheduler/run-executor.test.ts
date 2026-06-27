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
        rootId: "scheduled:job-ai-news:jobrun-ai-news",
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
      conversation: {
        routeId: route.id,
        channelId: "D123",
        rootId: "scheduled:job-drive-summary:jobrun-drive-summary",
        isDirectMessage: true,
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

  test("executes literal message scheduled jobs through the runtime without a delivery-tool grant", async () => {
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
      jobId: "job-heart",
      workspaceId: "T123",
      slackUserId: "U123",
      title: "Heart emoji every 30 min",
      prompt: "Post exactly this message: ❤️",
      schedule: { kind: "cron", expression: "*/30 * * * *", timezone: "UTC" },
      routeId: route.id,
      runtimeType: "hermes",
      state: "scheduled",
      now: new Date("2026-06-25T17:01:00.000Z"),
    });
    store.upsertAgentJobCapability({
      jobId: job.jobId,
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["conversation.sendMessage"],
      routeId: route.id,
      runtimeType: "hermes",
      now: new Date("2026-06-25T17:01:30.000Z"),
    });
    const run = store.createAgentJobRun({
      runId: "jobrun-heart",
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
            text: "❤️",
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
    expect(runnerInputs[0]).toMatchObject({
      text: "Return exactly this message as your entire final answer, with no extra text. Do not call tools for delivery; Burble will deliver your final answer.\n\n❤️",
      conversation: {
        routeId: route.id,
        channelId: "C123",
        rootId: "scheduled:job-heart:jobrun-heart",
        isDirectMessage: false,
      },
    });
    expect(
      (runnerInputs[0] as { scheduledJob?: ScheduledJobContext }).scheduledJob,
    ).toBeUndefined();
    expect(posts).toEqual([
      {
        channel: "C123",
        thread_ts: "1710000000.000000",
        text: "❤️",
      },
    ]);
    expect(store.getAgentJobRun(run.runId)).toMatchObject({
      runId: run.runId,
      status: "succeeded",
    });

    store.close();
  });

  test("does not deliver runtime-control notices as scheduled job output", async () => {
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
      jobId: "job-pr-monitor",
      workspaceId: "T123",
      slackUserId: "U123",
      title: "Open PR monitor",
      prompt: "Look for new open PRs.",
      schedule: { kind: "interval", every: { minutes: 15 } },
      routeId: route.id,
      runtimeType: "hermes",
      state: "scheduled",
      now: new Date("2026-06-25T17:01:00.000Z"),
    });
    const run = store.createAgentJobRun({
      runId: "jobrun-pr-monitor",
      jobId: job.jobId,
      workspaceId: "T123",
      slackUserId: "U123",
      triggerSource: "schedule",
      status: "queued",
      now: new Date("2026-06-25T17:02:00.000Z"),
    });
    const posts: Array<{ channel: string; text: string; thread_ts?: string }> =
      [];
    const warnings: string[] = [];
    const runner: AgentRunner = {
      name: "test-runner",
      capabilities: {
        streaming: true,
        toolEvents: true,
        remote: true,
      },
      async *run() {
        yield {
          type: "final",
          response: {
            classification: "user_private",
            text: [
              ":zap: Interrupting current task (iteration 1/90, running: github_list_my_pull_requests). I'll respond to your message shortly.",
              "",
              ":bulb: First-time tip — I just interrupted my current task to answer you. Send /busy queue to queue follow-ups for after the current task instead.",
            ].join("\n"),
          },
        };
      },
    };
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

    expect(posts).toEqual([
      {
        channel: "D123",
        text: [
          "Scheduled job failed: Open PR monitor",
          "Job ID: job-pr-monitor",
          "Run ID: jobrun-pr-monitor",
          "Reason: Managed runtime final response contained only runtime-control/progress text after scheduled task retry",
        ].join("\n"),
      },
    ]);
    expect(warnings).toEqual([
      "Scheduled job runtime returned progress-only output before tool call; retrying run jobId=job-pr-monitor",
      "Scheduled job run failed runId=jobrun-pr-monitor error=Managed runtime final response contained only runtime-control/progress text after scheduled task retry",
    ]);
    expect(store.getAgentJobRun(run.runId)).toMatchObject({
      runId: run.runId,
      status: "failed",
      failureReason:
        "Managed runtime final response contained only runtime-control/progress text after scheduled task retry",
    });

    store.close();
  });

  test("retries progress-only scheduled provider runs before any tool call", async () => {
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
      jobId: "job-pr-monitor",
      workspaceId: "T123",
      slackUserId: "U123",
      title: "Check every 15 min for new PRs in apelogic-ai GitHub org",
      prompt:
        "check every 15 min for new PRs in repos of https://github.com/apelogic-ai github org, post in this channel",
      schedule: { kind: "interval", every: { minutes: 15 } },
      routeId: route.id,
      runtimeType: "hermes",
      state: "scheduled",
      now: new Date("2026-06-25T17:01:00.000Z"),
    });
    const run = store.createAgentJobRun({
      runId: "jobrun-pr-monitor",
      jobId: job.jobId,
      workspaceId: "T123",
      slackUserId: "U123",
      triggerSource: "manual",
      status: "queued",
      now: new Date("2026-06-25T17:02:00.000Z"),
    });
    const runnerInputs: string[] = [];
    const runner: AgentRunner = {
      name: "test-runner",
      capabilities: {
        streaming: true,
        toolEvents: true,
        remote: true,
      },
      async *run(input) {
        runnerInputs.push(input.text);
        if (runnerInputs.length === 1) {
          yield {
            type: "final",
            response: {
              classification: "user_private",
              text: "Calling github search issues...\n\nFinal result in 2.0s.",
            },
          };
          return;
        }
        yield {
          type: "final",
          response: {
            classification: "user_private",
            text: "No open apelogic-ai PRs found.",
          },
        };
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

    expect(runnerInputs).toHaveLength(2);
    expect(runnerInputs[1]).toContain(
      "Protocol correction for this same scheduled task.",
    );
    expect(runnerInputs[1]).toContain(
      "Allowed task tools: github_search_issues",
    );
    expect(posts).toEqual([
      {
        channel: "C123",
        text: "No open apelogic-ai PRs found.",
        thread_ts: "1710000000.000000",
      },
    ]);
    expect(warnings).toEqual([
      "Scheduled job runtime returned progress-only output before tool call; retrying run jobId=job-pr-monitor",
    ]);
    expect(store.getAgentJobRun(run.runId)).toMatchObject({
      runId: run.runId,
      status: "succeeded",
    });

    store.close();
  });

  test("does not retry progress-only scheduled provider runs after a tool call", async () => {
    const store = createTokenStore(":memory:");
    const route = store.upsertConversationRoute({
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destination: {
        channelId: "C123",
        isDirectMessage: false,
        rootId: "slack:C123:1710000000.000000",
      },
      now: new Date("2026-06-25T17:00:00.000Z"),
    });
    const job = store.upsertScheduledJob({
      jobId: "job-pr-monitor",
      workspaceId: "T123",
      slackUserId: "U123",
      title: "Check every 15 min for new PRs in apelogic-ai GitHub org",
      prompt:
        "check every 15 min for new PRs in repos of https://github.com/apelogic-ai github org, post in this channel",
      schedule: { kind: "interval", every: { minutes: 15 } },
      routeId: route.id,
      runtimeType: "hermes",
      state: "scheduled",
      now: new Date("2026-06-25T17:01:00.000Z"),
    });
    const run = store.createAgentJobRun({
      runId: "jobrun-pr-monitor",
      jobId: job.jobId,
      workspaceId: "T123",
      slackUserId: "U123",
      triggerSource: "manual",
      status: "queued",
      now: new Date("2026-06-25T17:02:00.000Z"),
    });
    let attempts = 0;
    const runner: AgentRunner = {
      name: "test-runner",
      capabilities: {
        streaming: true,
        toolEvents: true,
        remote: true,
      },
      async *run() {
        attempts += 1;
        yield {
          type: "tool_call",
          toolName: "github_search_issues",
          callId: "call-1",
        };
        yield {
          type: "final",
          response: {
            classification: "user_private",
            text: "Calling github search issues...\n\nFinal result in 2.0s.",
          },
        };
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

    expect(attempts).toBe(1);
    expect(posts).toEqual([]);
    expect(warnings).toEqual([
      "Scheduled job run suppressed runtime-control output runId=jobrun-pr-monitor jobId=job-pr-monitor",
    ]);

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
