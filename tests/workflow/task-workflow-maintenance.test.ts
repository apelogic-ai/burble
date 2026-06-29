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
});
