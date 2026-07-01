import { describe, expect, test } from "bun:test";
import { createTokenStore } from "../../src/db";
import { createSchedulerTimer } from "../../src/scheduler/timer";
import { createInMemoryTaskWorkflowEventStore } from "../../src/workflow/task-workflow-store";

describe("scheduler timer", () => {
  test("queues cron jobs on schedule boundaries instead of creation-relative intervals", async () => {
    const store = createTokenStore(":memory:");
    store.upsertScheduledJob({
      jobId: "job-heart",
      workspaceId: "T123",
      slackUserId: "U123",
      title: "Post heart",
      prompt: "Post exactly this message: ❤️",
      schedule: {
        kind: "cron",
        expression: "*/15 * * * *",
        timezone: "UTC",
      },
      runtimeType: "hermes",
      state: "scheduled",
      now: new Date("2026-06-27T01:10:52.803Z"),
    });
    const executed: string[] = [];
    const earlyTimer = createSchedulerTimer({
      store,
      now: () => new Date("2026-06-27T01:14:59.000Z"),
      newRunId: () => "jobrun-too-early",
      executeRun: async (runId) => {
        executed.push(runId);
      },
    });

    expect(await earlyTimer.tick()).toEqual({ queuedRunIds: [] });
    expect(executed).toEqual([]);

    const dueTimer = createSchedulerTimer({
      store,
      now: () => new Date("2026-06-27T01:15:00.000Z"),
      newRunId: () => "jobrun-quarter-hour",
      executeRun: async (runId) => {
        executed.push(runId);
      },
    });

    expect(await dueTimer.tick()).toEqual({
      queuedRunIds: ["jobrun-quarter-hour"],
    });
    expect(executed).toEqual(["jobrun-quarter-hour"]);

    const duplicateTimer = createSchedulerTimer({
      store,
      now: () => new Date("2026-06-27T01:15:30.000Z"),
      newRunId: () => "jobrun-duplicate-slot",
      executeRun: async (runId) => {
        executed.push(runId);
      },
    });

    expect(await duplicateTimer.tick()).toEqual({ queuedRunIds: [] });
    expect(store.getAgentJobRun("jobrun-duplicate-slot")).toBeNull();

    store.close();
  });

  test("supports numeric cron ranges for weekday schedules", async () => {
    const store = createTokenStore(":memory:");
    store.upsertScheduledJob({
      jobId: "job-weekday-digest",
      workspaceId: "T123",
      slackUserId: "U123",
      title: "Weekday digest",
      prompt: "Summarize blockers and stale reviews.",
      schedule: {
        kind: "cron",
        expression: "0 9 * * 1-5",
        timezone: "UTC",
      },
      runtimeType: "openclaw",
      state: "scheduled",
      now: new Date("2026-06-26T08:00:00.000Z"),
    });
    const executed: string[] = [];
    const fridayTimer = createSchedulerTimer({
      store,
      now: () => new Date("2026-06-26T09:00:00.000Z"),
      newRunId: () => "jobrun-friday",
      executeRun: async (runId) => {
        executed.push(runId);
      },
    });

    expect(await fridayTimer.tick()).toEqual({
      queuedRunIds: ["jobrun-friday"],
    });
    expect(executed).toEqual(["jobrun-friday"]);

    const saturdayTimer = createSchedulerTimer({
      store,
      now: () => new Date("2026-06-27T09:00:00.000Z"),
      newRunId: () => "jobrun-saturday",
      executeRun: async (runId) => {
        executed.push(runId);
      },
    });

    expect(await saturdayTimer.tick()).toEqual({ queuedRunIds: [] });
    expect(store.getAgentJobRun("jobrun-saturday")).toBeNull();

    store.close();
  });

  test("queues due interval jobs and hands them to the run executor", async () => {
    const store = createTokenStore(":memory:");
    const workflowStore = createInMemoryTaskWorkflowEventStore();
    store.upsertScheduledJob({
      jobId: "job-ai-news",
      workspaceId: "T123",
      slackUserId: "U123",
      title: "Hourly AI news summary",
      prompt: "Find fresh AI news and summarize it.",
      schedule: { kind: "interval", every: { hours: 1 } },
      runtimeType: "openclaw",
      state: "scheduled",
      now: new Date("2026-06-25T17:00:00.000Z"),
    });
    const executed: string[] = [];
    const timer = createSchedulerTimer({
      store,
      now: () => new Date("2026-06-25T18:00:01.000Z"),
      newRunId: () => "jobrun-timer-1",
      executeRun: async (runId) => {
        executed.push(runId);
      },
      workflowShadowStore: workflowStore,
    });

    const result = await timer.tick();

    expect(result.queuedRunIds).toEqual(["jobrun-timer-1"]);
    expect(executed).toEqual(["jobrun-timer-1"]);
    expect(store.getAgentJobRun("jobrun-timer-1")).toMatchObject({
      runId: "jobrun-timer-1",
      jobId: "job-ai-news",
      triggerSource: "schedule",
      status: "queued",
    });
    expect(workflowStore.replayState().runs["jobrun-timer-1"]).toMatchObject({
      jobRunId: "jobrun-timer-1",
      taskId: "job-ai-news",
      source: "schedule",
      status: "created",
    });

    store.close();
  });

  test("timer workflow authority leaves workflow trigger events to the executor", async () => {
    const store = createTokenStore(":memory:");
    const workflowStore = createInMemoryTaskWorkflowEventStore();
    store.upsertScheduledJob({
      jobId: "job-ai-news",
      workspaceId: "T123",
      slackUserId: "U123",
      title: "Hourly AI news summary",
      prompt: "Find fresh AI news and summarize it.",
      schedule: { kind: "interval", every: { hours: 1 } },
      runtimeType: "openclaw",
      state: "scheduled",
      now: new Date("2026-06-25T17:00:00.000Z"),
    });
    const executed: string[] = [];
    const timer = createSchedulerTimer({
      store,
      now: () => new Date("2026-06-25T18:00:01.000Z"),
      newRunId: () => "jobrun-workflow-timer-1",
      executeRun: async (runId) => {
        executed.push(runId);
      },
      workflowAuthority: "timer",
      workflowShadowStore: workflowStore,
    });

    const result = await timer.tick();

    expect(result.queuedRunIds).toEqual(["jobrun-workflow-timer-1"]);
    expect(executed).toEqual(["jobrun-workflow-timer-1"]);
    expect(store.getAgentJobRun("jobrun-workflow-timer-1")).toMatchObject({
      runId: "jobrun-workflow-timer-1",
      jobId: "job-ai-news",
      triggerSource: "schedule",
      status: "queued",
    });
    expect(workflowStore.listEvents()).toEqual([]);

    store.close();
  });

  test("does not queue jobs before the next interval or while one is active", async () => {
    const store = createTokenStore(":memory:");
    store.upsertScheduledJob({
      jobId: "job-ai-news",
      workspaceId: "T123",
      slackUserId: "U123",
      title: "Hourly AI news summary",
      prompt: "Find fresh AI news and summarize it.",
      schedule: { kind: "interval", every: { hours: 1 } },
      runtimeType: "openclaw",
      state: "scheduled",
      now: new Date("2026-06-25T17:00:00.000Z"),
    });
    store.createAgentJobRun({
      runId: "jobrun-existing",
      jobId: "job-ai-news",
      workspaceId: "T123",
      slackUserId: "U123",
      triggerSource: "schedule",
      status: "running",
      now: new Date("2026-06-25T17:59:00.000Z"),
    });
    const timer = createSchedulerTimer({
      store,
      now: () => new Date("2026-06-25T18:30:00.000Z"),
      newRunId: () => "jobrun-should-not-queue",
      executeRun: async () => {
        throw new Error("unexpected run execution");
      },
    });

    expect(await timer.tick()).toEqual({ queuedRunIds: [] });
    expect(store.getAgentJobRun("jobrun-should-not-queue")).toBeNull();

    store.close();
  });

  test("queues at most one due interval job per principal while a scheduled run is active", async () => {
    const store = createTokenStore(":memory:");
    const createdAt = new Date("2026-06-25T17:00:00.000Z");
    for (const jobId of ["job-ai-news", "job-pr-checker"]) {
      store.upsertScheduledJob({
        jobId,
        workspaceId: "T123",
        slackUserId: "U123",
        title: jobId,
        prompt: "Run the scheduled task.",
        schedule: { kind: "interval", every: { hours: 1 } },
        runtimeType: "openclaw",
        state: "scheduled",
        now: createdAt,
      });
    }
    const executed: string[] = [];
    let ordinal = 0;
    const timer = createSchedulerTimer({
      store,
      now: () => new Date("2026-06-25T18:00:01.000Z"),
      newRunId: () => `jobrun-timer-${++ordinal}`,
      executeRun: async (runId) => {
        executed.push(runId);
      },
    });

    const result = await timer.tick();

    expect(result.queuedRunIds).toEqual(["jobrun-timer-1"]);
    expect(executed).toEqual(["jobrun-timer-1"]);
    expect(store.getAgentJobRun("jobrun-timer-2")).toBeNull();

    store.close();
  });

  test("ignores stale active runs when deciding whether a scheduled job is due", async () => {
    const store = createTokenStore(":memory:");
    store.upsertScheduledJob({
      jobId: "job-ai-news",
      workspaceId: "T123",
      slackUserId: "U123",
      title: "Hourly AI news summary",
      prompt: "Find fresh AI news and summarize it.",
      schedule: { kind: "interval", every: { hours: 1 } },
      runtimeType: "openclaw",
      state: "scheduled",
      now: new Date("2026-06-25T17:00:00.000Z"),
    });
    store.createAgentJobRun({
      runId: "jobrun-stale",
      jobId: "job-ai-news",
      workspaceId: "T123",
      slackUserId: "U123",
      triggerSource: "manual",
      status: "queued",
      now: new Date("2026-06-25T17:05:00.000Z"),
    });
    const executed: string[] = [];
    const timer = createSchedulerTimer({
      store,
      now: () => new Date("2026-06-25T18:30:00.000Z"),
      newRunId: () => "jobrun-timer-after-stale",
      executeRun: async (runId) => {
        executed.push(runId);
      },
    });

    expect(await timer.tick()).toEqual({
      queuedRunIds: ["jobrun-timer-after-stale"],
    });
    expect(executed).toEqual(["jobrun-timer-after-stale"]);

    store.close();
  });

  test("does not queue due jobs with invalid persisted tool grants", async () => {
    const store = createTokenStore(":memory:");
    const workflowStore = createInMemoryTaskWorkflowEventStore();
    store.upsertScheduledJob({
      jobId: "job-open-prs",
      workspaceId: "T123",
      slackUserId: "U123",
      title: "Check every 15 min for new PRs in apelogic-ai GitHub org",
      prompt:
        "Check every 15 min for new PRs in repos of https://github.com/apelogic-ai github org, post in this channel",
      schedule: {
        kind: "cron",
        expression: "*/15 * * * *",
        timezone: "UTC",
      },
      runtimeType: "openclaw",
      state: "scheduled",
      now: new Date("2026-06-27T17:10:00.000Z"),
    });
    store.upsertAgentJobCapability({
      jobId: "job-open-prs",
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["github_list_my_pull_requests"],
      runtimeType: "openclaw",
      capabilityProfile: "scheduled_job",
      stateRefs: [],
      visibilityPolicy: {},
      now: new Date("2026-06-27T17:10:00.000Z"),
    });
    const warnings: string[] = [];
    const timer = createSchedulerTimer({
      store,
      now: () => new Date("2026-06-27T17:15:00.000Z"),
      newRunId: () => "jobrun-invalid-grant",
      executeRun: async () => {
        throw new Error("unexpected run execution");
      },
      logWarn: (message) => warnings.push(message),
      workflowShadowStore: workflowStore,
    });

    expect(await timer.tick()).toEqual({ queuedRunIds: [] });
    expect(store.getAgentJobRun("jobrun-invalid-grant")).toMatchObject({
      runId: "jobrun-invalid-grant",
      jobId: "job-open-prs",
      triggerSource: "schedule",
      status: "failed",
    });
    expect(store.getAgentJobRun("jobrun-invalid-grant")?.failureReason).toContain(
      "Scheduled task validation failed: missing_required_tool",
    );
    expect(store.getAgentJobRun("jobrun-invalid-grant")?.failureReason).toContain(
      "github_search_issues",
    );
    expect(store.getAgentJobCapability("job-open-prs")?.requiredTools).toEqual([
      "github_list_my_pull_requests",
    ]);
    expect(
      workflowStore.replayState().runs["jobrun-invalid-grant"],
    ).toMatchObject({
      jobRunId: "jobrun-invalid-grant",
      taskId: "job-open-prs",
      source: "schedule",
      status: "failed",
      failureClass: "validation_failed",
    });
    expect(warnings.join("\n")).toContain("missing_required_tool");

    store.close();
  });

  test("timer workflow authority queues invalid persisted grants for driver validation", async () => {
    const store = createTokenStore(":memory:");
    const workflowStore = createInMemoryTaskWorkflowEventStore();
    store.upsertScheduledJob({
      jobId: "job-open-prs",
      workspaceId: "T123",
      slackUserId: "U123",
      title: "Check every 15 min for new PRs in apelogic-ai GitHub org",
      prompt:
        "Check every 15 min for new PRs in repos of https://github.com/apelogic-ai github org, post in this channel",
      schedule: {
        kind: "cron",
        expression: "*/15 * * * *",
        timezone: "UTC",
      },
      runtimeType: "openclaw",
      state: "scheduled",
      now: new Date("2026-06-27T17:10:00.000Z"),
    });
    store.upsertAgentJobCapability({
      jobId: "job-open-prs",
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["github_list_my_pull_requests"],
      runtimeType: "openclaw",
      capabilityProfile: "scheduled_job",
      stateRefs: [],
      visibilityPolicy: {},
      now: new Date("2026-06-27T17:10:00.000Z"),
    });
    const executed: string[] = [];
    const timer = createSchedulerTimer({
      store,
      now: () => new Date("2026-06-27T17:15:00.000Z"),
      newRunId: () => "jobrun-invalid-grant-workflow",
      executeRun: async (runId) => {
        executed.push(runId);
      },
      workflowAuthority: "timer",
      workflowShadowStore: workflowStore,
    });

    expect(await timer.tick()).toEqual({
      queuedRunIds: ["jobrun-invalid-grant-workflow"],
    });
    expect(executed).toEqual(["jobrun-invalid-grant-workflow"]);
    expect(store.getAgentJobRun("jobrun-invalid-grant-workflow")).toMatchObject({
      runId: "jobrun-invalid-grant-workflow",
      jobId: "job-open-prs",
      triggerSource: "schedule",
      status: "queued",
    });
    expect(store.getAgentJobCapability("job-open-prs")?.requiredTools).toEqual([
      "github_list_my_pull_requests",
    ]);
    expect(workflowStore.listEvents()).toEqual([]);

    store.close();
  });
});
