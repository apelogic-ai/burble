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
  deletedSnapshots: number;
};

export type TaskWorkflowReplayConfig = Pick<
  TaskWorkflowState,
  "failurePauseThreshold"
>;

export type TaskWorkflowReplayStateInput = {
  initialConfig?: TaskWorkflowReplayConfig;
};

export type TaskWorkflowEventStore = {
  appendEvent(input: TaskWorkflowAppendEventInput): TaskWorkflowStoredEvent;
  listEvents(input?: { signalId?: string }): TaskWorkflowStoredEvent[];
  replayState(input?: TaskWorkflowReplayStateInput): TaskWorkflowState;
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
  let nextEventSequence =
    Math.max(0, ...events.map((event) => event.sequence)) + 1;
  const now = input?.now ?? (() => new Date());

  const listEvents = (listInput?: {
    signalId?: string;
  }): TaskWorkflowStoredEvent[] =>
    events.filter(
      (event) => !listInput?.signalId || event.signalId === listInput.signalId,
    );
  const replayState = (replayInput?: TaskWorkflowReplayStateInput) =>
    replayTaskWorkflowStateFromSnapshot({
      events,
      snapshot: getLatestSnapshot(),
      initialConfig: replayInput?.initialConfig,
    });
  const getLatestSnapshot = (): TaskWorkflowSnapshot | null =>
    snapshots.at(-1) ?? null;
  const getLatestSnapshotAtOrBefore = (
    sequence: number,
  ): TaskWorkflowSnapshot | null => {
    for (let index = snapshots.length - 1; index >= 0; index -= 1) {
      const snapshot = snapshots[index];
      if (snapshot && snapshot.sequence <= sequence) {
        return snapshot;
      }
    }
    return null;
  };
  const writeSnapshot = (
    snapshotInput?: TaskWorkflowWriteSnapshotInput,
  ): TaskWorkflowSnapshot => {
    const latestSnapshot = getLatestSnapshot();
    const latestKnownSequence = Math.max(
      events.at(-1)?.sequence ?? 0,
      latestSnapshot?.sequence ?? 0,
    );
    const sequence =
      snapshotInput?.sequence ?? latestKnownSequence;
    assertTaskWorkflowSnapshotSequenceKnown(sequence, latestKnownSequence);
    const baseSnapshot = getLatestSnapshotAtOrBefore(sequence);
    const state = snapshotInput?.state
      ? snapshotInput.state
      : buildTaskWorkflowSnapshotState({
          events,
          sequence,
          baseSnapshot,
        });
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
    const sequence = compactableSnapshotSequence(
      snapshots.at(-1)?.sequence ?? 0,
      compactInput?.snapshotSequence,
    );
    const before = events.length;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index] !== undefined && events[index].sequence <= sequence) {
        events.splice(index, 1);
      }
    }
    const snapshotCountBefore = snapshots.length;
    pruneSupersededSnapshots(snapshots, sequence);
    return {
      compactedThroughSequence: sequence,
      deletedEvents: before - events.length,
      deletedSnapshots: snapshotCountBefore - snapshots.length,
    };
  };
  const listResumableRuns = (listInput?: {
    state?: TaskWorkflowState;
  }): TaskWorkflowRunState[] => {
    const state = listInput?.state ?? replayState();
    return selectTaskWorkflowResumableRuns(state);
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
        sequence: nextEventSequence,
        eventId: appendInput.eventId,
        event: appendInput.event,
        recordedAt: appendInput.recordedAt ?? now().toISOString(),
        ...(appendInput.signalId ? { signalId: appendInput.signalId } : {}),
      };
      nextEventSequence += 1;
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

export function selectTaskWorkflowResumableRuns(
  state: TaskWorkflowState,
): TaskWorkflowRunState[] {
  return Object.values(state.runs).filter(isResumableRun);
}

export function replayTaskWorkflowStateFromSnapshot(input: {
  events: TaskWorkflowStoredEvent[];
  snapshot: TaskWorkflowSnapshot | null;
  initialConfig?: TaskWorkflowReplayConfig;
}): TaskWorkflowState {
  const baseState = input.snapshot
    ? snapshotBaseState(input.snapshot, input.initialConfig)
    : createInitialTaskWorkflowState(input.initialConfig);
  const events = input.snapshot
    ? input.events.filter((event) => event.sequence > input.snapshot!.sequence)
    : input.events;
  return reduceTaskWorkflowEvents(
    events.map((event) => event.event),
    baseState,
  );
}

export function buildTaskWorkflowSnapshotState(input: {
  events: TaskWorkflowStoredEvent[];
  sequence: number;
  baseSnapshot: TaskWorkflowSnapshot | null;
}): TaskWorkflowState {
  return reduceTaskWorkflowEvents(
    input.events
      .filter(
        (event) =>
          event.sequence <= input.sequence &&
          (!input.baseSnapshot || event.sequence > input.baseSnapshot.sequence),
      )
      .map((event) => event.event),
    input.baseSnapshot?.state ?? createInitialTaskWorkflowState(),
  );
}

export function compactableSnapshotSequence(
  latestSnapshotSequence: number,
  requestedSequence: number | undefined,
): number {
  if (requestedSequence === undefined) {
    return latestSnapshotSequence;
  }
  return Math.min(requestedSequence, latestSnapshotSequence);
}

export function pruneSupersededSnapshots(
  snapshots: TaskWorkflowSnapshot[],
  compactedThroughSequence: number,
): void {
  for (let index = snapshots.length - 1; index >= 0; index -= 1) {
    if (
      snapshots[index] !== undefined &&
      snapshots[index].sequence < compactedThroughSequence
    ) {
      snapshots.splice(index, 1);
    }
  }
}

function snapshotBaseState(
  snapshot: TaskWorkflowSnapshot,
  initialConfig: TaskWorkflowReplayConfig | undefined,
): TaskWorkflowState {
  if (!initialConfig) {
    return snapshot.state;
  }
  return {
    ...snapshot.state,
    failurePauseThreshold: initialConfig.failurePauseThreshold,
  };
}

export function assertTaskWorkflowSnapshotSequenceKnown(
  sequence: number,
  latestKnownSequence: number,
): void {
  if (sequence > latestKnownSequence) {
    throw new Error(
      `Cannot write task workflow snapshot at future sequence ${sequence}; latest known sequence is ${latestKnownSequence}`,
    );
  }
}

function isResumableRun(run: TaskWorkflowRunState): boolean {
  return (
    run.status === "created" ||
    run.status === "validating" ||
    run.status === "running" ||
    run.status === "delivering"
  );
}
