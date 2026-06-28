import {
  createInitialTaskWorkflowState,
  reduceTaskWorkflowEvents,
  type TaskWorkflowEvent,
  type TaskWorkflowRunState,
  type TaskWorkflowState,
} from "./task-workflow";

export type TaskWorkflowStoredEvent = {
  sequence: number;
  eventId: string;
  event: TaskWorkflowEvent;
  recordedAt: string;
  signalId?: string;
};

export type TaskWorkflowAppendEventInput = {
  eventId: string;
  event: TaskWorkflowEvent;
  recordedAt?: string;
  signalId?: string;
};

export type TaskWorkflowEventStore = {
  appendEvent(input: TaskWorkflowAppendEventInput): TaskWorkflowStoredEvent;
  listEvents(): TaskWorkflowStoredEvent[];
  replayState(input?: { initialState?: TaskWorkflowState }): TaskWorkflowState;
  listResumableRuns(input?: {
    state?: TaskWorkflowState;
  }): TaskWorkflowRunState[];
};

export function createInMemoryTaskWorkflowEventStore(input?: {
  events?: TaskWorkflowStoredEvent[];
  now?: () => Date;
}): TaskWorkflowEventStore {
  const events = [...(input?.events ?? [])].sort(
    (left, right) => left.sequence - right.sequence,
  );
  const eventIds = new Map(events.map((event) => [event.eventId, event]));
  const now = input?.now ?? (() => new Date());

  return {
    appendEvent(appendInput) {
      const existing = eventIds.get(appendInput.eventId);
      if (existing) {
        return existing;
      }

      const stored: TaskWorkflowStoredEvent = {
        sequence: nextSequence(events),
        eventId: appendInput.eventId,
        event: appendInput.event,
        recordedAt: appendInput.recordedAt ?? now().toISOString(),
        ...(appendInput.signalId ? { signalId: appendInput.signalId } : {}),
      };
      events.push(stored);
      eventIds.set(stored.eventId, stored);
      return stored;
    },
    listEvents() {
      return [...events];
    },
    replayState(replayInput) {
      return reduceTaskWorkflowEvents(
        events.map((event) => event.event),
        replayInput?.initialState ?? createInitialTaskWorkflowState(),
      );
    },
    listResumableRuns(listInput) {
      const state = listInput?.state ?? this.replayState();
      return Object.values(state.runs).filter(isResumableRun);
    },
  };
}

function nextSequence(events: TaskWorkflowStoredEvent[]): number {
  return (events.at(-1)?.sequence ?? 0) + 1;
}

function isResumableRun(run: TaskWorkflowRunState): boolean {
  return (
    run.status === "created" ||
    run.status === "validating" ||
    run.status === "running" ||
    run.status === "delivering"
  );
}
