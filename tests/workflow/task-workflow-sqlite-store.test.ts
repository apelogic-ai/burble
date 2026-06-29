import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  TASK_WORKFLOW_SQLITE_SCHEMA_VERSION,
  createSqliteTaskWorkflowEventStore,
} from "../../src/workflow/task-workflow-sqlite-store";

describe("SQLite task workflow event store", () => {
  test("sets an explicit schema version", () => {
    const db = new Database(":memory:");
    createSqliteTaskWorkflowEventStore(db);

    const row = db
      .query<{ user_version: number }, []>("PRAGMA user_version")
      .get();

    expect(row?.user_version).toBe(TASK_WORKFLOW_SQLITE_SCHEMA_VERSION);
    db.close();
  });

  test("appends events idempotently by event id", () => {
    const db = new Database(":memory:");
    const store = createSqliteTaskWorkflowEventStore(db, {
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

    expect(second).toEqual(first);
    expect(store.listEvents()).toEqual([
      {
        sequence: 1,
        eventId: "evt-1",
        event: input.event,
        recordedAt: "2026-06-28T17:00:00.000Z",
        signalId: "manual:req-1",
      },
    ]);
    db.close();
  });

  test("replays workflow state after reopening the database", () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "burble-workflow-store-")),
      "workflow.sqlite",
    );
    let db = new Database(path);
    let store = createSqliteTaskWorkflowEventStore(db);
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
    store.appendEvent({
      eventId: "evt-validation-passed",
      event: {
        type: "validation_passed",
        taskId: "task-heart",
        jobRunId: "jobrun-1",
        at: "2026-06-28T17:00:01.000Z",
      },
    });
    db.close();

    db = new Database(path);
    store = createSqliteTaskWorkflowEventStore(db);

    expect(store.replayState().runs["jobrun-1"]).toMatchObject({
      status: "running",
      taskId: "task-heart",
    });
    expect(store.listResumableRuns()).toHaveLength(1);
    db.close();
  });

  test("supports destructured read methods", () => {
    const db = new Database(":memory:");
    const store = createSqliteTaskWorkflowEventStore(db);
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
    db.close();
  });

  test("lists side-effect failures after reopening the database", () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "burble-workflow-store-")),
      "workflow.sqlite",
    );
    let db = new Database(path);
    let store = createSqliteTaskWorkflowEventStore(db);
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
    db.close();

    db = new Database(path);
    store = createSqliteTaskWorkflowEventStore(db);

    expect(store.listSideEffectFailures()).toEqual([
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
    db.close();
  });
});
