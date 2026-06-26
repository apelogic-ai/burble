import { describe, expect, test } from "bun:test";
import { createTokenStore } from "../../src/db";
import { createSchedulerTimer } from "../../src/scheduler/timer";

describe("scheduler timer", () => {
  test("queues due interval jobs and hands them to the run executor", async () => {
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
    const executed: string[] = [];
    const timer = createSchedulerTimer({
      store,
      now: () => new Date("2026-06-25T18:00:01.000Z"),
      newRunId: () => "jobrun-timer-1",
      executeRun: async (runId) => {
        executed.push(runId);
      },
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
});
