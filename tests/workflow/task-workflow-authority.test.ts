import { describe, expect, test } from "bun:test";
import { createTokenStore } from "../../src/db";
import { finishAuthoritativeRunForStaleWorkflowFailure } from "../../src/workflow/task-workflow-authority";
import type { TaskWorkflowStaleRunFailure } from "../../src/workflow/task-workflow-reconcile";

describe("task workflow authority reconciliation", () => {
  test("finishes the authoritative run after a stale workflow failure", () => {
    const store = createTokenStore(":memory:");
    store.createAgentJobRun({
      runId: "jobrun-stale",
      jobId: "task-heart",
      workspaceId: "T123",
      slackUserId: "U123",
      triggerSource: "manual",
      status: "queued",
      now: new Date("2026-06-28T17:00:00.000Z"),
    });
    store.claimAgentJobRun(
      "jobrun-stale",
      new Date("2026-06-28T17:01:00.000Z"),
    );

    const result = finishAuthoritativeRunForStaleWorkflowFailure({
      store,
      failure: staleFailure("jobrun-stale"),
    });

    expect(result).toMatchObject({
      status: "failed",
      run: {
        runId: "jobrun-stale",
        status: "failed",
        failureReason:
          "Workflow run jobrun-stale remained running past the stale-run TTL.",
        finishedAt: "2026-06-28T17:12:00.000Z",
      },
    });
    expect(store.getAgentJobRun("jobrun-stale")).toMatchObject({
      status: "failed",
      failureReason:
        "Workflow run jobrun-stale remained running past the stale-run TTL.",
    });

    store.close();
  });

  test("does not overwrite an already terminal authoritative run", () => {
    const store = createTokenStore(":memory:");
    store.createAgentJobRun({
      runId: "jobrun-succeeded",
      jobId: "task-heart",
      workspaceId: "T123",
      slackUserId: "U123",
      triggerSource: "manual",
      status: "queued",
      now: new Date("2026-06-28T17:00:00.000Z"),
    });
    store.claimAgentJobRun(
      "jobrun-succeeded",
      new Date("2026-06-28T17:01:00.000Z"),
    );
    store.finishAgentJobRun({
      runId: "jobrun-succeeded",
      status: "succeeded",
      now: new Date("2026-06-28T17:03:00.000Z"),
    });

    const result = finishAuthoritativeRunForStaleWorkflowFailure({
      store,
      failure: staleFailure("jobrun-succeeded"),
    });

    expect(result).toMatchObject({
      status: "already_terminal",
      run: {
        runId: "jobrun-succeeded",
        status: "succeeded",
        finishedAt: "2026-06-28T17:03:00.000Z",
      },
    });
    expect(store.getAgentJobRun("jobrun-succeeded")).toMatchObject({
      status: "succeeded",
      failureReason: null,
    });

    store.close();
  });
});

function staleFailure(jobRunId: string): TaskWorkflowStaleRunFailure {
  return {
    run: {
      taskId: "task-heart",
      jobRunId,
      triggerKey: `task-heart:manual:${jobRunId}`,
      source: "manual",
      status: "running",
      createdAt: "2026-06-28T17:00:00.000Z",
      updatedAt: "2026-06-28T17:01:00.000Z",
      attempt: 1,
    },
    event: {
      type: "attempt_failed",
      taskId: "task-heart",
      jobRunId,
      attempt: 1,
      failureClass: "stale_run_timeout",
      reason: `Workflow run ${jobRunId} remained running past the stale-run TTL.`,
      at: "2026-06-28T17:12:00.000Z",
    },
    storedEvent: {
      sequence: 2,
      eventId: `stale_run:${jobRunId}`,
      signalId: `stale_run:${jobRunId}`,
      recordedAt: "2026-06-28T17:12:00.000Z",
      event: {
        type: "attempt_failed",
        taskId: "task-heart",
        jobRunId,
        attempt: 1,
        failureClass: "stale_run_timeout",
        reason: `Workflow run ${jobRunId} remained running past the stale-run TTL.`,
        at: "2026-06-28T17:12:00.000Z",
      },
    },
  };
}
