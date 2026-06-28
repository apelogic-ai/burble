import type {
  TaskWorkflowEvent,
  TaskWorkflowRunState,
} from "./task-workflow";
import type {
  TaskWorkflowEventStore,
  TaskWorkflowStoredEvent,
} from "./task-workflow-store";

export type ReconcileTaskWorkflowRunsResult = {
  events: TaskWorkflowStoredEvent[];
};

export function reconcileTaskWorkflowRuns(input: {
  store: TaskWorkflowEventStore;
  now: Date;
  staleAfterMs: number;
}): ReconcileTaskWorkflowRunsResult {
  const events: TaskWorkflowStoredEvent[] = [];
  const nowMs = input.now.getTime();

  for (const run of input.store.listResumableRuns()) {
    if (!isStaleRun(run, nowMs, input.staleAfterMs)) {
      continue;
    }
    const event = staleRunFailedEvent(run, input.now);
    events.push(
      input.store.appendEvent({
        eventId: staleRunEventId(run),
        signalId: `stale_run:${run.jobRunId}`,
        event,
        recordedAt: input.now.toISOString(),
      }),
    );
  }

  return { events };
}

function isStaleRun(
  run: TaskWorkflowRunState,
  nowMs: number,
  staleAfterMs: number,
): boolean {
  const updatedAtMs = Date.parse(run.updatedAt);
  return Number.isFinite(updatedAtMs) && nowMs - updatedAtMs >= staleAfterMs;
}

function staleRunFailedEvent(
  run: TaskWorkflowRunState,
  now: Date,
): TaskWorkflowEvent {
  return {
    type: "attempt_failed",
    taskId: run.taskId,
    jobRunId: run.jobRunId,
    attempt: run.attempt ?? 0,
    failureClass: "stale_run_timeout",
    reason: `Workflow run ${run.jobRunId} remained ${run.status} past the stale-run TTL.`,
    at: now.toISOString(),
  };
}

function staleRunEventId(run: TaskWorkflowRunState): string {
  return `stale_run:${run.jobRunId}`;
}
