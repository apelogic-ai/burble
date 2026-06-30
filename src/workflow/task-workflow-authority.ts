import type { AgentJobRunRecord, TokenStore } from "../db";
import type { TaskWorkflowStaleRunFailure } from "./task-workflow-reconcile";

type AuthoritativeRunStore = Pick<
  TokenStore,
  "finishAgentJobRun" | "getAgentJobRun"
>;

export type FinishAuthoritativeWorkflowRunResult =
  | { status: "failed"; run: AgentJobRunRecord }
  | { status: "already_terminal"; run: AgentJobRunRecord }
  | { status: "not_finished"; run: AgentJobRunRecord }
  | { status: "missing" };

export function finishAuthoritativeRunForStaleWorkflowFailure(input: {
  store: AuthoritativeRunStore;
  failure: TaskWorkflowStaleRunFailure;
}): FinishAuthoritativeWorkflowRunResult {
  const reason = staleWorkflowFailureReason(input.failure).slice(0, 500);
  const finished =
    input.store.finishAgentJobRun({
      runId: input.failure.run.jobRunId,
      status: "failed",
      failureReason: reason,
      now: new Date(input.failure.event.at),
    }) ?? input.store.getAgentJobRun(input.failure.run.jobRunId);

  if (!finished) {
    return { status: "missing" };
  }
  if (finished.status === "failed") {
    return { status: "failed", run: finished };
  }
  if (finished.status === "succeeded") {
    return { status: "already_terminal", run: finished };
  }
  return { status: "not_finished", run: finished };
}

function staleWorkflowFailureReason(
  failure: TaskWorkflowStaleRunFailure,
): string {
  return "reason" in failure.event
    ? failure.event.reason
    : `Workflow run ${failure.run.jobRunId} was reconciled as failed.`;
}
