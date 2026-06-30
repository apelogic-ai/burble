import type { AgentJobRunRecord, TokenStore } from "../db";
import { TASK_WORKFLOW_AGENT_ATTEMPT_MODE } from "./task-workflow";
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
  const attempt = input.workflowRun.attempt ?? 1;
  const outputDigest =
    input.workflowRun.outputDigest ?? `reconciled:${input.run.runId}`;
  const deliveryKey =
    input.workflowRun.deliveryKey ??
    `${input.run.runId}:reconciled:${outputDigest}`;

  if (
    input.workflowRun.status === "created" ||
    input.workflowRun.status === "validating"
  ) {
    appendAuthorityEvent(input.store, {
      eventId: `reconcile:${input.run.runId}:validation_passed`,
      event: {
        type: "validation_passed",
        taskId: input.run.jobId,
        jobRunId: input.run.runId,
        at,
      },
    });
  }

  if (!input.workflowRun.attempt || input.workflowRun.status !== "delivering") {
    appendAuthorityEvent(input.store, {
      eventId: `reconcile:${input.run.runId}:attempt_started:${attempt}`,
      event: {
        type: "attempt_started",
        taskId: input.run.jobId,
        jobRunId: input.run.runId,
        attempt,
        mode: TASK_WORKFLOW_AGENT_ATTEMPT_MODE,
        at,
      },
    });
  }

  if (input.workflowRun.status !== "delivering") {
    appendAuthorityEvent(input.store, {
      eventId: `reconcile:${input.run.runId}:attempt_succeeded:${attempt}:${encodeURIComponent(outputDigest)}`,
      event: {
        type: "attempt_succeeded",
        taskId: input.run.jobId,
        jobRunId: input.run.runId,
        attempt,
        outputDigest,
        at,
      },
    });
  }

  if (!input.workflowRun.deliveryKey) {
    appendAuthorityEvent(input.store, {
      eventId: `reconcile:${input.run.runId}:delivery_started:${encodeURIComponent(deliveryKey)}`,
      event: {
        type: "delivery_started",
        taskId: input.run.jobId,
        jobRunId: input.run.runId,
        deliveryKey,
        at,
      },
    });
  }

  appendAuthorityEvent(input.store, {
    eventId: `reconcile:${input.run.runId}:delivery_succeeded:${encodeURIComponent(deliveryKey)}`,
    event: {
      type: "delivery_succeeded",
      taskId: input.run.jobId,
      jobRunId: input.run.runId,
      deliveryKey,
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
