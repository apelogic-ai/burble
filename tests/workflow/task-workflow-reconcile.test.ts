import { describe, expect, test } from "bun:test";
import { reconcileTaskWorkflowRuns } from "../../src/workflow/task-workflow-reconcile";
import { createInMemoryTaskWorkflowEventStore } from "../../src/workflow/task-workflow-store";

describe("task workflow reconciliation", () => {
  test("ingests stale heartbeated running attempts as attempt_failed events", () => {
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
      recordedAt: "2026-06-28T17:00:30.000Z",
      event: {
        type: "validation_passed",
        taskId: "task-heart",
        jobRunId: "jobrun-1",
        at: "2026-06-28T17:00:30.000Z",
      },
    });
    store.appendEvent({
      eventId: "evt-attempt-started",
      recordedAt: "2026-06-28T17:01:00.000Z",
      event: {
        type: "attempt_started",
        taskId: "task-heart",
        jobRunId: "jobrun-1",
        attempt: 1,
        mode: "agent",
        at: "2026-06-28T17:01:00.000Z",
      },
    });
    store.appendEvent({
      eventId: "evt-heartbeat",
      recordedAt: "2026-06-28T17:01:30.000Z",
      event: {
        type: "run_heartbeat",
        taskId: "task-heart",
        jobRunId: "jobrun-1",
        at: "2026-06-28T17:01:30.000Z",
      },
    });

    const result = reconcileTaskWorkflowRuns({
      store,
      now: new Date("2026-06-28T17:12:00.000Z"),
      staleAfterMs: 10 * 60 * 1000,
    });

    expect(result.events).toMatchObject([
      {
        eventId: "stale_run:jobrun-1",
        signalId: "stale_run:jobrun-1",
        event: {
          type: "attempt_failed",
          taskId: "task-heart",
          jobRunId: "jobrun-1",
          attempt: 1,
          failureClass: "stale_run_timeout",
        },
      },
    ]);
    expect(store.replayState().runs["jobrun-1"]).toMatchObject({
      status: "failed",
      failureClass: "stale_run_timeout",
      notificationPending: true,
    });
  });

  test("does not time out running attempts without heartbeat evidence", () => {
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
      recordedAt: "2026-06-28T17:00:30.000Z",
      event: {
        type: "validation_passed",
        taskId: "task-heart",
        jobRunId: "jobrun-1",
        at: "2026-06-28T17:00:30.000Z",
      },
    });
    store.appendEvent({
      eventId: "evt-attempt-started",
      recordedAt: "2026-06-28T17:01:00.000Z",
      event: {
        type: "attempt_started",
        taskId: "task-heart",
        jobRunId: "jobrun-1",
        attempt: 1,
        mode: "agent",
        at: "2026-06-28T17:01:00.000Z",
      },
    });

    expect(
      reconcileTaskWorkflowRuns({
        store,
        now: new Date("2026-06-28T17:30:00.000Z"),
        staleAfterMs: 10 * 60 * 1000,
      }),
    ).toEqual({ events: [] });
  });

  test("does not ingest events for fresh resumable runs", () => {
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

    expect(
      reconcileTaskWorkflowRuns({
        store,
        now: new Date("2026-06-28T17:09:59.000Z"),
        staleAfterMs: 10 * 60 * 1000,
      }),
    ).toEqual({ events: [] });
  });

  test("uses stable event ids so repeated reconciliation is idempotent", () => {
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

    const input = {
      store,
      now: new Date("2026-06-28T17:10:00.000Z"),
      staleAfterMs: 10 * 60 * 1000,
    };
    const first = reconcileTaskWorkflowRuns(input);
    const second = reconcileTaskWorkflowRuns(input);

    expect(first.events).toHaveLength(1);
    expect(second.events).toEqual([]);
    expect(store.listEvents().map((event) => event.eventId)).toEqual([
      "evt-trigger",
      "stale_run:jobrun-1",
    ]);
    expect(store.replayState().runs["jobrun-1"]).toMatchObject({
      status: "failed",
      failureClass: "stale_validation_timeout",
    });
  });

  test("does not pause tasks after repeated stale runtime timeouts", () => {
    const store = createInMemoryTaskWorkflowEventStore();
    for (const runId of ["jobrun-1", "jobrun-2"]) {
      store.appendEvent({
        eventId: `evt-trigger-${runId}`,
        recordedAt: "2026-06-28T17:00:00.000Z",
        event: {
          type: "task_triggered",
          taskId: "task-heart",
          jobRunId: runId,
          triggerKey: `task-heart:manual:${runId}`,
          source: "manual",
          at: "2026-06-28T17:00:00.000Z",
        },
      });
      store.appendEvent({
        eventId: `evt-validation-${runId}`,
        recordedAt: "2026-06-28T17:00:30.000Z",
        event: {
          type: "validation_passed",
          taskId: "task-heart",
          jobRunId: runId,
          at: "2026-06-28T17:00:30.000Z",
        },
      });
      store.appendEvent({
        eventId: `evt-attempt-${runId}`,
        recordedAt: "2026-06-28T17:01:00.000Z",
        event: {
          type: "attempt_started",
          taskId: "task-heart",
          jobRunId: runId,
          attempt: 1,
          mode: "agent",
          at: "2026-06-28T17:01:00.000Z",
        },
      });
      store.appendEvent({
        eventId: `evt-heartbeat-${runId}`,
        recordedAt: "2026-06-28T17:01:30.000Z",
        event: {
          type: "run_heartbeat",
          taskId: "task-heart",
          jobRunId: runId,
          at: "2026-06-28T17:01:30.000Z",
        },
      });
    }

    reconcileTaskWorkflowRuns({
      store,
      now: new Date("2026-06-28T17:12:00.000Z"),
      staleAfterMs: 10 * 60 * 1000,
    });

    const state = store.replayState({
      initialState: {
        failurePauseThreshold: 2,
        triggerKeys: {},
        failureCounts: {},
        tasks: {},
        runs: {},
      },
    });
    expect(state.failureCounts["task-heart:stale_run_timeout"]).toBeUndefined();
    expect(state.tasks["task-heart"]).toEqual({ status: "active" });
  });
});
