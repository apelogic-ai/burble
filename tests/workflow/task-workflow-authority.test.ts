import { describe, expect, test } from "bun:test";
import { createTokenStore } from "../../src/db";
import {
  finishAuthoritativeRunForStaleWorkflowFailure,
  recordWorkflowRunSucceededFromAuthoritative,
} from "../../src/workflow/task-workflow-authority";
import {
  createInMemoryTaskWorkflowEventStore,
  type TaskWorkflowEventStore,
} from "../../src/workflow/task-workflow-store";
import type { TaskWorkflowStaleRunFailure } from "../../src/workflow/task-workflow-reconcile";
import type { TaskWorkflowEvent } from "../../src/workflow/task-workflow";

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

  test("claims and fails a queued authoritative run after a stale workflow failure", () => {
    const store = createTokenStore(":memory:");
    store.createAgentJobRun({
      runId: "jobrun-queued",
      jobId: "task-heart",
      workspaceId: "T123",
      slackUserId: "U123",
      triggerSource: "manual",
      status: "queued",
      now: new Date("2026-06-28T17:00:00.000Z"),
    });

    const result = finishAuthoritativeRunForStaleWorkflowFailure({
      store,
      failure: staleFailure("jobrun-queued"),
    });

    expect(result).toMatchObject({
      status: "failed",
      run: {
        runId: "jobrun-queued",
        status: "failed",
        startedAt: "2026-06-28T17:12:00.000Z",
        finishedAt: "2026-06-28T17:12:00.000Z",
      },
    });
    expect(store.getAgentJobRun("jobrun-queued")).toMatchObject({
      status: "failed",
      failureReason:
        "Workflow run jobrun-queued remained running past the stale-run TTL.",
    });

    store.close();
  });

  test("reports an already succeeded authoritative run for workflow success sync", () => {
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
      status: "succeeded",
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

  test("syncs a stale workflow run to an already succeeded authoritative run", () => {
    const store = createTokenStore(":memory:");
    const workflowStore = createInMemoryTaskWorkflowEventStore();
    store.createAgentJobRun({
      runId: "jobrun-sync-succeeded",
      jobId: "task-heart",
      workspaceId: "T123",
      slackUserId: "U123",
      triggerSource: "manual",
      status: "queued",
      now: new Date("2026-06-28T17:00:00.000Z"),
    });
    store.claimAgentJobRun(
      "jobrun-sync-succeeded",
      new Date("2026-06-28T17:01:00.000Z"),
    );
    const succeededRun = store.finishAgentJobRun({
      runId: "jobrun-sync-succeeded",
      status: "succeeded",
      now: new Date("2026-06-28T17:03:00.000Z"),
    });
    expect(succeededRun).not.toBeNull();
    appendWorkflowStoreEvent(workflowStore, {
      type: "task_triggered",
      taskId: "task-heart",
      jobRunId: "jobrun-sync-succeeded",
      triggerKey: "task-heart:manual:jobrun-sync-succeeded",
      source: "manual",
      at: "2026-06-28T17:00:00.000Z",
    });
    appendWorkflowStoreEvent(workflowStore, {
      type: "validation_passed",
      taskId: "task-heart",
      jobRunId: "jobrun-sync-succeeded",
      at: "2026-06-28T17:00:30.000Z",
    });
    const staleRun = workflowStore.replayState().runs["jobrun-sync-succeeded"];
    expect(staleRun).toMatchObject({
      status: "running",
    });
    expect(staleRun?.attempt).toBeUndefined();

    recordWorkflowRunSucceededFromAuthoritative({
      store: workflowStore,
      run: succeededRun!,
      workflowRun: staleRun!,
    });

    const syncedRun = workflowStore.replayState().runs["jobrun-sync-succeeded"];
    expect(syncedRun).toMatchObject({
      status: "succeeded",
      reconciledFromAuthoritative: true,
      reconciliationReason: "Authoritative run already succeeded.",
    });
    expect(syncedRun?.attempt).toBeUndefined();
    expect(syncedRun?.outputDigest).toBeUndefined();
    expect(syncedRun?.deliveryKey).toBeUndefined();
    expect(syncedRun?.failureClass).toBeUndefined();
    expect(workflowStore.listEvents().map((event) => event.event.type)).toEqual(
      [
        "task_triggered",
        "validation_passed",
        "run_reconciled_succeeded",
      ],
    );

    store.close();
  });
});

function appendWorkflowStoreEvent(
  store: TaskWorkflowEventStore,
  event: TaskWorkflowEvent,
): void {
  store.appendEvent({
    eventId: `test:${"jobRunId" in event ? event.jobRunId : event.type}:${event.type}`,
    event,
    recordedAt: "at" in event ? event.at : new Date().toISOString(),
    ...(event.type === "task_triggered" ? { signalId: event.triggerKey } : {}),
  });
}

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
