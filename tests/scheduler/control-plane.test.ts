import { describe, expect, test } from "bun:test";
import { createTokenStore } from "../../src/db";
import { createSchedulerControlPlane } from "../../src/scheduler/control-plane";
import { createInMemoryTaskWorkflowEventStore } from "../../src/workflow/task-workflow-store";

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
      requiredTools: ["web_search"],
      routeId: "convrt_123",
      runtimeType: "hermes",
      capabilityProfile: "scheduled_job",
    });

    store.close();
  });

  test("rejects scheduled jobs with unsupported schedules", async () => {
    const store = createTokenStore(":memory:");
    const scheduler = createSchedulerControlPlane(store, {
      now: () => new Date("2026-06-24T12:00:00.000Z"),
      newJobId: () => "job-created-1",
    });

    expect(
      await scheduler.createJob?.({
        workspaceId: "T123",
        slackUserId: "U123",
        title: "Weekday AI news",
        prompt: "look for fresh AI-related news and post a short summary",
        schedule: {
          kind: "cron",
          expression: "1-5 9 * * mon-fri",
          timezone: "America/Los_Angeles",
        },
        routeId: "convrt_123",
        runtimeType: "openclaw",
      }),
    ).toEqual({
      ok: false,
      reason: "invalid_schedule",
      message: expect.stringContaining("UTC"),
    });
    expect(
      store
        .listScheduledJobsForPrincipal("T123", "U123")
        .map((job) => job.jobId),
    ).toEqual([]);

    store.close();
  });

  test("creates manual trigger runs, self-heals capability state, and reports latest status", async () => {
    const store = createTokenStore(":memory:");
    const workflowStore = createInMemoryTaskWorkflowEventStore();
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
      workflowShadowStore: workflowStore,
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
      requiredTools: ["web_search"],
      runtimeType: "hermes",
      capabilityProfile: "scheduled_job",
    });
    expect(workflowStore.replayState().runs["jobrun-manual-1"]).toMatchObject({
      jobRunId: "jobrun-manual-1",
      taskId: "ai-news-hourly",
      source: "manual",
      status: "created",
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

  test("does not create duplicate manual runs while a scheduled task is active", async () => {
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
    store.createAgentJobRun({
      runId: "jobrun-existing",
      jobId: "ai-news-hourly",
      workspaceId: "T123",
      slackUserId: "U123",
      triggerSource: "manual",
      status: "queued",
      now: new Date("2026-06-24T12:04:00.000Z"),
    });
    const scheduler = createSchedulerControlPlane(store, {
      now: () => new Date("2026-06-24T12:05:00.000Z"),
      newRunId: () => "jobrun-duplicate",
    });

    expect(
      await scheduler.triggerJob?.({
        workspaceId: "T123",
        slackUserId: "U123",
        jobId: "ai-news-hourly",
      }),
    ).toEqual({
      ok: false,
      reason: "already_running",
      jobId: "ai-news-hourly",
      run: expect.objectContaining({
        runId: "jobrun-existing",
        status: "queued",
      }),
    });
    expect(store.getAgentJobRun("jobrun-duplicate")).toBeNull();
    expect(
      store
        .listAgentJobRunsForPrincipal("T123", "U123", "ai-news-hourly")
        .map((run) => run.runId),
    ).toEqual(["jobrun-existing"]);

    store.close();
  });

  test("lists job runs independently from scheduled task specs", async () => {
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
      runtimeType: "openclaw",
      now: new Date("2026-06-24T12:00:00.000Z"),
    });
    store.createAgentJobRun({
      runId: "jobrun-first",
      jobId: "ai-news-hourly",
      workspaceId: "T123",
      slackUserId: "U123",
      triggerSource: "manual",
      status: "succeeded",
      now: new Date("2026-06-24T12:05:00.000Z"),
      startedAt: "2026-06-24T12:05:01.000Z",
      finishedAt: "2026-06-24T12:05:10.000Z",
    });
    store.createAgentJobRun({
      runId: "jobrun-second",
      jobId: "ai-news-hourly",
      workspaceId: "T123",
      slackUserId: "U123",
      triggerSource: "schedule",
      status: "queued",
      now: new Date("2026-06-24T12:10:00.000Z"),
    });

    const scheduler = createSchedulerControlPlane(store);

    expect(
      (
        await scheduler.listJobs({ workspaceId: "T123", slackUserId: "U123" })
      ).map((job) => job.jobId),
    ).toEqual(["ai-news-hourly"]);
    expect(
      await scheduler.listJobRuns?.({
        workspaceId: "T123",
        slackUserId: "U123",
      }),
    ).toEqual({
      runs: [
        expect.objectContaining({
          runId: "jobrun-second",
          jobId: "ai-news-hourly",
          status: "queued",
          triggerSource: "schedule",
        }),
        expect.objectContaining({
          runId: "jobrun-first",
          jobId: "ai-news-hourly",
          status: "succeeded",
          triggerSource: "manual",
        }),
      ],
    });

    store.close();
  });

  test("lists scheduled task specs independently from job runs", async () => {
    const store = createTokenStore(":memory:");
    store.upsertScheduledJob({
      jobId: "github-pr-monitor",
      workspaceId: "T123",
      slackUserId: "U123",
      title: "Open PR monitor",
      prompt:
        "check for new open PRs in https://github.com/apelogic-ai github org",
      schedule: {
        kind: "interval",
        every: { minutes: 15 },
      },
      routeId: "convrt_123",
      runtimeType: "hermes",
      now: new Date("2026-06-24T12:00:00.000Z"),
    });
    store.upsertAgentJobCapability({
      jobId: "github-pr-monitor",
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["github_search_issues"],
      routeId: "convrt_123",
      runtimeType: "hermes",
      now: new Date("2026-06-24T12:01:00.000Z"),
    });
    store.createAgentJobRun({
      runId: "jobrun-first",
      jobId: "github-pr-monitor",
      workspaceId: "T123",
      slackUserId: "U123",
      triggerSource: "manual",
      status: "queued",
      now: new Date("2026-06-24T12:05:00.000Z"),
    });

    const scheduler = createSchedulerControlPlane(store);

    expect(
      await scheduler.listTasks?.({ workspaceId: "T123", slackUserId: "U123" }),
    ).toEqual([
      {
        taskId: "github-pr-monitor",
        jobId: "github-pr-monitor",
        title: "Open PR monitor",
        prompt:
          "check for new open PRs in https://github.com/apelogic-ai github org",
        schedule: {
          kind: "interval",
          every: { minutes: 15 },
        },
        state: "scheduled",
        runtimeType: "hermes",
        requiredTools: ["github_search_issues"],
        routeId: "convrt_123",
        updatedAt: "2026-06-24T12:00:00.000Z",
      },
    ]);
    expect(
      await scheduler.showTask?.({
        workspaceId: "T123",
        slackUserId: "U123",
        taskId: "github-pr-monitor",
      }),
    ).toEqual({
      ok: true,
      task: {
        taskId: "github-pr-monitor",
        jobId: "github-pr-monitor",
        title: "Open PR monitor",
        prompt:
          "check for new open PRs in https://github.com/apelogic-ai github org",
        schedule: {
          kind: "interval",
          every: { minutes: 15 },
        },
        state: "scheduled",
        runtimeType: "hermes",
        requiredTools: ["github_search_issues"],
        routeId: "convrt_123",
        updatedAt: "2026-06-24T12:00:00.000Z",
      },
      validation: {
        ok: true,
        expectedTools: ["github_search_issues"],
        grantedTools: ["github_search_issues"],
        errors: [],
        warnings: [],
      },
    });
    expect(
      await scheduler.listJobRuns?.({
        workspaceId: "T123",
        slackUserId: "U123",
      }),
    ).toEqual({
      runs: [
        expect.objectContaining({
          runId: "jobrun-first",
          jobId: "github-pr-monitor",
          status: "queued",
        }),
      ],
    });

    store.close();
  });

  test("validates scheduled task grants before execution", async () => {
    const store = createTokenStore(":memory:");
    store.upsertScheduledJob({
      jobId: "github-pr-monitor",
      workspaceId: "T123",
      slackUserId: "U123",
      title: "Open PR monitor",
      prompt:
        "check for new open PRs in https://github.com/apelogic-ai github org",
      schedule: {
        kind: "interval",
        every: { minutes: 15 },
      },
      routeId: "convrt_123",
      runtimeType: "hermes",
      now: new Date("2026-06-24T12:00:00.000Z"),
    });
    store.upsertAgentJobCapability({
      jobId: "github-pr-monitor",
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["github_list_my_pull_requests"],
      routeId: "convrt_123",
      runtimeType: "hermes",
      now: new Date("2026-06-24T12:01:00.000Z"),
    });

    const scheduler = createSchedulerControlPlane(store);

    expect(
      await scheduler.validateTask?.({
        workspaceId: "T123",
        slackUserId: "U123",
        taskId: "github-pr-monitor",
      }),
    ).toEqual({
      ok: true,
      taskId: "github-pr-monitor",
      validation: {
        ok: false,
        expectedTools: ["github_search_issues"],
        grantedTools: ["github_list_my_pull_requests"],
        errors: [
          {
            code: "missing_required_tool",
            message:
              "Task requires github_search_issues but the grant does not include it.",
            tool: "github_search_issues",
          },
        ],
        warnings: [
          {
            code: "wrong_github_pr_scope",
            message:
              "github_list_my_pull_requests only lists the authenticated user's PRs; org-wide PR monitoring needs github_search_issues.",
            tool: "github_list_my_pull_requests",
            expectedTool: "github_search_issues",
          },
        ],
      },
    });

    store.close();
  });

  test("does not trigger scheduled tasks with invalid grants", async () => {
    const store = createTokenStore(":memory:");
    store.upsertScheduledJob({
      jobId: "github-pr-monitor",
      workspaceId: "T123",
      slackUserId: "U123",
      title: "Open PR monitor",
      prompt:
        "check for new open PRs in https://github.com/apelogic-ai github org",
      schedule: {
        kind: "interval",
        every: { minutes: 15 },
      },
      routeId: "convrt_123",
      runtimeType: "hermes",
      now: new Date("2026-06-24T12:00:00.000Z"),
    });
    store.upsertAgentJobCapability({
      jobId: "github-pr-monitor",
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["github_list_my_pull_requests"],
      routeId: "convrt_123",
      runtimeType: "hermes",
      now: new Date("2026-06-24T12:01:00.000Z"),
    });

    const scheduler = createSchedulerControlPlane(store, {
      newRunId: () => "jobrun-should-not-exist",
    });

    expect(
      await scheduler.triggerJob?.({
        workspaceId: "T123",
        slackUserId: "U123",
        jobId: "github-pr-monitor",
      }),
    ).toMatchObject({
      ok: false,
      reason: "validation_failed",
      task: {
        taskId: "github-pr-monitor",
        requiredTools: ["github_list_my_pull_requests"],
      },
      validation: {
        ok: false,
        expectedTools: ["github_search_issues"],
        grantedTools: ["github_list_my_pull_requests"],
        errors: [
          {
            code: "missing_required_tool",
            tool: "github_search_issues",
          },
        ],
      },
    });
    expect(store.listAgentJobRunsForPrincipal("T123", "U123")).toEqual([]);

    store.close();
  });

  test("records manual workflow-authority validation failures as failed runs", async () => {
    const store = createTokenStore(":memory:");
    const workflowStore = createInMemoryTaskWorkflowEventStore();
    store.upsertScheduledJob({
      jobId: "github-pr-monitor",
      workspaceId: "T123",
      slackUserId: "U123",
      title: "Open PR monitor",
      prompt:
        "check for new open PRs in https://github.com/apelogic-ai github org",
      schedule: {
        kind: "interval",
        every: { minutes: 15 },
      },
      routeId: "convrt_123",
      runtimeType: "hermes",
      now: new Date("2026-06-24T12:00:00.000Z"),
    });
    store.upsertAgentJobCapability({
      jobId: "github-pr-monitor",
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["github_list_my_pull_requests"],
      routeId: "convrt_123",
      runtimeType: "hermes",
      now: new Date("2026-06-24T12:01:00.000Z"),
    });

    const scheduler = createSchedulerControlPlane(store, {
      workflowAuthority: "manual",
      workflowShadowStore: workflowStore,
      now: () => new Date("2026-06-24T12:05:00.000Z"),
      newRunId: () => "jobrun-validation-failed",
    });

    expect(
      await scheduler.triggerJob?.({
        workspaceId: "T123",
        slackUserId: "U123",
        jobId: "github-pr-monitor",
      }),
    ).toMatchObject({
      ok: false,
      reason: "validation_failed",
    });
    expect(store.listAgentJobRunsForJob("github-pr-monitor")).toEqual([
      expect.objectContaining({
        runId: "jobrun-validation-failed",
        status: "failed",
        failureReason: expect.stringContaining(
          "missing_required_tool: Task requires github_search_issues",
        ),
      }),
    ]);
    expect(
      workflowStore.replayState().runs["jobrun-validation-failed"],
    ).toMatchObject({
      status: "failed",
      failureClass: "validation_failed",
    });
    expect(
      await scheduler.triggerJob?.({
        workspaceId: "T123",
        slackUserId: "U123",
        jobId: "github-pr-monitor",
      }),
    ).toMatchObject({
      ok: false,
      reason: "recent_validation_failure",
      run: {
        runId: "jobrun-validation-failed",
        status: "failed",
      },
    });
    expect(store.listAgentJobRunsForJob("github-pr-monitor")).toHaveLength(1);

    store.close();
  });

  test("passes validation for scheduled task grants that match inferred tools", async () => {
    const store = createTokenStore(":memory:");
    store.upsertScheduledJob({
      jobId: "github-pr-monitor",
      workspaceId: "T123",
      slackUserId: "U123",
      title: "Open PR monitor",
      prompt:
        "check for new open PRs in https://github.com/apelogic-ai github org",
      schedule: {
        kind: "interval",
        every: { minutes: 15 },
      },
      routeId: "convrt_123",
      runtimeType: "hermes",
      now: new Date("2026-06-24T12:00:00.000Z"),
    });
    store.upsertAgentJobCapability({
      jobId: "github-pr-monitor",
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["github_search_issues"],
      routeId: "convrt_123",
      runtimeType: "hermes",
      now: new Date("2026-06-24T12:01:00.000Z"),
    });

    const scheduler = createSchedulerControlPlane(store);

    expect(
      await scheduler.validateTask?.({
        workspaceId: "T123",
        slackUserId: "U123",
        taskId: "github-pr-monitor",
      }),
    ).toEqual({
      ok: true,
      taskId: "github-pr-monitor",
      validation: {
        ok: true,
        expectedTools: ["github_search_issues"],
        grantedTools: ["github_search_issues"],
        errors: [],
        warnings: [],
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

  test("updates scheduled job schedule without creating a new job", async () => {
    const store = createTokenStore(":memory:");
    store.upsertScheduledJob({
      jobId: "job-heart",
      workspaceId: "T123",
      slackUserId: "U123",
      title: "Heart emoji every 30 min",
      prompt: "Post exactly this message: ❤️",
      schedule: {
        kind: "cron",
        expression: "*/30 * * * *",
        timezone: "UTC",
      },
      routeId: "convrt_heart",
      runtimeType: "hermes",
      now: new Date("2026-06-27T17:39:00.000Z"),
    });
    const scheduler = createSchedulerControlPlane(store, {
      now: () => new Date("2026-06-27T17:40:00.000Z"),
    });

    expect(
      await scheduler.updateJobSchedule?.({
        workspaceId: "T123",
        slackUserId: "U123",
        jobId: "job-heart",
        schedule: {
          kind: "cron",
          expression: "*/45 * * * *",
          timezone: "UTC",
        },
      }),
    ).toEqual({
      ok: true,
      job: expect.objectContaining({
        jobId: "job-heart",
        schedule: {
          kind: "cron",
          expression: "*/45 * * * *",
          timezone: "UTC",
        },
        updatedAt: "2026-06-27T17:40:00.000Z",
      }),
    });
    expect(
      store
        .listScheduledJobsForPrincipal("T123", "U123")
        .map((job) => job.jobId),
    ).toEqual(["job-heart"]);

    store.close();
  });

  test("rejects scheduled job schedule updates the timer cannot fire", async () => {
    const store = createTokenStore(":memory:");
    store.upsertScheduledJob({
      jobId: "job-heart",
      workspaceId: "T123",
      slackUserId: "U123",
      title: "Heart emoji every 30 min",
      prompt: "Post exactly this message: ❤️",
      schedule: {
        kind: "cron",
        expression: "*/30 * * * *",
        timezone: "UTC",
      },
      routeId: "convrt_heart",
      runtimeType: "hermes",
      now: new Date("2026-06-27T17:39:00.000Z"),
    });
    const scheduler = createSchedulerControlPlane(store, {
      now: () => new Date("2026-06-27T17:40:00.000Z"),
    });

    expect(
      await scheduler.updateJobSchedule?.({
        workspaceId: "T123",
        slackUserId: "U123",
        jobId: "job-heart",
        schedule: {
          kind: "cron",
          expression: "1-5 9 * * mon-fri",
          timezone: "UTC",
        },
      }),
    ).toEqual({
      ok: false,
      reason: "invalid_schedule",
      message: expect.stringContaining("unsupported cron field"),
      jobs: [expect.objectContaining({ jobId: "job-heart" })],
    });
    expect(store.getScheduledJob("job-heart")?.schedule).toEqual({
      kind: "cron",
      expression: "*/30 * * * *",
      timezone: "UTC",
    });

    store.close();
  });

  test("updates scheduled job prompt and refreshes inferred capabilities", async () => {
    const store = createTokenStore(":memory:");
    store.upsertScheduledJob({
      jobId: "job-heart",
      workspaceId: "T123",
      slackUserId: "U123",
      title: "Heart emoji every 30 min",
      prompt: "Post exactly this message: ❤️",
      schedule: {
        kind: "cron",
        expression: "*/30 * * * *",
        timezone: "UTC",
      },
      routeId: "convrt_heart",
      runtimeType: "hermes",
      now: new Date("2026-06-27T17:39:00.000Z"),
    });
    const scheduler = createSchedulerControlPlane(store, {
      now: () => new Date("2026-06-27T17:40:00.000Z"),
    });

    expect(
      await scheduler.updateJobPrompt?.({
        workspaceId: "T123",
        slackUserId: "U123",
        jobId: "job-heart",
        prompt: "Post exactly this message: ❤️❤️",
      }),
    ).toEqual({
      ok: true,
      job: expect.objectContaining({
        jobId: "job-heart",
        prompt: "Post exactly this message: ❤️❤️",
        updatedAt: "2026-06-27T17:40:00.000Z",
      }),
    });
    expect(store.getScheduledJob("job-heart")?.prompt).toBe(
      "Post exactly this message: ❤️❤️",
    );
    expect(store.getAgentJobCapability("job-heart")).toMatchObject({
      jobId: "job-heart",
      requiredTools: [],
      runtimeType: "hermes",
    });

    store.close();
  });

  test("updates scheduled job delivery to an existing Slack channel grant", async () => {
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
      routeId: "convrt_old",
      runtimeType: "openclaw",
      now: new Date("2026-06-24T12:00:00.000Z"),
    });
    const route = store.upsertConversationRoute({
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      kind: "grant",
      grantedBySlackUserId: "U123",
      destination: {
        channelId: "CNEWS",
        isDirectMessage: false,
        rootId: "channel:CNEWS",
      },
      now: new Date("2026-06-24T12:01:00.000Z"),
    });

    const scheduler = createSchedulerControlPlane(store, {
      now: () => new Date("2026-06-24T12:10:00.000Z"),
    });

    expect(
      await scheduler.updateJobDelivery?.({
        workspaceId: "T123",
        slackUserId: "U123",
        jobId: "job-ai-news-hourly",
        channelId: "CNEWS",
      }),
    ).toEqual({
      ok: true,
      job: expect.objectContaining({
        jobId: "job-ai-news-hourly",
        routeId: route.id,
        updatedAt: "2026-06-24T12:10:00.000Z",
      }),
      routeId: route.id,
    });

    expect(store.getScheduledJob("job-ai-news-hourly")?.routeId).toBe(route.id);

    store.close();
  });

  test("does not update delivery for unresolved Slack channel names", async () => {
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
      routeId: "convrt_old",
      runtimeType: "openclaw",
      now: new Date("2026-06-24T12:00:00.000Z"),
    });

    const scheduler = createSchedulerControlPlane(store, {
      now: () => new Date("2026-06-24T12:10:00.000Z"),
    });

    expect(
      await scheduler.updateJobDelivery?.({
        workspaceId: "T123",
        slackUserId: "U123",
        jobId: "job-ai-news-hourly",
        channelName: "ai-news",
      }),
    ).toEqual({
      ok: false,
      reason: "unresolved_channel",
      jobs: [
        expect.objectContaining({
          jobId: "job-ai-news-hourly",
          routeId: "convrt_old",
        }),
      ],
      channelName: "ai-news",
    });

    expect(store.getScheduledJob("job-ai-news-hourly")?.routeId).toBe(
      "convrt_old",
    );

    store.close();
  });

  test("resolves scheduled job delivery channel names through existing grants", async () => {
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
      routeId: "convrt_old",
      runtimeType: "openclaw",
      now: new Date("2026-06-24T12:00:00.000Z"),
    });
    const route = store.upsertConversationRoute({
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      kind: "grant",
      grantedBySlackUserId: "U123",
      destination: {
        channelId: "CNEWS",
        isDirectMessage: false,
        rootId: "channel:CNEWS",
      },
      now: new Date("2026-06-24T12:01:00.000Z"),
    });
    const lookups: unknown[] = [];
    const scheduler = createSchedulerControlPlane(store, {
      now: () => new Date("2026-06-24T12:10:00.000Z"),
      resolveSlackChannelIdByName: (input) => {
        lookups.push(input);
        return "CNEWS";
      },
    });

    expect(
      await scheduler.updateJobDelivery?.({
        workspaceId: "T123",
        slackUserId: "U123",
        jobId: "job-ai-news-hourly",
        channelName: "ai-news",
      }),
    ).toEqual({
      ok: true,
      job: expect.objectContaining({
        jobId: "job-ai-news-hourly",
        routeId: route.id,
      }),
      routeId: route.id,
    });
    expect(lookups).toEqual([
      {
        workspaceId: "T123",
        channelName: "ai-news",
      },
    ]);

    store.close();
  });
});
