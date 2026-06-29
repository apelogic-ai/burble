import { Database } from "bun:sqlite";
import {
  createInitialTaskWorkflowState,
  reduceTaskWorkflowEvents,
  type TaskWorkflowEvent,
  type TaskWorkflowRunState,
  type TaskWorkflowSideEffectFailure,
  type TaskWorkflowState,
} from "./task-workflow";
import type {
  TaskWorkflowAppendEventInput,
  TaskWorkflowEventStore,
  TaskWorkflowSnapshot,
  TaskWorkflowStoredEvent,
  TaskWorkflowWriteSnapshotInput,
} from "./task-workflow-store";
import { listTaskWorkflowSideEffectFailures } from "./task-workflow-store";

type TaskWorkflowEventRow = {
  sequence: number;
  eventId: string;
  eventJson: string;
  recordedAt: string;
  signalId: string | null;
};

type TaskWorkflowSnapshotRow = {
  sequence: number;
  stateJson: string;
  createdAt: string;
};

export const TASK_WORKFLOW_SQLITE_SCHEMA_VERSION = 2;

export function createSqliteTaskWorkflowEventStore(
  db: Database,
  input?: { now?: () => Date },
): TaskWorkflowEventStore {
  migrateTaskWorkflowSchema(db);

  const now = input?.now ?? (() => new Date());
  const insertEvent = db.query<
    TaskWorkflowEventRow,
    [string, string | null, string, string]
  >(`
    INSERT OR IGNORE INTO task_workflow_events (
      event_id,
      signal_id,
      event_json,
      recorded_at
    )
    VALUES (?, ?, ?, ?)
    RETURNING
      sequence,
      event_id as eventId,
      event_json as eventJson,
      recorded_at as recordedAt,
      signal_id as signalId
  `);
  const getEventById = db.query<TaskWorkflowEventRow, [string]>(`
    SELECT
      sequence,
      event_id as eventId,
      event_json as eventJson,
      recorded_at as recordedAt,
      signal_id as signalId
    FROM task_workflow_events
    WHERE event_id = ?
  `);
  const listStoredEvents = db.query<TaskWorkflowEventRow, []>(`
    SELECT
      sequence,
      event_id as eventId,
      event_json as eventJson,
      recorded_at as recordedAt,
      signal_id as signalId
    FROM task_workflow_events
    ORDER BY sequence ASC
  `);
  const listStoredEventsAfterSequence = db.query<TaskWorkflowEventRow, [number]>(`
    SELECT
      sequence,
      event_id as eventId,
      event_json as eventJson,
      recorded_at as recordedAt,
      signal_id as signalId
    FROM task_workflow_events
    WHERE sequence > ?
    ORDER BY sequence ASC
  `);
  const listStoredEventsThroughSequence = db.query<TaskWorkflowEventRow, [number]>(`
    SELECT
      sequence,
      event_id as eventId,
      event_json as eventJson,
      recorded_at as recordedAt,
      signal_id as signalId
    FROM task_workflow_events
    WHERE sequence <= ?
    ORDER BY sequence ASC
  `);
  const getLatestEventSequence = db.query<{ sequence: number | null }, []>(`
    SELECT max(sequence) as sequence
    FROM task_workflow_events
  `);
  const upsertSnapshot = db.query<
    TaskWorkflowSnapshotRow,
    [number, string, string]
  >(`
    INSERT INTO task_workflow_snapshots (
      sequence,
      state_json,
      created_at
    )
    VALUES (?, ?, ?)
    ON CONFLICT(sequence) DO UPDATE SET
      state_json = excluded.state_json,
      created_at = excluded.created_at
    RETURNING
      sequence,
      state_json as stateJson,
      created_at as createdAt
  `);
  const getLatestSnapshotRow = db.query<TaskWorkflowSnapshotRow, []>(`
    SELECT
      sequence,
      state_json as stateJson,
      created_at as createdAt
    FROM task_workflow_snapshots
    ORDER BY sequence DESC
    LIMIT 1
  `);

  const listEvents = (): TaskWorkflowStoredEvent[] =>
    listStoredEvents.all().map(rowToStoredEvent);
  const replayState = (replayInput?: {
    initialState?: TaskWorkflowState;
  }): TaskWorkflowState => {
    if (replayInput?.initialState) {
      return reduceTaskWorkflowEvents(
        listEvents().map((event) => event.event),
        replayInput.initialState,
      );
    }

    const snapshot = getLatestSnapshot();
    const events = snapshot
      ? listStoredEventsAfterSequence.all(snapshot.sequence)
      : listStoredEvents.all();
    return reduceTaskWorkflowEvents(
      events.map((event) => rowToStoredEvent(event).event),
      snapshot?.state ?? createInitialTaskWorkflowState(),
    );
  };
  const getLatestSnapshot = (): TaskWorkflowSnapshot | null => {
    const row = getLatestSnapshotRow.get();
    return row ? rowToSnapshot(row) : null;
  };
  const writeSnapshot = (
    snapshotInput?: TaskWorkflowWriteSnapshotInput,
  ): TaskWorkflowSnapshot => {
    const sequence =
      snapshotInput?.sequence ?? getLatestEventSequence.get()?.sequence ?? 0;
    const state =
      snapshotInput?.state ??
      reduceTaskWorkflowEvents(
        listStoredEventsThroughSequence
          .all(sequence)
          .map((event) => rowToStoredEvent(event).event),
      );
    const row = upsertSnapshot.get(
      sequence,
      JSON.stringify(state),
      snapshotInput?.createdAt ?? now().toISOString(),
    );
    if (!row) {
      throw new Error(
        `Failed to write task workflow snapshot at sequence ${sequence}`,
      );
    }
    return rowToSnapshot(row);
  };
  const listResumableRuns = (listInput?: {
    state?: TaskWorkflowState;
  }): TaskWorkflowRunState[] => {
    const state = listInput?.state ?? replayState();
    return Object.values(state.runs).filter(isResumableRun);
  };
  const listSideEffectFailures = (listInput?: {
    state?: TaskWorkflowState;
    taskId?: string;
    commandType?: TaskWorkflowSideEffectFailure["commandType"];
  }) => {
    const state = listInput?.state ?? replayState();
    return listTaskWorkflowSideEffectFailures(state, listInput);
  };

  return {
    appendEvent(appendInput) {
      const recordedAt = appendInput.recordedAt ?? now().toISOString();
      const inserted = insertEvent.get(
        appendInput.eventId,
        appendInput.signalId ?? null,
        JSON.stringify(appendInput.event),
        recordedAt,
      );
      const row = inserted ?? getEventById.get(appendInput.eventId);
      if (!row) {
        throw new Error(
          `Failed to append task workflow event ${appendInput.eventId}`,
        );
      }
      return rowToStoredEvent(row);
    },
    listEvents,
    replayState,
    writeSnapshot,
    getLatestSnapshot,
    listResumableRuns,
    listSideEffectFailures,
  };
}

