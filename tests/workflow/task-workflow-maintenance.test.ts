import { describe, expect, test } from "bun:test";
import { maintainTaskWorkflowEventStore } from "../../src/workflow/task-workflow-maintenance";
import { createInMemoryTaskWorkflowEventStore } from "../../src/workflow/task-workflow-store";

describe("task workflow maintenance", () => {
  test("skips compaction below the event threshold", () => {
    const store = createInMemoryTaskWorkflowEventStore();

    const result = maintainTaskWorkflowEventStore({
      store,
      minEvents: 2,
    });

    expect(result).toEqual({
      skipped: true,
      reason: "below_event_threshold",
      eventCount: 0,
    });
    expect(store.getLatestSnapshot()).toBeNull();
  });

  test("snapshots and compacts while preserving replayed state", () => {
    const store = createInMemoryTaskWorkflowEventStore({
      now: () => new Date("2026-06-29T10:00:05.000Z"),
    });
    store.appendEvent({
      eventId: "evt-trigger",
      event: {
        type: "task_triggered",
        taskId: "job-1",
        jobRunId: "jobrun-1",
        triggerKey: "job-1:manual:jobrun-1",
        source: "manual",
        at: "2026-06-29T10:00:00.000Z",
      },
    });
    store.appendEvent({
      eventId: "evt-validation-passed",
      event: {
        type: "validation_passed",
        taskId: "job-1",
        jobRunId: "jobrun-1",
        at: "2026-06-29T10:00:01.000Z",
      },
    });

    const result = maintainTaskWorkflowEventStore({ store });

    expect(result.skipped).toBe(false);
    expect(result.snapshot?.sequence).toBe(2);
    expect(result.compaction).toMatchObject({
      compactedThroughSequence: 2,
      deletedEvents: 2,
    });
    expect(store.listEvents()).toEqual([]);
    expect(store.replayState().runs["jobrun-1"]).toMatchObject({
      status: "running",
      taskId: "job-1",
    });
  });

  test("prunes old terminal runs from compacted snapshots", () => {
    const store = createInMemoryTaskWorkflowEventStore({
      now: () => new Date("2026-06-29T10:00:00.000Z"),
    });
    appendSucceededRun(store, {
      runId: "jobrun-old",
      at: "2026-06-20T10:00:00.000Z",
    });
    appendSucceededRun(store, {
      runId: "jobrun-new",
      at: "2026-06-29T09:00:00.000Z",
    });

    maintainTaskWorkflowEventStore({
      store,
      now: () => new Date("2026-06-29T10:00:00.000Z"),
      maxTerminalRunAgeMs: 24 * 60 * 60_000,
    });

    expect(Object.keys(store.replayState().runs).sort()).toEqual([
      "jobrun-new",
    ]);
    expect(Object.values(store.replayState().triggerKeys)).toEqual([
      "jobrun-new",
    ]);
  });
});

function appendSucceededRun(
  store: ReturnType<typeof createInMemoryTaskWorkflowEventStore>,
  input: { runId: string; at: string },
): void {
  store.appendEvent({
    eventId: `${input.runId}:trigger`,
    event: {
      type: "task_triggered",
      taskId: "job-1",
      jobRunId: input.runId,
      triggerKey: `job-1:manual:${input.runId}`,
      source: "manual",
      at: input.at,
    },
  });
  store.appendEvent({
    eventId: `${input.runId}:validation-passed`,
    event: {
      type: "validation_passed",
      taskId: "job-1",
      jobRunId: input.runId,
      at: input.at,
    },
  });
  store.appendEvent({
    eventId: `${input.runId}:attempt-started`,
    event: {
      type: "attempt_started",
      taskId: "job-1",
      jobRunId: input.runId,
      attempt: 1,
      mode: "agent",
      at: input.at,
    },
  });
  store.appendEvent({
    eventId: `${input.runId}:attempt-succeeded`,
    event: {
      type: "attempt_succeeded",
      taskId: "job-1",
      jobRunId: input.runId,
      attempt: 1,
      outputDigest: `sha256:${input.runId}`,
      at: input.at,
    },
  });
  store.appendEvent({
    eventId: `${input.runId}:delivery-started`,
    event: {
      type: "delivery_started",
      taskId: "job-1",
      jobRunId: input.runId,
      deliveryKey: `${input.runId}:delivery`,
      at: input.at,
    },
  });
  store.appendEvent({
    eventId: `${input.runId}:delivery-succeeded`,
    event: {
      type: "delivery_succeeded",
      taskId: "job-1",
      jobRunId: input.runId,
      deliveryKey: `${input.runId}:delivery`,
      at: input.at,
    },
  });
}
