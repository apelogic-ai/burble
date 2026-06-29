import { Database } from "bun:sqlite";
import type {
  TaskWorkflowEvent,
  TaskWorkflowSideEffectFailure,
  TaskWorkflowState,
} from "./task-workflow";
import type {
  TaskWorkflowAppendEventInput,
  TaskWorkflowCompactEventsResult,
  TaskWorkflowEventStore,
  TaskWorkflowSnapshot,
  TaskWorkflowStoredEvent,
  TaskWorkflowWriteSnapshotInput,
} from "./task-workflow-store";
import {
  buildTaskWorkflowSnapshotState,
  assertTaskWorkflowSnapshotSequenceKnown,
  compactableSnapshotSequence,
  listTaskWorkflowSideEffectFailures,
  replayTaskWorkflowStateFromSnapshot,
  selectTaskWorkflowResumableRuns,
} from "./task-workflow-store";

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

type TaskWorkflowEventIdRow = {
  sequence: number;
  eventId: string;
  recordedAt: string;
  signalId: string | null;
  eventJson: string | null;
};

export const TASK_WORKFLOW_SQLITE_SCHEMA_VERSION = 5;

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
  const insertEventId = db.query<
    null,
    [string, number, string, string | null, string | null]
  >(`
    INSERT OR IGNORE INTO task_workflow_event_ids (
      event_id,
      sequence,
      recorded_at,
      signal_id,
      event_json
    )
    VALUES (?, ?, ?, ?, ?)
  `);
  const getEventId = db.query<TaskWorkflowEventIdRow, [string]>(`
    SELECT
      event_id as eventId,
      sequence,
      recorded_at as recordedAt,
      signal_id as signalId,
      event_json as eventJson
    FROM task_workflow_event_ids
    WHERE event_id = ?
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
  const listStoredEventsBySignalId = db.query<TaskWorkflowEventRow, [string]>(`
    SELECT
      sequence,
      event_id as eventId,
      event_json as eventJson,
      recorded_at as recordedAt,
      signal_id as signalId
    FROM task_workflow_events
    WHERE signal_id = ?
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
  const getLatestSnapshotThroughSequence = db.query<
    TaskWorkflowSnapshotRow,
    [number]
  >(`
    SELECT
      sequence,
      state_json as stateJson,
      created_at as createdAt
    FROM task_workflow_snapshots
    WHERE sequence <= ?
    ORDER BY sequence DESC
    LIMIT 1
  `);
  const getLatestSnapshotSequence = db.query<{ sequence: number | null }, []>(`
    SELECT max(sequence) as sequence
    FROM task_workflow_snapshots
  `);
  const deleteEventsThroughSequence = db.query<never, [number]>(`
    DELETE FROM task_workflow_events
    WHERE sequence <= ?
  `);
  const updateEventIdPayloadsThroughSequence = db.query<never, [number]>(`
    UPDATE task_workflow_event_ids
    SET
      signal_id = COALESCE(
        task_workflow_event_ids.signal_id,
        (
          SELECT task_workflow_events.signal_id
          FROM task_workflow_events
          WHERE task_workflow_events.event_id = task_workflow_event_ids.event_id
        )
      ),
      event_json = (
        SELECT task_workflow_events.event_json
        FROM task_workflow_events
        WHERE task_workflow_events.event_id = task_workflow_event_ids.event_id
      )
    WHERE
      sequence <= ?
      AND event_json IS NULL
      AND EXISTS (
        SELECT 1
        FROM task_workflow_events
        WHERE task_workflow_events.event_id = task_workflow_event_ids.event_id
      )
  `);
  const deleteSnapshotsBeforeSequence = db.query<never, [number]>(`
    DELETE FROM task_workflow_snapshots
    WHERE sequence < ?
  `);

  const listEvents = (listInput?: {
    signalId?: string;
  }): TaskWorkflowStoredEvent[] =>
    (listInput?.signalId
      ? listStoredEventsBySignalId.all(listInput.signalId)
      : listStoredEvents.all()
    ).map(rowToStoredEvent);
  const replayState = (
    replayInput?: Parameters<TaskWorkflowEventStore["replayState"]>[0],
  ): TaskWorkflowState =>
    replayTaskWorkflowStateFromSnapshot({
      events: listEvents(),
      snapshot: getLatestSnapshot(),
      initialConfig: replayInput?.initialConfig,
    });
  const getLatestSnapshot = (): TaskWorkflowSnapshot | null => {
    const row = getLatestSnapshotRow.get();
    return row ? rowToSnapshot(row) : null;
  };
  const getSnapshotAtOrBefore = (
    sequence: number,
  ): TaskWorkflowSnapshot | null => {
    const row = getLatestSnapshotThroughSequence.get(sequence);
    return row ? rowToSnapshot(row) : null;
  };
  const buildSnapshot: TaskWorkflowEventStore["buildSnapshot"] = (
    snapshotInput,
  ) => {
    const latestSnapshot = getLatestSnapshot();
    const latestKnownSequence = Math.max(
      getLatestEventSequence.get()?.sequence ?? 0,
      latestSnapshot?.sequence ?? 0,
    );
    const sequence = snapshotInput?.sequence ?? latestKnownSequence;
    assertTaskWorkflowSnapshotSequenceKnown(sequence, latestKnownSequence);
    const baseSnapshot = getSnapshotAtOrBefore(sequence);
    const events = baseSnapshot
      ? listStoredEventsAfterSequence
          .all(baseSnapshot.sequence)
          .filter((event) => event.sequence <= sequence)
          .map(rowToStoredEvent)
      : listStoredEventsThroughSequence.all(sequence).map(rowToStoredEvent);
    return {
      sequence,
      state: buildTaskWorkflowSnapshotState({
        events,
        sequence,
        baseSnapshot,
      }),
    };
  };
  const writeSnapshot = (
    snapshotInput?: TaskWorkflowWriteSnapshotInput,
  ): TaskWorkflowSnapshot => {
    const builtSnapshot = buildSnapshot({ sequence: snapshotInput?.sequence });
    const state = snapshotInput?.state ?? builtSnapshot.state;
    const row = upsertSnapshot.get(
      builtSnapshot.sequence,
      JSON.stringify(state),
      snapshotInput?.createdAt ?? now().toISOString(),
    );
    if (!row) {
      throw new Error(
        `Failed to write task workflow snapshot at sequence ${builtSnapshot.sequence}`,
      );
    }
    return rowToSnapshot(row);
  };
  const compactEventsThroughSnapshot = (compactInput?: {
    snapshotSequence?: number;
  }): TaskWorkflowCompactEventsResult => {
    const sequence = compactableSnapshotSequence(
      getLatestSnapshotSequence.get()?.sequence ?? 0,
      compactInput?.snapshotSequence,
    );
    return runSqliteSavepoint(db, "task_workflow_compaction", () => {
      updateEventIdPayloadsThroughSequence.run(sequence);
      const result = deleteEventsThroughSequence.run(sequence);
      const deletedSnapshots =
        deleteSnapshotsBeforeSequence.run(sequence).changes;
      return {
        compactedThroughSequence: sequence,
        deletedEvents: result.changes,
        deletedSnapshots,
      };
    });
  };
  const listResumableRuns = (listInput?: {
    state?: TaskWorkflowState;
  }) => {
    const state = listInput?.state ?? replayState();
    return selectTaskWorkflowResumableRuns(state);
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
      const existingEventId = getEventId.get(appendInput.eventId);
      if (existingEventId) {
        const existingEvent = getEventById.get(appendInput.eventId);
        if (existingEvent) {
          return rowToStoredEvent(existingEvent);
        }
        if (!existingEventId.eventJson) {
          throw new Error(
            `Cannot reconstruct compacted task workflow event ${appendInput.eventId}; event payload was not preserved in the idempotency ledger`,
          );
        }
        return {
          sequence: existingEventId.sequence,
          eventId: existingEventId.eventId,
          event: JSON.parse(existingEventId.eventJson) as TaskWorkflowEvent,
          recordedAt: existingEventId.recordedAt,
          ...(existingEventId.signalId
            ? { signalId: existingEventId.signalId }
            : appendInput.signalId
              ? { signalId: appendInput.signalId }
              : {}),
        };
      }

      const recordedAt = appendInput.recordedAt ?? now().toISOString();
      const eventJson = JSON.stringify(appendInput.event);
      const inserted = insertEvent.get(
        appendInput.eventId,
        appendInput.signalId ?? null,
        eventJson,
        recordedAt,
      );
      const row = inserted ?? getEventById.get(appendInput.eventId);
      if (!row) {
        throw new Error(
          `Failed to append task workflow event ${appendInput.eventId}`,
        );
      }
      const stored = rowToStoredEvent(row);
      insertEventId.run(
        stored.eventId,
        stored.sequence,
        stored.recordedAt,
        null,
        null,
      );
      return stored;
    },
    listEvents,
    replayState,
    buildSnapshot,
    writeSnapshot,
    getLatestSnapshot,
    compactEventsThroughSnapshot,
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
  if (version >= TASK_WORKFLOW_SQLITE_SCHEMA_VERSION) {
    return;
  }

  runSqliteSavepoint(db, "task_workflow_schema_migration", () => {
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

    if (version < 3) {
      db.exec(`
      CREATE TABLE IF NOT EXISTS task_workflow_event_ids (
        event_id TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL,
        recorded_at TEXT NOT NULL,
        signal_id TEXT,
        event_json TEXT
      );

      INSERT OR IGNORE INTO task_workflow_event_ids (
        event_id,
        sequence,
        recorded_at,
        signal_id,
        event_json
      )
      SELECT
        event_id,
        sequence,
        recorded_at,
        signal_id,
        NULL
      FROM task_workflow_events;

      PRAGMA user_version = 3;
    `);
    }

    if (version < 4) {
      if (!sqliteTableHasColumn(db, "task_workflow_event_ids", "signal_id")) {
        db.exec("ALTER TABLE task_workflow_event_ids ADD COLUMN signal_id TEXT");
      }
      if (!sqliteTableHasColumn(db, "task_workflow_event_ids", "event_json")) {
        db.exec("ALTER TABLE task_workflow_event_ids ADD COLUMN event_json TEXT");
      }
      db.exec(`
      UPDATE task_workflow_event_ids
      SET
        signal_id = (
          SELECT task_workflow_events.signal_id
          FROM task_workflow_events
          WHERE task_workflow_events.event_id = task_workflow_event_ids.event_id
        ),
        event_json = (
          SELECT task_workflow_events.event_json
          FROM task_workflow_events
          WHERE task_workflow_events.event_id = task_workflow_event_ids.event_id
        )
      WHERE EXISTS (
        SELECT 1
        FROM task_workflow_events
        WHERE task_workflow_events.event_id = task_workflow_event_ids.event_id
      );

      PRAGMA user_version = 4;
    `);
    }

    if (version < 5) {
      db.exec(`
      UPDATE task_workflow_event_ids
      SET
        signal_id = NULL,
        event_json = NULL
      WHERE EXISTS (
        SELECT 1
        FROM task_workflow_events
        WHERE task_workflow_events.event_id = task_workflow_event_ids.event_id
      );

      PRAGMA user_version = 5;
    `);
    }
  });
}

function readSchemaVersion(db: Database): number {
  const row = db
    .query<{ user_version: number }, []>("PRAGMA user_version")
    .get();
  return row?.user_version ?? 0;
}

function sqliteTableHasColumn(
  db: Database,
  tableName: string,
  columnName: string,
): boolean {
  return db
    .query<{ name: string }, []>(`PRAGMA table_info(${tableName})`)
    .all()
    .some((column) => column.name === columnName);
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

function runSqliteSavepoint<T>(
  db: Database,
  name: string,
  operation: () => T,
): T {
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = operation();
    db.exec(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
    db.exec(`RELEASE SAVEPOINT ${name}`);
    throw error;
  }
}
