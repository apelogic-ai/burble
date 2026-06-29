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
      deletedSnapshots: 0,
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

  test("folds the prior snapshot when writing a later snapshot after compaction", () => {
    const db = new Database(":memory:");
    const store = createSqliteTaskWorkflowEventStore(db);
    for (const runId of ["jobrun-1", "jobrun-2"]) {
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
    }
    store.writeSnapshot();
    store.compactEventsThroughSnapshot();
    store.appendEvent({
      eventId: "evt-trigger-jobrun-3",
      event: {
        type: "task_triggered",
        taskId: "task-heart",
        jobRunId: "jobrun-3",
        triggerKey: "task-heart:manual:jobrun-3",
        source: "manual",
        at: "2026-06-28T17:02:00.000Z",
      },
    });

    const snapshot = store.writeSnapshot();

    expect(snapshot.sequence).toBe(3);
    expect(Object.keys(snapshot.state.runs).sort()).toEqual([
      "jobrun-1",
      "jobrun-2",
      "jobrun-3",
    ]);
    expect(Object.keys(store.replayState().runs).sort()).toEqual([
      "jobrun-1",
      "jobrun-2",
      "jobrun-3",
    ]);
    db.close();
  });

  test("does not compact past a real snapshot sequence", () => {
    const db = new Database(":memory:");
    const store = createSqliteTaskWorkflowEventStore(db);
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
    db.close();
  });

  test("replay with initial config still folds snapshots after compaction", () => {
    const db = new Database(":memory:");
    const store = createSqliteTaskWorkflowEventStore(db);
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
    store.compactEventsThroughSnapshot();

    const state = store.replayState({
      initialConfig: {
        failurePauseThreshold: 7,
      },
    });

    expect(state.failurePauseThreshold).toBe(7);
    expect(Object.keys(state.runs)).toEqual(["jobrun-1"]);
    db.close();
  });

  test("stores compacted event payloads in the ledger only at compaction time", () => {
    const db = new Database(":memory:");
    const store = createSqliteTaskWorkflowEventStore(db);
    const original = store.appendEvent({
      eventId: "evt-trigger",
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

    expect(
      db
        .query<{ event_json: string | null }, []>(
          "SELECT event_json FROM task_workflow_event_ids",
        )
        .get()?.event_json,
    ).toBeNull();

    store.writeSnapshot();
    store.compactEventsThroughSnapshot();

    expect(
      db
        .query<{ event_json: string | null }, []>(
          "SELECT event_json FROM task_workflow_event_ids",
        )
        .get()?.event_json,
    ).toContain("jobrun-1");

    const duplicate = store.appendEvent({
      eventId: "evt-trigger",
      event: {
        type: "task_triggered",
        taskId: "different-task",
        jobRunId: "different-run",
        triggerKey: "different",
        source: "manual",
        at: "2026-06-28T18:00:00.000Z",
      },
    });

    expect(duplicate).toEqual(original);
    db.close();
  });

  test("prunes superseded snapshots during compaction", () => {
    const db = new Database(":memory:");
    const store = createSqliteTaskWorkflowEventStore(db);
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
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT count(*) as count FROM task_workflow_snapshots",
        )
        .get()?.count,
    ).toBe(1);
    expect(store.getLatestSnapshot()?.sequence).toBe(3);
    expect(Object.keys(store.replayState().runs).sort()).toEqual([
      "jobrun-1",
      "jobrun-2",
      "jobrun-3",
    ]);
    db.close();
  });

  test("rejects snapshots past the latest known event sequence", () => {
    const db = new Database(":memory:");
    const store = createSqliteTaskWorkflowEventStore(db);
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
    db.close();
  });

  test("dedup after compaction returns the original stored event shape", () => {
    const db = new Database(":memory:");
    const store = createSqliteTaskWorkflowEventStore(db);
    const original = store.appendEvent({
      eventId: "evt-trigger",
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
    store.writeSnapshot();
    store.compactEventsThroughSnapshot();

    const duplicate = store.appendEvent({
      eventId: "evt-trigger",
      event: {
        type: "task_triggered",
        taskId: "different-task",
        jobRunId: "different-run",
        triggerKey: "different",
        source: "manual",
        at: "2026-06-28T18:00:00.000Z",
      },
    });

    expect(duplicate).toEqual(original);
    db.close();
  });

  test("migrates an existing v2 database to a live-event ledger", () => {
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
    expect(duplicate.signalId).toBeUndefined();
    expect(store.listEvents()).toHaveLength(1);
    expect(
      db
        .query<{ event_json: string | null }, []>(
          "SELECT event_json FROM task_workflow_event_ids",
        )
        .get()?.event_json,
    ).toBeNull();
    db.close();
  });

  test("fails closed for compacted legacy ledger rows without payloads", () => {
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
      CREATE TABLE task_workflow_event_ids (
        event_id TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL,
        recorded_at TEXT NOT NULL
      );
      INSERT INTO task_workflow_event_ids (
        event_id,
        sequence,
        recorded_at
      )
      VALUES (
        'evt-trigger',
        1,
        '2026-06-28T17:00:00.000Z'
      );
      PRAGMA user_version = 3;
    `);

    const store = createSqliteTaskWorkflowEventStore(db);

    expect(() =>
      store.appendEvent({
        eventId: "evt-trigger",
        event: {
          type: "task_triggered",
          taskId: "different-task",
          jobRunId: "different-run",
          triggerKey: "different",
          source: "manual",
          at: "2026-06-28T18:00:00.000Z",
        },
      }),
    ).toThrow("payload was not preserved");
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
