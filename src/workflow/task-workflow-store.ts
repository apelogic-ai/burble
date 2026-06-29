import {
  createInitialTaskWorkflowState,
  reduceTaskWorkflowEvents,
  type TaskWorkflowEvent,
  type TaskWorkflowRunState,
  type TaskWorkflowSideEffectFailure,
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

export type TaskWorkflowSideEffectFailureRecord =
  TaskWorkflowSideEffectFailure & {
    failureId: string;
  };

export type TaskWorkflowSnapshot = {
  sequence: number;
  state: TaskWorkflowState;
  createdAt: string;
};

export type TaskWorkflowWriteSnapshotInput = {
  sequence?: number;
  state?: TaskWorkflowState;
  createdAt?: string;
};

export type TaskWorkflowCompactEventsResult = {
  compactedThroughSequence: number;
  deletedEvents: number;
};

export type TaskWorkflowEventStore = {
  appendEvent(input: TaskWorkflowAppendEventInput): TaskWorkflowStoredEvent;
  listEvents(input?: { signalId?: string }): TaskWorkflowStoredEvent[];
  replayState(input?: { initialState?: TaskWorkflowState }): TaskWorkflowState;
  writeSnapshot(input?: TaskWorkflowWriteSnapshotInput): TaskWorkflowSnapshot;
  getLatestSnapshot(): TaskWorkflowSnapshot | null;
  compactEventsThroughSnapshot(input?: {
    snapshotSequence?: number;
  }): TaskWorkflowCompactEventsResult;
  listResumableRuns(input?: {
    state?: TaskWorkflowState;
  }): TaskWorkflowRunState[];
  listSideEffectFailures(input?: {
    state?: TaskWorkflowState;
    taskId?: string;
    commandType?: TaskWorkflowSideEffectFailure["commandType"];
  }): TaskWorkflowSideEffectFailureRecord[];
};

export function createInMemoryTaskWorkflowEventStore(input?: {
  events?: TaskWorkflowStoredEvent[];
  now?: () => Date;
}): TaskWorkflowEventStore {
  const events = [...(input?.events ?? [])].sort(
    (left, right) => left.sequence - right.sequence,
  );
  const eventIds = new Map(events.map((event) => [event.eventId, event]));
  const snapshots: TaskWorkflowSnapshot[] = [];
  const now = input?.now ?? (() => new Date());

  const listEvents = (listInput?: {
    signalId?: string;
  }): TaskWorkflowStoredEvent[] =>
    events.filter(
      (event) => !listInput?.signalId || event.signalId === listInput.signalId,
    );
  const replayState = (replayInput?: {
    initialState?: TaskWorkflowState;
  }): TaskWorkflowState => {
    if (replayInput?.initialState) {
      return reduceTaskWorkflowEvents(
        events.map((event) => event.event),
        replayInput.initialState,
      );
    }

    const snapshot = getLatestSnapshot();
    return reduceTaskWorkflowEvents(
      events
        .filter((event) => !snapshot || event.sequence > snapshot.sequence)
        .map((event) => event.event),
      snapshot?.state ?? createInitialTaskWorkflowState(),
    );
  };
  const getLatestSnapshot = (): TaskWorkflowSnapshot | null =>
    snapshots.at(-1) ?? null;
  const writeSnapshot = (
    snapshotInput?: TaskWorkflowWriteSnapshotInput,
  ): TaskWorkflowSnapshot => {
    const sequence = snapshotInput?.sequence ?? events.at(-1)?.sequence ?? 0;
    const state =
      snapshotInput?.state ??
      reduceTaskWorkflowEvents(
        events
          .filter((event) => event.sequence <= sequence)
          .map((event) => event.event),
      );
    const snapshot: TaskWorkflowSnapshot = {
      sequence,
      state,
      createdAt: snapshotInput?.createdAt ?? now().toISOString(),
    };
    const existingIndex = snapshots.findIndex(
      (existing) => existing.sequence === sequence,
    );
    if (existingIndex >= 0) {
      snapshots[existingIndex] = snapshot;
    } else {
      snapshots.push(snapshot);
      snapshots.sort((left, right) => left.sequence - right.sequence);
    }
    return snapshot;
  };
  const compactEventsThroughSnapshot = (compactInput?: {
    snapshotSequence?: number;
  }): TaskWorkflowCompactEventsResult => {
    const sequence =
      compactInput?.snapshotSequence ?? getLatestSnapshot()?.sequence ?? 0;
    const before = events.length;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index]?.sequence && events[index].sequence <= sequence) {
        events.splice(index, 1);
      }
    }
    return {
      compactedThroughSequence: sequence,
      deletedEvents: before - events.length,
    };
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
  }): TaskWorkflowSideEffectFailureRecord[] => {
    const state = listInput?.state ?? replayState();
    return listTaskWorkflowSideEffectFailures(state, listInput);
  };

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
    listEvents,
    replayState,
    writeSnapshot,
    getLatestSnapshot,
    compactEventsThroughSnapshot,
    listResumableRuns,
    listSideEffectFailures,
  };
}

export function listTaskWorkflowSideEffectFailures(
  state: TaskWorkflowState,
  input?: {
    taskId?: string;
    commandType?: TaskWorkflowSideEffectFailure["commandType"];
  },
): TaskWorkflowSideEffectFailureRecord[] {
  return Object.entries(state.sideEffectFailures ?? {})
    .map(([failureId, failure]) => ({
      failureId,
      ...failure,
    }))
    .filter(
      (failure) =>
        (!input?.taskId || failure.taskId === input.taskId) &&
        (!input?.commandType || failure.commandType === input.commandType),
    )
    .sort((left, right) =>
      left.at === right.at
        ? left.failureId.localeCompare(right.failureId)
        : left.at.localeCompare(right.at),
    );
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
