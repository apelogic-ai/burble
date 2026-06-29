import { Database } from "bun:sqlite";
import {
  createInitialTaskWorkflowState,
  reduceTaskWorkflowEvents,
  type TaskWorkflowEvent,
  type TaskWorkflowRunState,
  type TaskWorkflowState,
} from "./task-workflow";
import type {
  TaskWorkflowAppendEventInput,
  TaskWorkflowEventStore,
  TaskWorkflowStoredEvent,
} from "./task-workflow-store";
import { listTaskWorkflowSideEffectFailures } from "./task-workflow-store";

type TaskWorkflowEventRow = {
  sequence: number;
  eventId: string;
  eventJson: string;
  recordedAt: string;
  signalId: string | null;
};

export function createSqliteTaskWorkflowEventStore(
  db: Database,
  input?: { now?: () => Date },
): TaskWorkflowEventStore {
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
  `);

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
    listEvents() {
      return listStoredEvents.all().map(rowToStoredEvent);
    },
    replayState(replayInput) {
      return reduceTaskWorkflowEvents(
        this.listEvents().map((event) => event.event),
        replayInput?.initialState ?? createInitialTaskWorkflowState(),
      );
    },
    listResumableRuns(listInput) {
      const state = listInput?.state ?? this.replayState();
      return Object.values(state.runs).filter(isResumableRun);
    },
    listSideEffectFailures(listInput) {
      const state = listInput?.state ?? this.replayState();
      return listTaskWorkflowSideEffectFailures(state, listInput);
    },
  };
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

function isResumableRun(run: TaskWorkflowRunState): boolean {
  return (
    run.status === "created" ||
    run.status === "validating" ||
    run.status === "running" ||
    run.status === "delivering"
  );
}
