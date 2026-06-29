import { describe, expect, test } from "bun:test";
import { createInMemoryTaskWorkflowEventStore } from "../../src/workflow/task-workflow-store";

describe("task workflow event store", () => {
  test("appends events idempotently by event id", () => {
    const store = createInMemoryTaskWorkflowEventStore({
      now: () => new Date("2026-06-28T17:00:00.000Z"),
    });
    const input = {
      eventId: "evt-1",
      event: {
        type: "task_triggered" as const,
        taskId: "task-heart",
        jobRunId: "jobrun-1",
        triggerKey: "task-heart:manual:req-1",
        source: "manual" as const,
        at: "2026-06-28T17:00:00.000Z",
      },
      signalId: "manual:req-1",
    };

    const first = store.appendEvent(input);
    const second = store.appendEvent(input);

    expect(first).toEqual({
      sequence: 1,
      eventId: "evt-1",
      event: input.event,
      recordedAt: "2026-06-28T17:00:00.000Z",
      signalId: "manual:req-1",
    });
    expect(second).toBe(first);
    expect(store.listEvents()).toEqual([first]);
  });

  test("lists events by signal id", () => {
    const store = createInMemoryTaskWorkflowEventStore();
    store.appendEvent({
      eventId: "evt-trigger-1",
      signalId: "manual:req-1",
      event: {
        type: "task_triggered",
        taskId: "task-heart",
        jobRunId: "jobrun-1",
        triggerKey: "task-heart:manual:req-1",
        source: "manual",
        at: "2026-06-28T17:00:00.000Z",
      },
    });
    store.appendEvent({
      eventId: "evt-trigger-2",
      signalId: "manual:req-2",
      event: {
        type: "task_triggered",
        taskId: "task-heart",
        jobRunId: "jobrun-2",
        triggerKey: "task-heart:manual:req-2",
        source: "manual",
        at: "2026-06-28T17:01:00.000Z",
      },
    });

    expect(
      store.listEvents({ signalId: "manual:req-1" }).map((event) => event.eventId),
    ).toEqual(["evt-trigger-1"]);
  });

  test("replays stored events into workflow state", () => {
    const store = createInMemoryTaskWorkflowEventStore();
    store.appendEvent({
      eventId: "evt-trigger",
      recordedAt: "2026-06-28T17:00:00.000Z",
      event: {
        type: "task_triggered",
        taskId: "task-heart",
        jobRunId: "jobrun-1",
        triggerKey: "task-heart:manual:req-1",
        source: "manual",
        at: "2026-06-28T17:00:00.000Z",
      },
    });
    store.appendEvent({
      eventId: "evt-validation-passed",
      recordedAt: "2026-06-28T17:00:01.000Z",
      event: {
        type: "validation_passed",
        taskId: "task-heart",
        jobRunId: "jobrun-1",
        at: "2026-06-28T17:00:01.000Z",
      },
    });
    store.appendEvent({
      eventId: "evt-attempt-started",
      recordedAt: "2026-06-28T17:00:02.000Z",
      event: {
        type: "attempt_started",
        taskId: "task-heart",
        jobRunId: "jobrun-1",
        attempt: 1,
        mode: "agent",
        at: "2026-06-28T17:00:02.000Z",
      },
    });
    store.appendEvent({
      eventId: "evt-success",
      recordedAt: "2026-06-28T17:00:03.000Z",
      event: {
        type: "attempt_succeeded",
        taskId: "task-heart",
        jobRunId: "jobrun-1",
        attempt: 1,
        outputDigest: "sha256:heart",
        at: "2026-06-28T17:00:03.000Z",
      },
    });

    expect(store.replayState().runs["jobrun-1"]).toMatchObject({
      status: "delivering",
      outputDigest: "sha256:heart",
    });
  });

  test("writes and replays from snapshots", () => {
    const store = createInMemoryTaskWorkflowEventStore();
    store.appendEvent({
      eventId: "evt-trigger",
      event: {
        type: "task_triggered",
        taskId: "task-heart",
        jobRunId: "jobrun-1",
        triggerKey: "task-heart:manual:req-1",
        source: "manual",
        at: "2026-06-28T17:00:00.000Z",
      },
    });
    const snapshot = store.writeSnapshot({
      createdAt: "2026-06-28T17:00:01.000Z",
    });

    expect(store.getLatestSnapshot()).toEqual(snapshot);
    expect(store.replayState().runs["jobrun-1"]).toMatchObject({
      status: "created",
    });
  });

  test("keeps monotonic sequences and replay after compaction", () => {
    const store = createInMemoryTaskWorkflowEventStore();
    store.appendEvent({
      eventId: "evt-trigger-1",
      event: {
        type: "task_triggered",
        taskId: "task-heart",
        jobRunId: "jobrun-1",
        triggerKey: "task-heart:manual:req-1",
        source: "manual",
        at: "2026-06-28T17:00:00.000Z",
      },
    });
    store.appendEvent({
      eventId: "evt-trigger-2",
      event: {
        type: "task_triggered",
        taskId: "task-heart",
        jobRunId: "jobrun-2",
        triggerKey: "task-heart:manual:req-2",
        source: "manual",
        at: "2026-06-28T17:01:00.000Z",
      },
    });
    store.writeSnapshot();
    store.compactEventsThroughSnapshot();

    const appended = store.appendEvent({
      eventId: "evt-trigger-3",
      event: {
        type: "task_triggered",
        taskId: "task-heart",
        jobRunId: "jobrun-3",
        triggerKey: "task-heart:manual:req-3",
        source: "manual",
        at: "2026-06-28T17:02:00.000Z",
      },
    });

    expect(appended.sequence).toBe(3);
    expect(Object.keys(store.replayState().runs).sort()).toEqual([
      "jobrun-1",
      "jobrun-2",
      "jobrun-3",
    ]);
  });

  test("prunes superseded snapshots during compaction", () => {
    const store = createInMemoryTaskWorkflowEventStore();
    for (const runId of ["jobrun-1", "jobrun-2", "jobrun-3"]) {
      store.appendEvent({
        eventId: `evt-trigger-${runId}`,
        event: {
          type: "task_triggered",
          taskId: "task-heart",
          jobRunId: runId,
          triggerKey: `task-heart:manual:${runId}`,
          source: "manual",
          at: "2026-06-28T17:00:00.000Z",
        },
      });
      store.writeSnapshot();
    }

    expect(store.compactEventsThroughSnapshot()).toEqual({
      compactedThroughSequence: 3,
      deletedEvents: 3,
      deletedSnapshots: 2,
    });
    expect(store.getLatestSnapshot()?.sequence).toBe(3);
    expect(Object.keys(store.replayState().runs).sort()).toEqual([
      "jobrun-1",
      "jobrun-2",
      "jobrun-3",
    ]);
  });

  test("does not compact past a real snapshot sequence", () => {
    const store = createInMemoryTaskWorkflowEventStore();
    store.appendEvent({
      eventId: "evt-trigger-1",
      event: {
        type: "task_triggered",
        taskId: "task-heart",
        jobRunId: "jobrun-1",
        triggerKey: "task-heart:manual:req-1",
        source: "manual",
        at: "2026-06-28T17:00:00.000Z",
      },
    });
    store.writeSnapshot();
    store.appendEvent({
      eventId: "evt-trigger-2",
      event: {
        type: "task_triggered",
        taskId: "task-heart",
        jobRunId: "jobrun-2",
        triggerKey: "task-heart:manual:req-2",
        source: "manual",
        at: "2026-06-28T17:01:00.000Z",
      },
    });

    expect(
      store.compactEventsThroughSnapshot({ snapshotSequence: 999 }),
    ).toEqual({
      compactedThroughSequence: 1,
      deletedEvents: 1,
      deletedSnapshots: 0,
    });
    expect(store.listEvents().map((event) => event.eventId)).toEqual([
      "evt-trigger-2",
    ]);
  });

  test("rejects snapshots past the latest known event sequence", () => {
    const store = createInMemoryTaskWorkflowEventStore();
    store.appendEvent({
      eventId: "evt-trigger-1",
      event: {
        type: "task_triggered",
        taskId: "task-heart",
        jobRunId: "jobrun-1",
        triggerKey: "task-heart:manual:req-1",
        source: "manual",
        at: "2026-06-28T17:00:00.000Z",
      },
    });

    expect(() => store.writeSnapshot({ sequence: 100 })).toThrow(
      "future sequence 100",
    );
  });

  test("supports destructured read methods", () => {
    const store = createInMemoryTaskWorkflowEventStore();
    store.appendEvent({
      eventId: "evt-trigger",
      event: {
        type: "task_triggered",
        taskId: "task-heart",
        jobRunId: "jobrun-1",
        triggerKey: "task-heart:manual:req-1",
        source: "manual",
        at: "2026-06-28T17:00:00.000Z",
      },
    });

    const { replayState, listResumableRuns, listSideEffectFailures } = store;

    expect(replayState().runs["jobrun-1"]).toMatchObject({
      status: "created",
    });
    expect(listResumableRuns()).toHaveLength(1);
    expect(listSideEffectFailures()).toEqual([]);
  });

  test("lists non-terminal runs as resumable", () => {
    const store = createInMemoryTaskWorkflowEventStore();
    store.appendEvent({
      eventId: "evt-running",
      event: {
        type: "task_triggered",
        taskId: "task-running",
        jobRunId: "jobrun-running",
        triggerKey: "task-running:manual:req-1",
        source: "manual",
        at: "2026-06-28T17:00:00.000Z",
      },
    });
    store.appendEvent({
      eventId: "evt-done-trigger",
      event: {
        type: "task_triggered",
        taskId: "task-done",
        jobRunId: "jobrun-done",
        triggerKey: "task-done:manual:req-1",
        source: "manual",
        at: "2026-06-28T17:01:00.000Z",
      },
    });
    store.appendEvent({
      eventId: "evt-done-validation-passed",
      event: {
        type: "validation_passed",
        taskId: "task-done",
        jobRunId: "jobrun-done",
        at: "2026-06-28T17:01:01.000Z",
      },
    });
    store.appendEvent({
      eventId: "evt-done-attempt-started",
      event: {
        type: "attempt_started",
        taskId: "task-done",
        jobRunId: "jobrun-done",
        attempt: 1,
        mode: "agent",
        at: "2026-06-28T17:01:02.000Z",
      },
    });
    store.appendEvent({
      eventId: "evt-done-attempt-succeeded",
      event: {
        type: "attempt_succeeded",
        taskId: "task-done",
        jobRunId: "jobrun-done",
        attempt: 1,
        outputDigest: "sha256:done",
        at: "2026-06-28T17:01:03.000Z",
      },
    });
    store.appendEvent({
      eventId: "evt-done-delivery-started",
      event: {
        type: "delivery_started",
        taskId: "task-done",
        jobRunId: "jobrun-done",
        deliveryKey: "jobrun-done:route:sha256:done",
        at: "2026-06-28T17:01:04.000Z",
      },
    });
    store.appendEvent({
      eventId: "evt-done-success",
      event: {
        type: "delivery_succeeded",
        taskId: "task-done",
        jobRunId: "jobrun-done",
        deliveryKey: "jobrun-done:route:sha256:done",
        at: "2026-06-28T17:01:05.000Z",
      },
    });

    expect(
      store.listResumableRuns().map((run) => ({
        jobRunId: run.jobRunId,
        status: run.status,
      })),
    ).toEqual([
      {
        jobRunId: "jobrun-running",
        status: "created",
      },
    ]);
  });

  test("lists side-effect failures for escalation consumers", () => {
    const store = createInMemoryTaskWorkflowEventStore();
    store.appendEvent({
      eventId: "evt-notify-failed",
      event: {
        type: "side_effect_failed",
        taskId: "task-heart",
        jobRunId: "jobrun-1",
        commandType: "notify_failure",
        failureClass: "handler_failed",
        reason: "Slack delivery failed",
        at: "2026-06-28T17:00:04.000Z",
      },
    });
    store.appendEvent({
      eventId: "evt-pause-failed",
      event: {
        type: "side_effect_failed",
        taskId: "task-prs",
        commandType: "pause_task",
        reason: "Scheduler update failed",
        at: "2026-06-28T17:00:05.000Z",
      },
    });

    expect(
      store.listSideEffectFailures({ commandType: "notify_failure" }),
    ).toEqual([
      {
        failureId:
          "notify_failure:task-heart:jobrun-1:handler_failed:2026-06-28T17:00:04.000Z",
        taskId: "task-heart",
        jobRunId: "jobrun-1",
        commandType: "notify_failure",
        failureClass: "handler_failed",
        reason: "Slack delivery failed",
        at: "2026-06-28T17:00:04.000Z",
      },
    ]);
  });
});
