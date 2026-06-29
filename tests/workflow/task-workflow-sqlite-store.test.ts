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

  test("lists events by signal id", () => {
    const db = new Database(":memory:");
    const store = createSqliteTaskWorkflowEventStore(db);
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

  test("replays from a persisted snapshot plus later events", () => {
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

    const snapshot = store.writeSnapshot({
      createdAt: "2026-06-28T17:00:02.000Z",
    });
    expect(snapshot.sequence).toBe(2);
    expect(snapshot.state.runs["jobrun-1"]).toMatchObject({
      status: "running",
    });

    store.appendEvent({
      eventId: "evt-attempt-started",
      event: {
        type: "attempt_started",
        taskId: "task-heart",
        jobRunId: "jobrun-1",
        attempt: 1,
        mode: "agent",
        at: "2026-06-28T17:00:03.000Z",
      },
    });
    db.query("DELETE FROM task_workflow_events WHERE sequence <= ?").run(
      snapshot.sequence,
    );
    db.close();

    db = new Database(path);
    store = createSqliteTaskWorkflowEventStore(db);

    expect(store.getLatestSnapshot()?.sequence).toBe(2);
    expect(store.replayState().runs["jobrun-1"]).toMatchObject({
      status: "running",
      attempt: 1,
    });
    db.close();
  });

  test("compacts event payloads through a snapshot while preserving idempotency", () => {
    const db = new Database(":memory:");
    const store = createSqliteTaskWorkflowEventStore(db);
    const trigger = {
      eventId: "evt-trigger",
      event: {
        type: "task_triggered" as const,
        taskId: "task-heart",
        jobRunId: "jobrun-1",
        triggerKey: "task-heart:manual:req-1",
        source: "manual" as const,
        at: "2026-06-28T17:00:00.000Z",
      },
    };
    store.appendEvent(trigger);
    store.appendEvent({
      eventId: "evt-validation-passed",
      event: {
        type: "validation_passed",
        taskId: "task-heart",
        jobRunId: "jobrun-1",
        at: "2026-06-28T17:00:01.000Z",
      },
    });
    const snapshot = store.writeSnapshot();
    store.appendEvent({
      eventId: "evt-attempt-started",
      event: {
        type: "attempt_started",
        taskId: "task-heart",
        jobRunId: "jobrun-1",
        attempt: 1,
        mode: "agent",
        at: "2026-06-28T17:00:03.000Z",
      },
    });

    expect(store.compactEventsThroughSnapshot()).toEqual({
      compactedThroughSequence: snapshot.sequence,
      deletedEvents: 2,
    });
    expect(store.listEvents().map((event) => event.eventId)).toEqual([
      "evt-attempt-started",
    ]);
    expect(store.replayState().runs["jobrun-1"]).toMatchObject({
      status: "running",
      attempt: 1,
    });

    const duplicate = store.appendEvent(trigger);
    expect(duplicate.sequence).toBe(1);
    expect(store.listEvents().map((event) => event.eventId)).toEqual([
      "evt-attempt-started",
    ]);
    db.close();
  });

  test("backfills the event-id ledger when migrating an existing v2 database", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE task_workflow_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        signal_id TEXT,
        event_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );
      CREATE TABLE task_workflow_snapshots (
        sequence INTEGER PRIMARY KEY,
        state_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO task_workflow_events (
        event_id,
        signal_id,
        event_json,
        recorded_at
      )
      VALUES (
        'evt-trigger',
        NULL,
        '{"type":"task_triggered","taskId":"task-heart","jobRunId":"jobrun-1","triggerKey":"task-heart:manual:req-1","source":"manual","at":"2026-06-28T17:00:00.000Z"}',
        '2026-06-28T17:00:00.000Z'
      );
      PRAGMA user_version = 2;
    `);

    const store = createSqliteTaskWorkflowEventStore(db);
    db.query("DELETE FROM task_workflow_events WHERE event_id = ?").run(
      "evt-trigger",
    );

    const duplicate = store.appendEvent({
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

    expect(duplicate.sequence).toBe(1);
    expect(store.listEvents()).toEqual([]);
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
