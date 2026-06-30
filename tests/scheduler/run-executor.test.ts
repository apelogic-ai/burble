import { describe, expect, test } from "bun:test";
import { parseRuntimeRunRequest } from "@burble/runtime-sdk/runtime-contract";
import type { ScheduledJobContext } from "../../src/agent/scheduled-job-context";
import { createTokenStore } from "../../src/db";
import { createSchedulerRunExecutor } from "../../src/scheduler/run-executor";
import type { AgentRunner } from "../../src/agent/types";
import { createInMemoryTaskWorkflowEventStore } from "../../src/workflow/task-workflow-store";

describe("scheduler run executor", () => {
  test("claims a queued run, executes the job prompt, delivers to the route, and marks success", async () => {
    const store = createTokenStore(":memory:");
    const workflowStore = createInMemoryTaskWorkflowEventStore();
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
            usage: {
              inputTokens: 30,
              outputTokens: 12,
              totalTokens: 42,
              usageSource: "provider-output",
            },
            telemetry: {
              promptChars: 512,
            },
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
      workflowShadowStore: workflowStore,
    });

    await executor.executeRun(run.runId);

    expect(runnerInputs).toHaveLength(1);
    assertRuntimeContractScheduledJob(
      (runnerInputs[0] as { scheduledJob?: ScheduledJobContext }).scheduledJob,
      "openclaw",
    );
    expect(runnerInputs[0]).toMatchObject({
      principal: { workspaceId: "T123", slackUserId: "U123" },
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
    expect((runnerInputs[0] as { text: string }).text).toContain(
      "Return only the final user-visible result for this task.",
    );
    expect((runnerInputs[0] as { text: string }).text).toContain(
      "Task:\nFind fresh AI news and summarize it.",
    );
    expect(
      (runnerInputs[0] as { toolGroups: { groups: string[] } }).toolGroups
        .groups,
    ).not.toContain("scheduler");
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
    expect(store.getAgentJobRunAudit(run.runId)).toMatchObject({
      runId: run.runId,
      jobId: job.jobId,
      workspaceId: "T123",
      slackUserId: "U123",
      runtimeType: "openclaw",
      runnerName: "test-runner",
      executionMode: "native-runtime",
      routeId: route.id,
      outputBytes: 23,
      usage: {
        inputTokens: 30,
        outputTokens: 12,
        totalTokens: 42,
        usageSource: "provider-output",
      },
      telemetry: {
        promptChars: 512,
      },
      visibility: {
        destination: "slack",
        isDirectMessage: true,
        channelId: "D123",
      },
    });
    expect(workflowStore.replayState().runs[run.runId]).toMatchObject({
      jobRunId: run.runId,
      taskId: job.jobId,
      source: "manual",
      status: "succeeded",
      attempt: 1,
    });

    store.close();
  });

  test("keeps scheduled run audit core fields when telemetry is not JSON-serializable", async () => {
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
    });
    const run = store.createAgentJobRun({
      runId: "jobrun-ai-news",
      jobId: job.jobId,
      workspaceId: "T123",
      slackUserId: "U123",
      triggerSource: "manual",
      status: "queued",
    });
    const circularTelemetry: Record<string, unknown> = {
      promptChars: 512,
    };
    circularTelemetry.self = circularTelemetry;
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
            classification: "public",
            text: "AI news summary result.",
            usage: {
              totalTokens: 42,
            },
            telemetry: circularTelemetry,
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
      logWarn: (message) => warnings.push(message),
    });

    await executor.executeRun(run.runId);

    expect(store.getAgentJobRun(run.runId)).toMatchObject({
      status: "succeeded",
    });
    expect(store.getAgentJobRunAudit(run.runId)).toMatchObject({
      runId: run.runId,
      runtimeType: "openclaw",
      runnerName: "test-runner",
      outputBytes: 23,
      usage: {
        totalTokens: 42,
      },
      telemetry: null,
      visibility: {
        destination: "slack",
        channelId: "D123",
      },
    });
    expect(warnings).toContain(
      "Scheduled job run audit field telemetry was not JSON-serializable runId=jobrun-ai-news",
    );

    store.close();
  });

  test("uses workflow driver as authority for manual runs when enabled", async () => {
    const store = createTokenStore(":memory:");
    const workflowStore = createInMemoryTaskWorkflowEventStore();
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
      jobId: "job-heart",
      workspaceId: "T123",
      slackUserId: "U123",
      title: "Heart",
      prompt: "Post exactly this message: :heart:",
      schedule: { kind: "interval", every: { minutes: 30 } },
      routeId: route.id,
      runtimeType: "openclaw",
      state: "scheduled",
      now: new Date("2026-06-25T17:01:00.000Z"),
    });
    store.upsertAgentJobCapability({
      jobId: job.jobId,
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: [],
      routeId: route.id,
      runtimeType: "openclaw",
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
    const runner: AgentRunner = {
      name: "test-runner",
      capabilities: {
        streaming: true,
        toolEvents: true,
        remote: true,
      },
      async *run() {
        await new Promise((resolve) => setTimeout(resolve, 25));
        yield {
          type: "final",
          response: {
            classification: "public",
            text: ":heart:",
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
      workflowShadowStore: workflowStore,
      workflowAuthority: "manual",
      workflowHeartbeatIntervalMs: 1,
    });

    await executor.executeRun(run.runId);

    expect(posts).toEqual([{ channel: "D123", text: ":heart:" }]);
    expect(store.getAgentJobRun(run.runId)).toMatchObject({
      runId: run.runId,
      status: "succeeded",
    });
    expect(workflowStore.replayState().runs[run.runId]).toMatchObject({
      jobRunId: run.runId,
      taskId: job.jobId,
      source: "manual",
      status: "succeeded",
      attempt: 1,
    });
    const eventTypes = workflowStore
      .listEvents()
      .map((event) => event.event.type);
    expect(eventTypes.filter((type) => type === "run_heartbeat").length).toBeGreaterThan(
      1,
    );
    expect(eventTypes[0]).toBe("task_triggered");
    expect(eventTypes).toContain("attempt_succeeded");
    expect(eventTypes.at(-1)).toBe("delivery_succeeded");

    store.close();
  });

  test("uses workflow driver as authority for scheduled runs when timer authority is enabled", async () => {
    const store = createTokenStore(":memory:");
    const workflowStore = createInMemoryTaskWorkflowEventStore();
    const route = store.upsertConversationRoute({
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destination: { channelId: "D123", isDirectMessage: true },
    });
    const job = store.upsertScheduledJob({
      jobId: "job-heart-timer",
      workspaceId: "T123",
      slackUserId: "U123",
      title: "Heart timer",
      prompt: "Post exactly this message: :heart:",
      schedule: { kind: "interval", every: { minutes: 30 } },
      routeId: route.id,
      runtimeType: "openclaw",
      state: "scheduled",
    });
    store.upsertAgentJobCapability({
      jobId: job.jobId,
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: [],
      routeId: route.id,
      runtimeType: "openclaw",
    });
    const run = store.createAgentJobRun({
      runId: "jobrun-heart-timer",
      jobId: job.jobId,
      workspaceId: "T123",
      slackUserId: "U123",
      triggerSource: "schedule",
      status: "queued",
    });
    const runner: AgentRunner = {
      name: "test-runner",
      capabilities: { streaming: true, toolEvents: true, remote: true },
      async *run() {
        yield {
          type: "final",
          response: { classification: "public", text: ":heart:" },
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
      workflowShadowStore: workflowStore,
      workflowAuthority: "timer",
    });

    await executor.executeRun(run.runId);

    expect(posts).toEqual([{ channel: "D123", text: ":heart:" }]);
    expect(store.getAgentJobRun(run.runId)).toMatchObject({
      runId: run.runId,
      status: "succeeded",
    });
    expect(workflowStore.replayState().runs[run.runId]).toMatchObject({
      jobRunId: run.runId,
      taskId: job.jobId,
      source: "schedule",
      status: "succeeded",
      attempt: 1,
    });

    store.close();
  });

  test("manual workflow authority records validation failures in the driver", async () => {
    const store = createTokenStore(":memory:");
    const workflowStore = createInMemoryTaskWorkflowEventStore();
    const route = store.upsertConversationRoute({
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destination: { channelId: "D123", isDirectMessage: true },
    });
    const job = store.upsertScheduledJob({
      jobId: "job-prs",
      workspaceId: "T123",
      slackUserId: "U123",
      title: "Open PR monitor",
      prompt:
        "check for new open PRs in https://github.com/apelogic-ai github org",
      schedule: { kind: "interval", every: { minutes: 15 } },
      routeId: route.id,
      runtimeType: "openclaw",
      state: "scheduled",
    });
    store.upsertAgentJobCapability({
      jobId: job.jobId,
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["github_list_my_pull_requests"],
      routeId: route.id,
      runtimeType: "openclaw",
    });
    const run = store.createAgentJobRun({
      runId: "jobrun-invalid",
      jobId: job.jobId,
      workspaceId: "T123",
      slackUserId: "U123",
      triggerSource: "manual",
      status: "queued",
    });
    let runnerCalled = false;
    const runner: AgentRunner = {
      name: "test-runner",
      capabilities: { streaming: true, toolEvents: true, remote: true },
      async *run() {
        runnerCalled = true;
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
      workflowShadowStore: workflowStore,
      workflowAuthority: "manual",
    });

    await executor.executeRun(run.runId);

    expect(runnerCalled).toBe(false);
    expect(store.getAgentJobRun(run.runId)).toMatchObject({
      status: "failed",
      failureReason: expect.stringContaining(
        "missing_required_tool: Task requires github_search_issues",
      ),
    });
    expect(workflowStore.replayState().runs[run.runId]).toMatchObject({
      status: "failed",
      failureClass: "validation_failed",
    });
    expect(posts).toHaveLength(1);
    expect(posts[0]?.text).toContain("Scheduled job failed");

    store.close();
  });

  test("manual workflow authority retries read-only contract failures as workflow attempts", async () => {
    const store = createTokenStore(":memory:");
    const workflowStore = createInMemoryTaskWorkflowEventStore();
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
    });
    const job = store.upsertScheduledJob({
      jobId: "job-pr-monitor",
      workspaceId: "T123",
      slackUserId: "U123",
      title: "Open PR monitor",
      prompt:
        "check every 15 min for new PRs in repos of https://github.com/apelogic-ai github org, post in this channel",
      schedule: { kind: "interval", every: { minutes: 15 } },
      routeId: route.id,
      runtimeType: "openclaw",
      state: "scheduled",
    });
    store.upsertAgentJobCapability({
      jobId: job.jobId,
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["github_search_issues", "slack_search_messages"],
      routeId: route.id,
      runtimeType: "openclaw",
    });
    const run = store.createAgentJobRun({
      runId: "jobrun-pr-monitor",
      jobId: job.jobId,
      workspaceId: "T123",
      slackUserId: "U123",
      triggerSource: "manual",
      status: "queued",
    });
    const runnerTexts: string[] = [];
    const runner: AgentRunner = {
      name: "test-runner",
      capabilities: { streaming: true, toolEvents: true, remote: true },
      async *run(input) {
        runnerTexts.push(input.text);
        if (runnerTexts.length < 3) {
          yield {
            type: "final",
            response: {
              classification: "user_private",
              text: `:gear: github_search_issues: "org:apelogic-ai is:pr is:open"`,
            },
          };
          return;
        }
        yield {
          type: "final",
          response: {
            classification: "public",
            text: "No new PRs found.",
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
      workflowShadowStore: workflowStore,
      workflowAuthority: "manual",
      workflowMaxAttempts: 3,
    });

    await executor.executeRun(run.runId);

    expect(runnerTexts).toHaveLength(3);
    expect(posts).toEqual([
      {
        channel: "C123",
        text: "No new PRs found.",
        thread_ts: "1710000000.000000",
      },
    ]);
    expect(store.getAgentJobRun(run.runId)).toMatchObject({
      status: "succeeded",
      failureReason: null,
    });
    expect(
      workflowStore.replayState({ initialConfig: { maxAttempts: 3 } }).runs[
        run.runId
      ],
    ).toMatchObject({
      status: "succeeded",
      attempt: 3,
      failureClass: "runtime_failed",
      failureReason:
        "Managed runtime final response leaked tool-call protocol text",
    });

    store.close();
  });

  test("manual workflow authority does not retry write-capable contract failures", async () => {
    const store = createTokenStore(":memory:");
    const workflowStore = createInMemoryTaskWorkflowEventStore();
    const route = store.upsertConversationRoute({
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destination: { channelId: "C123", isDirectMessage: false },
    });
    const job = store.upsertScheduledJob({
      jobId: "job-pr-monitor",
      workspaceId: "T123",
      slackUserId: "U123",
      title: "Open PR monitor",
      prompt:
        "check every 15 min for new PRs in repos of https://github.com/apelogic-ai github org, post in this channel",
      schedule: { kind: "interval", every: { minutes: 15 } },
      routeId: route.id,
      runtimeType: "openclaw",
      state: "scheduled",
    });
    store.upsertAgentJobCapability({
      jobId: job.jobId,
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: [
        "github_search_issues",
        "slack_search_messages",
        "conversation.sendMessage",
      ],
      routeId: route.id,
      runtimeType: "openclaw",
    });
    const run = store.createAgentJobRun({
      runId: "jobrun-pr-monitor",
      jobId: job.jobId,
      workspaceId: "T123",
      slackUserId: "U123",
      triggerSource: "manual",
      status: "queued",
    });
    let runnerCalls = 0;
    const runner: AgentRunner = {
      name: "test-runner",
      capabilities: { streaming: true, toolEvents: true, remote: true },
      async *run() {
        runnerCalls += 1;
        yield {
          type: "final",
          response: {
            classification: "user_private",
            text: `:gear: github_search_issues: "org:apelogic-ai is:pr is:open"`,
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
      workflowShadowStore: workflowStore,
      workflowAuthority: "manual",
    });

    await executor.executeRun(run.runId);

    expect(runnerCalls).toBe(1);
    expect(store.getAgentJobRun(run.runId)).toMatchObject({
      status: "failed",
      failureReason:
        "Managed runtime final response leaked tool-call protocol text",
    });
    expect(workflowStore.replayState().runs[run.runId]).toMatchObject({
      status: "failed",
      attempt: 1,
      failureClass: "runtime_failed",
    });
    expect(posts).toHaveLength(1);
    expect(posts[0]?.text).toContain("Scheduled job failed");

    store.close();
  });

  test("manual workflow authority does not post failure after delivered output races terminal projection", async () => {
    const store = createTokenStore(":memory:");
    const workflowStore = createInMemoryTaskWorkflowEventStore();
    const route = store.upsertConversationRoute({
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destination: { channelId: "D123", isDirectMessage: true },
    });
    const job = store.upsertScheduledJob({
      jobId: "job-heart-race",
      workspaceId: "T123",
      slackUserId: "U123",
      title: "Heart",
      prompt: "Post exactly this message: :heart:",
      schedule: { kind: "interval", every: { minutes: 30 } },
      routeId: route.id,
      runtimeType: "openclaw",
      state: "scheduled",
    });
    store.upsertAgentJobCapability({
      jobId: job.jobId,
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: [],
      routeId: route.id,
      runtimeType: "openclaw",
    });
    const run = store.createAgentJobRun({
      runId: "jobrun-race",
      jobId: job.jobId,
      workspaceId: "T123",
      slackUserId: "U123",
      triggerSource: "manual",
      status: "queued",
    });
    const executorStore = Object.create(store) as typeof store;
    executorStore.finishAgentJobRun = (input) => {
      if (input.status === "succeeded") {
        store.finishAgentJobRun({
          runId: input.runId,
          status: "failed",
          failureReason: "lease expired",
        });
        return null;
      }
      return store.finishAgentJobRun(input);
    };
    const runner: AgentRunner = {
      name: "test-runner",
      capabilities: { streaming: true, toolEvents: true, remote: true },
      async *run() {
        yield {
          type: "final",
          response: { classification: "public", text: ":heart:" },
        };
      },
    };
    const posts: Array<{ channel: string; text: string; thread_ts?: string }> =
      [];
    const executor = createSchedulerRunExecutor({
      store: executorStore,
      agentRunner: runner,
      slackClient: {
        chat: {
          postMessage: async (message) => {
            posts.push(message);
            return {};
          },
        },
      },
      workflowShadowStore: workflowStore,
      workflowAuthority: "manual",
    });

    await executor.executeRun(run.runId);

    expect(posts).toEqual([{ channel: "D123", text: ":heart:" }]);
    expect(store.getAgentJobRun(run.runId)).toMatchObject({
      status: "failed",
      failureReason: "lease expired",
    });
    expect(workflowStore.replayState().runs[run.runId]).toMatchObject({
      status: "succeeded",
      deliveryKey: expect.stringContaining("jobrun-race"),
    });

    store.close();
  });

  test("manual workflow authority compensates terminal workflow append failure after authoritative success", async () => {
    const store = createTokenStore(":memory:");
    const workflowStore = createInMemoryTaskWorkflowEventStore();
    let failDeliverySucceeded = true;
    const flakyWorkflowStore = {
      ...workflowStore,
      appendEvent(input: Parameters<typeof workflowStore.appendEvent>[0]) {
        if (
          input.event.type === "delivery_succeeded" &&
          failDeliverySucceeded
        ) {
          failDeliverySucceeded = false;
          throw new Error("transient workflow append failure");
        }
        return workflowStore.appendEvent(input);
      },
    };
    const route = store.upsertConversationRoute({
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destination: { channelId: "D123", isDirectMessage: true },
    });
    const job = store.upsertScheduledJob({
      jobId: "job-heart-compensate",
      workspaceId: "T123",
      slackUserId: "U123",
      title: "Heart",
      prompt: "Post exactly this message: :heart:",
      schedule: { kind: "interval", every: { minutes: 30 } },
      routeId: route.id,
      runtimeType: "openclaw",
      state: "scheduled",
    });
    store.upsertAgentJobCapability({
      jobId: job.jobId,
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: [],
      routeId: route.id,
      runtimeType: "openclaw",
    });
    const run = store.createAgentJobRun({
      runId: "jobrun-compensate",
      jobId: job.jobId,
      workspaceId: "T123",
      slackUserId: "U123",
      triggerSource: "manual",
      status: "queued",
    });
    const runner: AgentRunner = {
      name: "test-runner",
      capabilities: { streaming: true, toolEvents: true, remote: true },
      async *run() {
        yield {
          type: "final",
          response: { classification: "public", text: ":heart:" },
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
      workflowShadowStore: flakyWorkflowStore,
      workflowAuthority: "manual",
    });

    await executor.executeRun(run.runId);

    expect(posts).toEqual([{ channel: "D123", text: ":heart:" }]);
    expect(store.getAgentJobRun(run.runId)).toMatchObject({
      status: "succeeded",
    });
    expect(workflowStore.replayState().runs[run.runId]).toMatchObject({
      status: "succeeded",
      deliveryKey: expect.stringContaining("jobrun-compensate"),
    });
    expect(failDeliverySucceeded).toBe(false);

    store.close();
  });

  test("manual workflow authority compensates attempt-start append failure after validation", async () => {
    const store = createTokenStore(":memory:");
    const workflowStore = createInMemoryTaskWorkflowEventStore();
    let failAttemptStarted = true;
    const flakyWorkflowStore = {
      ...workflowStore,
      appendEvent(input: Parameters<typeof workflowStore.appendEvent>[0]) {
        if (input.event.type === "attempt_started" && failAttemptStarted) {
          failAttemptStarted = false;
          throw new Error("transient attempt start append failure");
        }
        return workflowStore.appendEvent(input);
      },
    };
    const route = store.upsertConversationRoute({
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destination: { channelId: "D123", isDirectMessage: true },
    });
    const job = store.upsertScheduledJob({
      jobId: "job-attempt-compensate",
      workspaceId: "T123",
      slackUserId: "U123",
      title: "Attempt compensation",
      prompt: "Post exactly this message: :heart:",
      schedule: { kind: "interval", every: { minutes: 30 } },
      routeId: route.id,
      runtimeType: "openclaw",
      state: "scheduled",
    });
    store.upsertAgentJobCapability({
      jobId: job.jobId,
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: [],
      routeId: route.id,
      runtimeType: "openclaw",
    });
    const run = store.createAgentJobRun({
      runId: "jobrun-attempt-compensate",
      jobId: job.jobId,
      workspaceId: "T123",
      slackUserId: "U123",
      triggerSource: "manual",
      status: "queued",
    });
    let runnerCalled = false;
    const runner: AgentRunner = {
      name: "test-runner",
      capabilities: { streaming: true, toolEvents: true, remote: true },
      async *run() {
        runnerCalled = true;
        yield {
          type: "final",
          response: { classification: "public", text: ":heart:" },
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
      workflowShadowStore: flakyWorkflowStore,
      workflowAuthority: "manual",
    });

    await executor.executeRun(run.runId);

    expect(runnerCalled).toBe(false);
    expect(store.getAgentJobRun(run.runId)).toMatchObject({
      status: "failed",
      failureReason: "transient attempt start append failure",
    });
    expect(workflowStore.replayState().runs[run.runId]).toMatchObject({
      status: "failed",
      attempt: 1,
      failureClass: "runtime_failed",
    });
    expect(posts).toHaveLength(1);
    expect(posts[0]?.text).toContain("Scheduled job failed");
    expect(failAttemptStarted).toBe(false);

    store.close();
  });

  test("mirrors terminal shadow state when finish returns null after an authoritative update", async () => {
    const store = createTokenStore(":memory:");
    const workflowStore = createInMemoryTaskWorkflowEventStore();
    const route = store.upsertConversationRoute({
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destination: { channelId: "C123" },
      kind: "origin",
    });
    const job = store.upsertScheduledJob({
      jobId: "job-1",
      workspaceId: "T123",
      slackUserId: "U123",
      title: "Hourly check",
      prompt: "Check something",
      schedule: { kind: "interval", every: { hours: 1 } },
      routeId: route.id,
      state: "scheduled",
      runtimeType: "openclaw",
    });
    const run = store.createAgentJobRun({
      runId: "jobrun-1",
      jobId: job.jobId,
      workspaceId: "T123",
      slackUserId: "U123",
      triggerSource: "schedule",
      status: "queued",
    });
    const agentRunner: AgentRunner = {
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
            classification: "public",
            text: "Done.",
          },
        };
      },
    };
    const posted: unknown[] = [];
    const executorStore = Object.create(store) as typeof store;
    executorStore.finishAgentJobRun = (input) => {
      store.finishAgentJobRun(input);
      return null;
    };
    const executor = createSchedulerRunExecutor({
      store: executorStore,
      agentRunner,
      slackClient: {
        chat: {
          postMessage: async (input) => {
            posted.push(input);
          },
        },
      },
      workflowShadowStore: workflowStore,
    });

    await executor.executeRun(run.runId);

    expect(posted).toHaveLength(1);
    expect(store.getAgentJobRun(run.runId)).toMatchObject({
      status: "succeeded",
    });
    expect(workflowStore.replayState().runs[run.runId]).toMatchObject({
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
      conversation: {
        routeId: route.id,
        channelId: "C123",
        rootId: "scheduled:job-heart:jobrun-heart",
        isDirectMessage: false,
      },
    });
    expect((runnerInputs[0] as { text: string }).text).toContain(
      "The task is literal delivery. Return exactly this message as your entire final answer, with no extra text.",
    );
    expect((runnerInputs[0] as { text: string }).text.endsWith("❤️")).toBe(
      true,
    );
    expect(
      (runnerInputs[0] as { toolGroups: { groups: string[] } }).toolGroups
        .groups,
    ).not.toContain("scheduler");
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

  test("fails literal scheduled jobs when the runtime returns only progress text", async () => {
    const store = createTokenStore(":memory:");
    const workflowStore = createInMemoryTaskWorkflowEventStore();
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
      triggerSource: "schedule",
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
        yield {
          type: "final",
          response: {
            classification: "user_private",
            text: "Calling conversation send message...\n\nFinal result in 2.0s.",
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
      workflowShadowStore: workflowStore,
    });

    await executor.executeRun(run.runId);

    expect(posts).toEqual([
      {
        channel: "C123",
        text: [
          "Scheduled job failed: Heart emoji every 30 min",
          "Job ID: job-heart",
          "Run ID: jobrun-heart",
          "Reason: Managed runtime final response contained only runtime-control/progress text",
        ].join("\n"),
      },
    ]);
    expect(warnings).toEqual([
      "Scheduled job run failed runId=jobrun-heart error=Managed runtime final response contained only runtime-control/progress text",
    ]);
    expect(store.getAgentJobRun(run.runId)).toMatchObject({
      runId: run.runId,
      status: "failed",
      failureReason:
        "Managed runtime final response contained only runtime-control/progress text",
    });
    expect(workflowStore.replayState().runs[run.runId]).toMatchObject({
      jobRunId: run.runId,
      taskId: job.jobId,
      source: "schedule",
      status: "failed",
      failureClass: "runtime_failed",
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

  test("fails leaked provider markers with arguments instead of delivering them", async () => {
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
      triggerSource: "schedule",
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
        yield {
          type: "final",
          response: {
            classification: "user_private",
            text: `:gear: github_search_issues: "org:apelogic-ai is:pr created:>=2026-06-27"`,
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

    expect(posts).toEqual([
      {
        channel: "C123",
        thread_ts: "1710000000.000000",
        text: [
          "Scheduled job failed: Check every 15 min for new PRs in apelogic-ai GitHub org",
          "Job ID: job-pr-monitor",
          "Run ID: jobrun-pr-monitor",
          "Reason: Managed runtime final response leaked tool-call protocol text",
        ].join("\n"),
      },
    ]);
    expect(warnings).toEqual([
      "Scheduled job run failed runId=jobrun-pr-monitor error=Managed runtime final response leaked tool-call protocol text",
    ]);
    expect(store.getAgentJobRun(run.runId)).toMatchObject({
      runId: run.runId,
      status: "failed",
      failureReason:
        "Managed runtime final response leaked tool-call protocol text",
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

  test("does not retry progress-only scheduled runs with delivery tool grants", async () => {
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
      runtimeType: "openclaw",
      state: "scheduled",
      now: new Date("2026-06-25T17:01:00.000Z"),
    });
    store.upsertAgentJobCapability({
      jobId: job.jobId,
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["github_search_issues", "conversation.sendMessage"],
      routeId: route.id,
      runtimeType: "openclaw",
      now: new Date("2026-06-25T17:01:30.000Z"),
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
    let attempts = 0;
    const runner: AgentRunner = {
      name: "test-runner",
      capabilities: {
        streaming: true,
        toolEvents: true,
        remote: true,
      },
      async *run(input) {
        attempts += 1;
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
    expect(posts).toEqual([
      {
        channel: "C123",
        text: [
          "Scheduled job failed: Check every 15 min for new PRs in apelogic-ai GitHub org",
          "Job ID: job-pr-monitor",
          "Run ID: jobrun-pr-monitor",
          "Reason: Managed runtime final response contained only runtime-control/progress text",
        ].join("\n"),
        thread_ts: "1710000000.000000",
      },
    ]);
    expect(warnings).toEqual([
      "Scheduled job run failed runId=jobrun-pr-monitor error=Managed runtime final response contained only runtime-control/progress text",
    ]);
    expect(store.getAgentJobRun(run.runId)).toMatchObject({
      runId: run.runId,
      status: "failed",
      failureReason:
        "Managed runtime final response contained only runtime-control/progress text",
    });

    store.close();
  });

  test("does not retry progress-only scheduled write-capable runs", async () => {
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
      jobId: "job-create-drive-file",
      workspaceId: "T123",
      slackUserId: "U123",
      title: "Create Drive summary file",
      prompt: "Create a Google Drive text file with the latest summary.",
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
      requiredTools: ["google_create_drive_text_file"],
      routeId: route.id,
      runtimeType: "hermes",
      now: new Date("2026-06-25T17:01:30.000Z"),
    });
    const run = store.createAgentJobRun({
      runId: "jobrun-create-drive-file",
      jobId: job.jobId,
      workspaceId: "T123",
      slackUserId: "U123",
      triggerSource: "schedule",
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
          type: "final",
          response: {
            classification: "user_private",
            text: "Calling google create drive text file...\n\nFinal result in 2.0s.",
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
    expect(posts).toEqual([
      {
        channel: "C123",
        text: [
          "Scheduled job failed: Create Drive summary file",
          "Job ID: job-create-drive-file",
          "Run ID: jobrun-create-drive-file",
          "Reason: Managed runtime final response contained only runtime-control/progress text",
        ].join("\n"),
      },
    ]);
    expect(warnings).toEqual([
      "Scheduled job run failed runId=jobrun-create-drive-file error=Managed runtime final response contained only runtime-control/progress text",
    ]);
    expect(store.getAgentJobRun(run.runId)).toMatchObject({
      runId: run.runId,
      status: "failed",
      failureReason:
        "Managed runtime final response contained only runtime-control/progress text",
    });

    store.close();
  });

  test("does not retry progress-only scheduled runs with unknown tool grants", async () => {
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
      jobId: "job-unknown-tool",
      workspaceId: "T123",
      slackUserId: "U123",
      title: "Unknown provider task",
      prompt: "Use a custom provider tool and post the result.",
      schedule: { kind: "interval", every: { hours: 1 } },
      routeId: route.id,
      runtimeType: "openclaw",
      state: "scheduled",
      now: new Date("2026-06-25T17:01:00.000Z"),
    });
    store.upsertAgentJobCapability({
      jobId: job.jobId,
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["custom_unknown_write_tool"],
      routeId: route.id,
      runtimeType: "openclaw",
      now: new Date("2026-06-25T17:01:30.000Z"),
    });
    const run = store.createAgentJobRun({
      runId: "jobrun-unknown-tool",
      jobId: job.jobId,
      workspaceId: "T123",
      slackUserId: "U123",
      triggerSource: "schedule",
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
          type: "final",
          response: {
            classification: "user_private",
            text: "Calling custom unknown write tool...\n\nFinal result in 2.0s.",
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

    expect(attempts).toBe(1);
    expect(posts).toEqual([
      {
        channel: "C123",
        text: [
          "Scheduled job failed: Unknown provider task",
          "Job ID: job-unknown-tool",
          "Run ID: jobrun-unknown-tool",
          "Reason: Managed runtime final response contained only runtime-control/progress text",
        ].join("\n"),
      },
    ]);
    expect(store.getAgentJobRun(run.runId)).toMatchObject({
      runId: run.runId,
      status: "failed",
      failureReason:
        "Managed runtime final response contained only runtime-control/progress text",
    });

    store.close();
  });

  test("fails progress-only scheduled provider runs after a tool call without retrying", async () => {
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
    expect(posts).toEqual([
      {
        channel: "C123",
        text: [
          "Scheduled job failed: Check every 15 min for new PRs in apelogic-ai GitHub org",
          "Job ID: job-pr-monitor",
          "Run ID: jobrun-pr-monitor",
          "Reason: Managed runtime final response contained only runtime-control/progress text",
        ].join("\n"),
      },
    ]);
    expect(warnings).toEqual([
      "Scheduled job run failed runId=jobrun-pr-monitor error=Managed runtime final response contained only runtime-control/progress text",
    ]);
    expect(store.getAgentJobRun(run.runId)).toMatchObject({
      runId: run.runId,
      status: "failed",
      failureReason:
        "Managed runtime final response contained only runtime-control/progress text",
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
