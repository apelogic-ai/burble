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
});
