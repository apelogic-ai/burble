import type { AgentJobRunRecord, TokenStore } from "../db";
import type { TaskWorkflowEventStore } from "./task-workflow-store";
import type { TaskWorkflowStaleRunFailureCandidate } from "./task-workflow-reconcile";

type AuthoritativeRunStore = Pick<
  TokenStore,
  "claimAgentJobRun" | "finishAgentJobRun" | "getAgentJobRun"
>;

export type FinishAuthoritativeWorkflowRunResult =
  | { status: "failed"; run: AgentJobRunRecord }
  | { status: "succeeded"; run: AgentJobRunRecord }
  | { status: "not_finished"; run: AgentJobRunRecord }
  | { status: "missing" };

export function finishAuthoritativeRunForStaleWorkflowFailure(input: {
  store: AuthoritativeRunStore;
  failure: TaskWorkflowStaleRunFailureCandidate;
}): FinishAuthoritativeWorkflowRunResult {
  const reason = staleWorkflowFailureReason(input.failure).slice(0, 500);
  const at = new Date(input.failure.event.at);
  const finished =
    input.store.finishAgentJobRun({
      runId: input.failure.run.jobRunId,
      status: "failed",
      failureReason: reason,
      now: at,
    }) ??
    finishQueuedAuthoritativeRun(
      input.store,
      input.failure.run.jobRunId,
      reason,
      at,
    ) ??
    input.store.getAgentJobRun(input.failure.run.jobRunId);

  if (!finished) {
    return { status: "missing" };
  }
  if (finished.status === "failed") {
    return { status: "failed", run: finished };
  }
  if (finished.status === "succeeded") {
    return { status: "succeeded", run: finished };
  }
  return { status: "not_finished", run: finished };
}

export function recordWorkflowRunSucceededFromAuthoritative(input: {
  store: TaskWorkflowEventStore;
  run: AgentJobRunRecord;
  workflowRun: TaskWorkflowStaleRunFailureCandidate["run"];
}): void {
  const at = input.run.finishedAt ?? new Date().toISOString();
  appendAuthorityEvent(input.store, {
    eventId: `reconcile:${input.run.runId}:run_reconciled_succeeded`,
    event: {
      type: "run_reconciled_succeeded",
      taskId: input.run.jobId,
      jobRunId: input.run.runId,
      reason: "Authoritative run already succeeded.",
      at,
    },
  });
}

function finishQueuedAuthoritativeRun(
  store: AuthoritativeRunStore,
  runId: string,
  reason: string,
  at: Date,
): AgentJobRunRecord | null {
  const current = store.getAgentJobRun(runId);
  if (current?.status !== "queued") {
    return null;
  }
  const claimed = store.claimAgentJobRun(runId, at);
  if (!claimed) {
    return null;
  }
  return store.finishAgentJobRun({
    runId,
    status: "failed",
    failureReason: reason,
    now: at,
  });
}

function appendAuthorityEvent(
  store: TaskWorkflowEventStore,
  input: {
    eventId: string;
    event: Parameters<TaskWorkflowEventStore["appendEvent"]>[0]["event"];
  },
): void {
  store.appendEvent({
    eventId: input.eventId,
    event: input.event,
    recordedAt: "at" in input.event ? input.event.at : new Date().toISOString(),
  });
}

function staleWorkflowFailureReason(
  failure: TaskWorkflowStaleRunFailureCandidate,
): string {
  return "reason" in failure.event
    ? failure.event.reason
    : `Workflow run ${failure.run.jobRunId} was reconciled as failed.`;
}