function migrateTaskWorkflowSchema(db: Database): void {
  const version = readSchemaVersion(db);
  if (version > TASK_WORKFLOW_SQLITE_SCHEMA_VERSION) {
    throw new Error(
      `Task workflow SQLite schema version ${version} is newer than supported version ${TASK_WORKFLOW_SQLITE_SCHEMA_VERSION}`,
    );
  }

  if (version < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_workflow_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        signal_id TEXT,
        event_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_task_workflow_events_signal
        ON task_workflow_events (signal_id, sequence);

      PRAGMA user_version = 1;
    `);
  }

  if (version < 2) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_workflow_snapshots (
        sequence INTEGER PRIMARY KEY,
        state_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      PRAGMA user_version = 2;
    `);
  }
}

function readSchemaVersion(db: Database): number {
  const row = db
    .query<{ user_version: number }, []>("PRAGMA user_version")
    .get();
  return row?.user_version ?? 0;
}

function rowToStoredEvent(row: TaskWorkflowEventRow): TaskWorkflowStoredEvent {
  return {
    sequence: row.sequence,
    eventId: row.eventId,
    event: JSON.parse(row.eventJson) as TaskWorkflowEvent,
    recordedAt: row.recordedAt,
    ...(row.signalId ? { signalId: row.signalId } : {}),
  };
}

function rowToSnapshot(row: TaskWorkflowSnapshotRow): TaskWorkflowSnapshot {
  return {
    sequence: row.sequence,
    state: JSON.parse(row.stateJson) as TaskWorkflowState,
    createdAt: row.createdAt,
  };
}

function isResumableRun(run: TaskWorkflowRunState): boolean {
  return (
    run.status === "created" ||
    run.status === "validating" ||
    run.status === "running" ||
    run.status === "delivering"
  );
}
