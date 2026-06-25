import { describe, expect, test } from "bun:test";
import { createTokenStore } from "../../src/db";
import { createSchedulerControlPlane } from "../../src/scheduler/control-plane";

describe("scheduler control plane", () => {
  test("lists persisted scheduled job capabilities for a principal", async () => {
    const store = createTokenStore(":memory:");
    store.upsertAgentJobCapability({
      jobId: "ai-news-hourly",
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["google_search_drive_files"],
      routeId: "convrt_123",
      runtimeType: "hermes",
      now: new Date("2026-06-24T12:00:00.000Z")
    });
    store.upsertAgentJobCapability({
      jobId: "other-user-job",
      workspaceId: "T123",
      slackUserId: "U456",
      requiredTools: ["github_list_my_pull_requests"],
      runtimeType: "openclaw",
      now: new Date("2026-06-24T12:01:00.000Z")
    });

    const scheduler = createSchedulerControlPlane(store);

    expect(
      await scheduler.listJobs({ workspaceId: "T123", slackUserId: "U123" })
    ).toEqual([
      {
        jobId: "ai-news-hourly",
        runtimeType: "hermes",
        requiredTools: ["google_search_drive_files"],
        routeId: "convrt_123",
        updatedAt: "2026-06-24T12:00:00.000Z"
      }
    ]);

    store.close();
  });

  test("creates manual trigger runs and reports latest status", async () => {
    const store = createTokenStore(":memory:");
    store.upsertAgentJobCapability({
      jobId: "ai-news-hourly",
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["google_search_drive_files"],
      runtimeType: "hermes",
      now: new Date("2026-06-24T12:00:00.000Z")
    });

    const scheduler = createSchedulerControlPlane(store, {
      now: () => new Date("2026-06-24T12:05:00.000Z"),
      newRunId: () => "jobrun-manual-1"
    });

    expect(
      await scheduler.triggerJob?.({
        workspaceId: "T123",
        slackUserId: "U123",
        jobId: "ai-news-hourly"
      })
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
        finishedAt: null
      }
    });
    expect(
      await scheduler.getLatestRunStatus?.({
        workspaceId: "T123",
        slackUserId: "U123",
        jobId: "ai-news-hourly"
      })
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
        finishedAt: null
      }
    });

    store.close();
  });
});
