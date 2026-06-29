import type {
  TaskWorkflowCompactEventsResult,
  TaskWorkflowEventStore,
  TaskWorkflowSnapshot,
} from "./task-workflow-store";
import type { TaskWorkflowRunState, TaskWorkflowState } from "./task-workflow";

export type TaskWorkflowMaintenanceResult = {
  skipped: boolean;
  reason?: "already_running" | "below_event_threshold" | "maintenance_failed";
  eventCount: number;
  snapshot?: TaskWorkflowSnapshot;
  compaction?: TaskWorkflowCompactEventsResult;
};

export type TaskWorkflowMaintenanceLoop = {
  tick(): TaskWorkflowMaintenanceResult;
  start(): void;
  stop(): void;
};

export function maintainTaskWorkflowEventStore(input: {
  store: TaskWorkflowEventStore;
  minEvents?: number;
  maxTerminalRunAgeMs?: number;
  now?: () => Date;
}): TaskWorkflowMaintenanceResult {
  const minEvents = input.minEvents ?? 1;
  const now = (input.now ?? (() => new Date()))();
  const eventCount = input.store.listEvents().length;
  if (eventCount < minEvents) {
    return {
      skipped: true,
      reason: "below_event_threshold",
      eventCount,
    };
  }

  const rawSnapshot = input.store.buildSnapshot();
  const retainedState = pruneTaskWorkflowStateForRetention({
    state: rawSnapshot.state,
    now,
    maxTerminalRunAgeMs: input.maxTerminalRunAgeMs ?? 7 * 24 * 60 * 60_000,
  });
  const snapshot = input.store.writeSnapshot({
    sequence: rawSnapshot.sequence,
    state: retainedState,
    createdAt: now.toISOString(),
  });
  const compaction = input.store.compactEventsThroughSnapshot({
    snapshotSequence: snapshot.sequence,
  });

  return {
    skipped: false,
    eventCount,
    snapshot,
    compaction,
  };
}

export function pruneTaskWorkflowStateForRetention(input: {
  state: TaskWorkflowState;
  now: Date;
  maxTerminalRunAgeMs: number;
}): TaskWorkflowState {
  const retainedRuns: Record<string, TaskWorkflowRunState> = {};
  const removedRunIds = new Set<string>();
  for (const [runId, run] of Object.entries(input.state.runs)) {
    if (shouldRetainWorkflowRun(run, input.now, input.maxTerminalRunAgeMs)) {
      retainedRuns[runId] = run;
    } else {
      removedRunIds.add(runId);
    }
  }

  if (removedRunIds.size === 0) {
    return input.state;
  }

  return {
    ...input.state,
    runs: retainedRuns,
    triggerKeys: Object.fromEntries(
      Object.entries(input.state.triggerKeys).filter(
        ([, runId]) => !removedRunIds.has(runId),
      ),
    ),
  };
}

function shouldRetainWorkflowRun(
  run: TaskWorkflowRunState,
  now: Date,
  maxTerminalRunAgeMs: number,
): boolean {
  if (!isTerminalWorkflowRun(run)) {
    return true;
  }
  const updatedAtMs = Date.parse(run.updatedAt);
  if (!Number.isFinite(updatedAtMs)) {
    return true;
  }
  return now.getTime() - updatedAtMs <= maxTerminalRunAgeMs;
}

function isTerminalWorkflowRun(run: TaskWorkflowRunState): boolean {
  return (
    run.status === "succeeded" ||
    run.status === "failed" ||
    run.status === "paused_after_failures"
  );
}

export function createTaskWorkflowMaintenanceLoop(input: {
  store: TaskWorkflowEventStore;
  intervalMs?: number;
  minEvents?: number;
  now?: () => Date;
  logInfo?: (message: string) => void;
  logWarn?: (message: string) => void;
}): TaskWorkflowMaintenanceLoop {
  const intervalMs = input.intervalMs ?? 15 * 60_000;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;

  const tick = (): TaskWorkflowMaintenanceResult => {
    if (running) {
      return {
        skipped: true,
        reason: "already_running",
        eventCount: input.store.listEvents().length,
      };
    }
    running = true;
    try {
      const result = maintainTaskWorkflowEventStore(input);
      if (!result.skipped) {
        input.logInfo?.(
          [
            "Task workflow maintenance compacted",
            `snapshotSequence=${result.snapshot?.sequence ?? 0}`,
            `deletedEvents=${result.compaction?.deletedEvents ?? 0}`,
            `deletedSnapshots=${result.compaction?.deletedSnapshots ?? 0}`,
          ].join(" "),
        );
      }
      return result;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "unknown workflow maintenance error";
      input.logWarn?.(`Task workflow maintenance failed error=${message}`);
      return {
        skipped: true,
        reason: "maintenance_failed",
        eventCount: input.store.listEvents().length,
      };
    } finally {
      running = false;
    }
  };

  return {
    tick,
    start() {
      if (timer) {
        return;
      }
      timer = setInterval(tick, intervalMs);
      if ("unref" in timer && typeof timer.unref === "function") {
        timer.unref();
      }
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}
