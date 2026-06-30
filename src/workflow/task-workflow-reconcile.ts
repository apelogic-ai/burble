import type { TaskWorkflowEvent, TaskWorkflowRunState } from "./task-workflow";
import type {
  TaskWorkflowEventStore,
  TaskWorkflowStoredEvent,
} from "./task-workflow-store";

export type ReconcileTaskWorkflowRunsResult = {
  events: TaskWorkflowStoredEvent[];
};

export type TaskWorkflowStaleRunFailure = {
  run: TaskWorkflowRunState;
  event: TaskWorkflowEvent;
  storedEvent: TaskWorkflowStoredEvent;
};

export function reconcileTaskWorkflowRuns(input: {
  store: TaskWorkflowEventStore;
  now: Date;
  staleAfterMs: number;
  onStaleRunFailed?: (failure: TaskWorkflowStaleRunFailure) => void;
}): ReconcileTaskWorkflowRunsResult {
  const events: TaskWorkflowStoredEvent[] = [];
  const nowMs = input.now.getTime();

  for (const run of input.store.listResumableRuns()) {
    if (!isStaleRun(run, nowMs, input.staleAfterMs)) {
      continue;
    }
    const event = staleRunFailedEvent(run, input.now);
    const storedEvent = input.store.appendEvent({
      eventId: staleRunEventId(run),
      signalId: `stale_run:${run.jobRunId}`,
      event,
      recordedAt: input.now.toISOString(),
    });
    events.push(storedEvent);
    input.onStaleRunFailed?.({ run, event, storedEvent });
  }

  return { events };
}

function isStaleRun(
  run: TaskWorkflowRunState,
  nowMs: number,
  staleAfterMs: number,
): boolean {
  const referenceAt = staleReferenceAt(run);
  if (!referenceAt) {
    return false;
  }
  const referenceAtMs = Date.parse(referenceAt);
  return (
    Number.isFinite(referenceAtMs) && nowMs - referenceAtMs >= staleAfterMs
  );
}

function staleRunFailedEvent(
  run: TaskWorkflowRunState,
  now: Date,
): TaskWorkflowEvent {
  const reason = `Workflow run ${run.jobRunId} remained ${run.status} past the stale-run TTL.`;
  const at = now.toISOString();

  if (run.status === "created" || run.status === "validating") {
    return {
      type: "validation_failed",
      taskId: run.taskId,
      jobRunId: run.jobRunId,
      failureClass: "stale_validation_timeout",
      reason,
      at,
    };
  }

  if (run.status === "delivering") {
    return {
      type: "delivery_failed",
      taskId: run.taskId,
      jobRunId: run.jobRunId,
      ...(run.deliveryKey ? { deliveryKey: run.deliveryKey } : {}),
      failureClass: "stale_delivery_timeout",
      reason,
      at,
    };
  }

  return {
    type: "attempt_failed",
    taskId: run.taskId,
    jobRunId: run.jobRunId,
    attempt: run.attempt ?? 1,
    failureClass: "stale_run_timeout",
    reason,
    at,
  };
}

function staleRunEventId(run: TaskWorkflowRunState): string {
  return `stale_run:${run.jobRunId}`;
}

function staleReferenceAt(run: TaskWorkflowRunState): string | null {
  if (run.status === "running") {
    return run.heartbeatAt ?? run.updatedAt;
  }
  return run.updatedAt;
}
