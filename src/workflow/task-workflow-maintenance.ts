import type {
  TaskWorkflowCompactEventsResult,
  TaskWorkflowEventStore,
  TaskWorkflowSnapshot,
} from "./task-workflow-store";

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
  now?: () => Date;
}): TaskWorkflowMaintenanceResult {
  const minEvents = input.minEvents ?? 1;
  const eventCount = input.store.listEvents().length;
  if (eventCount < minEvents) {
    return {
      skipped: true,
      reason: "below_event_threshold",
      eventCount,
    };
  }

  const snapshot = input.store.writeSnapshot({
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
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
