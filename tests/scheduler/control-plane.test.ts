import { describe, expect, test } from "bun:test";
import { createTokenStore } from "../../src/db";
import { createSchedulerControlPlane } from "../../src/scheduler/control-plane";

describe("scheduler control plane", () => {
  test("lists Burble-owned scheduled jobs for a principal", async () => {
    const store = createTokenStore(":memory:");
    store.upsertScheduledJob({
      jobId: "ai-news-hourly",
      workspaceId: "T123",
      slackUserId: "U123",
      title: "Hourly AI news summary",
      prompt: "look for fresh AI-related news and post a short summary",
      schedule: {
        kind: "interval",
        every: { hours: 1 },
      },
      routeId: "convrt_123",
      runtimeType: "hermes",
      now: new Date("2026-06-24T12:02:00.000Z"),
    });
    store.upsertAgentJobCapability({
      jobId: "legacy-ai-news-hourly",
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["google_search_drive_files"],
      routeId: "convrt_123",
      runtimeType: "hermes",
      now: new Date("2026-06-24T12:00:00.000Z"),
    });
    store.upsertAgentJobCapability({
      jobId: "other-user-job",
      workspaceId: "T123",
      slackUserId: "U456",
      requiredTools: ["github_list_my_pull_requests"],
      runtimeType: "openclaw",
      now: new Date("2026-06-24T12:01:00.000Z"),
    });

    const scheduler = createSchedulerControlPlane(store);

    expect(
      await scheduler.listJobs({ workspaceId: "T123", slackUserId: "U123" }),
    ).toEqual([
      {
        jobId: "ai-news-hourly",
        title: "Hourly AI news summary",
        prompt: "look for fresh AI-related news and post a short summary",
        schedule: {
          kind: "interval",
          every: { hours: 1 },
        },
        state: "scheduled",
        runtimeType: "hermes",
        requiredTools: [],
        routeId: "convrt_123",
        updatedAt: "2026-06-24T12:02:00.000Z",
      },
    ]);

    store.close();
  });

  test("creates Burble-owned scheduled jobs", async () => {
    const store = createTokenStore(":memory:");
    const scheduler = createSchedulerControlPlane(store, {
      now: () => new Date("2026-06-24T12:00:00.000Z"),
      newJobId: () => "job-created-1",
    });

    expect(
      await scheduler.createJob?.({
        workspaceId: "T123",
        slackUserId: "U123",
        title: "Hourly AI news summary",
        prompt: "look for fresh AI-related news and post a short summary",
        schedule: {
          kind: "interval",
          every: { hours: 1 },
        },
        routeId: "convrt_123",
        runtimeType: "hermes",
      }),
    ).toEqual({
      ok: true,
      job: {
        jobId: "job-created-1",
        workspaceId: "T123",
        slackUserId: "U123",
        title: "Hourly AI news summary",
        prompt: "look for fresh AI-related news and post a short summary",
        schedule: {
          kind: "interval",
          every: { hours: 1 },
        },
        routeId: "convrt_123",
        state: "scheduled",
        runtimeType: "hermes",
        createdAt: "2026-06-24T12:00:00.000Z",
        updatedAt: "2026-06-24T12:00:00.000Z",
      },
    });
    expect(
      (
        await scheduler.listJobs({ workspaceId: "T123", slackUserId: "U123" })
      ).map((job) => job.jobId),
    ).toEqual(["job-created-1"]);
    expect(store.getAgentJobCapability("job-created-1")).toMatchObject({
      jobId: "job-created-1",
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["web_extract"],
      routeId: "convrt_123",
      runtimeType: "hermes",
      capabilityProfile: "scheduled_job",
    });

    store.close();
  });

  test("creates manual trigger runs, self-heals capability state, and reports latest status", async () => {
    const store = createTokenStore(":memory:");
    store.upsertScheduledJob({
      jobId: "ai-news-hourly",
      workspaceId: "T123",
      slackUserId: "U123",
      title: "Hourly AI news summary",
      prompt: "look for fresh AI-related news and post a short summary",
      schedule: {
        kind: "interval",
        every: { hours: 1 },
      },
      runtimeType: "hermes",
      now: new Date("2026-06-24T12:00:00.000Z"),
    });

    const scheduler = createSchedulerControlPlane(store, {
      now: () => new Date("2026-06-24T12:05:00.000Z"),
      newRunId: () => "jobrun-manual-1",
    });

    expect(
      await scheduler.triggerJob?.({
        workspaceId: "T123",
        slackUserId: "U123",
        jobId: "ai-news-hourly",
      }),
    ).toEqual({
      ok: true,
      jobId: "ai-news-hourly",
      run: {
        runId: "jobrun-manual-1",
        jobId: "ai-news-hourly",
        workspaceId: "T123",
        slackUserId: "U123",
        triggerSource: "manual",
        status: "queued",
        failureReason: null,
        createdAt: "2026-06-24T12:05:00.000Z",
        updatedAt: "2026-06-24T12:05:00.000Z",
        startedAt: null,
        finishedAt: null,
      },
    });
    expect(store.getAgentJobCapability("ai-news-hourly")).toMatchObject({
      jobId: "ai-news-hourly",
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["web_extract"],
      runtimeType: "hermes",
      capabilityProfile: "scheduled_job",
    });
    expect(
      await scheduler.getLatestRunStatus?.({
        workspaceId: "T123",
        slackUserId: "U123",
        jobId: "ai-news-hourly",
      }),
    ).toEqual({
      ok: true,
      run: {
        runId: "jobrun-manual-1",
        jobId: "ai-news-hourly",
        workspaceId: "T123",
        slackUserId: "U123",
        triggerSource: "manual",
        status: "queued",
        failureReason: null,
        createdAt: "2026-06-24T12:05:00.000Z",
        updatedAt: "2026-06-24T12:05:00.000Z",
        startedAt: null,
        finishedAt: null,
      },
    });

    store.close();
  });

  test("does not treat capability-only registrations as current scheduled jobs", async () => {
    const store = createTokenStore(":memory:");
    store.upsertAgentJobCapability({
      jobId: "legacy-ai-news-hourly",
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["google_search_drive_files"],
      runtimeType: "hermes",
      now: new Date("2026-06-24T12:00:00.000Z"),
    });

    const scheduler = createSchedulerControlPlane(store);

    expect(
      await scheduler.listJobs({ workspaceId: "T123", slackUserId: "U123" }),
    ).toEqual([]);
    expect(
      await scheduler.triggerJob?.({
        workspaceId: "T123",
        slackUserId: "U123",
        jobId: "legacy-ai-news-hourly",
      }),
    ).toEqual({
      ok: false,
      reason: "not_found",
      jobs: [],
    });

    store.close();
  });

  test("pauses, resumes, and deletes Burble-owned scheduled jobs", async () => {
    const store = createTokenStore(":memory:");
    store.upsertScheduledJob({
      jobId: "job-ai-news-hourly",
      workspaceId: "T123",
      slackUserId: "U123",
      title: "Hourly AI news summary",
      prompt: "look for fresh AI-related news and post a short summary",
      schedule: {
        kind: "interval",
        every: { hours: 1 },
      },
      routeId: "convrt_123",
      runtimeType: "hermes",
      now: new Date("2026-06-24T12:00:00.000Z"),
    });

    const scheduler = createSchedulerControlPlane(store, {
      now: () => new Date("2026-06-24T12:10:00.000Z"),
    });

    expect(
      await scheduler.pauseJob?.({
        workspaceId: "T123",
        slackUserId: "U123",
        jobId: "job-ai-news-hourly",
      }),
    ).toEqual({
      ok: true,
      job: expect.objectContaining({
        jobId: "job-ai-news-hourly",
        state: "paused",
        updatedAt: "2026-06-24T12:10:00.000Z",
      }),
    });
    expect(
      await scheduler.resumeJob?.({
        workspaceId: "T123",
        slackUserId: "U123",
        jobId: "job-ai-news-hourly",
      }),
    ).toEqual({
      ok: true,
      job: expect.objectContaining({
        jobId: "job-ai-news-hourly",
        state: "scheduled",
        updatedAt: "2026-06-24T12:10:00.000Z",
      }),
    });
    expect(
      await scheduler.deleteJob?.({
        workspaceId: "T123",
        slackUserId: "U123",
        jobId: "job-ai-news-hourly",
      }),
    ).toEqual({
      ok: true,
      jobId: "job-ai-news-hourly",
    });
    expect(store.getScheduledJob("job-ai-news-hourly")).toBeNull();

    store.close();
  });
});
