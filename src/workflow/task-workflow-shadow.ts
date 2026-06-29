import { createHash } from "node:crypto";
import type { AgentJobRunRecord } from "../db";
import type {
  TaskWorkflowAppendEventInput,
  TaskWorkflowEventStore,
} from "./task-workflow-store";

export type TaskWorkflowShadowStore = Pick<TaskWorkflowEventStore, "appendEvent">;

export type TaskWorkflowShadowInput = {
  store?: TaskWorkflowShadowStore;
  run: AgentJobRunRecord;
  at?: Date;
  logWarn?: (message: string) => void;
};

export function recordTaskWorkflowRunTriggered(
  input: TaskWorkflowShadowInput,
): void {
  appendShadowEvent(input, {
    eventId: shadowEventId(input.run, "task_triggered"),
    event: {
      type: "task_triggered",
      taskId: input.run.jobId,
      jobRunId: input.run.runId,
      triggerKey: shadowTriggerKey(input.run),
      source: input.run.triggerSource,
      at: input.run.createdAt,
    },
    recordedAt: input.run.createdAt,
    signalId: shadowTriggerKey(input.run),
  });
}

export function recordTaskWorkflowRunStarted(
  input: TaskWorkflowShadowInput,
): void {
  const at = shadowEventTime(input, input.run.startedAt);
  recordTaskWorkflowRunTriggered(input);
  appendShadowEvent(input, {
    eventId: shadowEventId(input.run, "validation_passed"),
    event: {
      type: "validation_passed",
      taskId: input.run.jobId,
      jobRunId: input.run.runId,
      at,
    },
    recordedAt: at,
  });
  appendShadowEvent(input, {
    eventId: shadowEventId(input.run, "attempt_started"),
    event: {
      type: "attempt_started",
      taskId: input.run.jobId,
      jobRunId: input.run.runId,
      attempt: 1,
      mode: "agent",
      at,
    },
    recordedAt: at,
  });
}

export function recordTaskWorkflowRunSucceeded(
  input: TaskWorkflowShadowInput & {
    outputText: string;
    routeId?: string | null;
  },
): void {
  const at = shadowEventTime(input);
  recordTaskWorkflowRunStarted(input);
  const outputDigest = outputTextDigest(input.outputText);
  const deliveryKey = `${input.run.runId}:${input.routeId ?? "no-route"}:${outputDigest}`;
  appendShadowEvent(input, {
    eventId: shadowEventId(input.run, "attempt_succeeded"),
    event: {
      type: "attempt_succeeded",
      taskId: input.run.jobId,
      jobRunId: input.run.runId,
      attempt: 1,
      outputDigest,
      at,
    },
    recordedAt: at,
  });
  appendShadowEvent(input, {
    eventId: shadowEventId(input.run, "delivery_started"),
    event: {
      type: "delivery_started",
      taskId: input.run.jobId,
      jobRunId: input.run.runId,
      deliveryKey,
      at,
    },
    recordedAt: at,
  });
  appendShadowEvent(input, {
    eventId: shadowEventId(input.run, "delivery_succeeded"),
    event: {
      type: "delivery_succeeded",
      taskId: input.run.jobId,
      jobRunId: input.run.runId,
      deliveryKey,
      at,
    },
    recordedAt: at,
  });
}

export function recordTaskWorkflowRunFailed(
  input: TaskWorkflowShadowInput & {
    failureClass: string;
    reason: string;
  },
): void {
  const at = shadowEventTime(input);
  recordTaskWorkflowRunStarted(input);
  appendShadowEvent(input, {
    eventId: shadowEventId(input.run, "attempt_failed"),
    event: {
      type: "attempt_failed",
      taskId: input.run.jobId,
      jobRunId: input.run.runId,
      attempt: 1,
      failureClass: input.failureClass,
      reason: input.reason,
      at,
    },
    recordedAt: at,
  });
}

function appendShadowEvent(
  input: Pick<TaskWorkflowShadowInput, "store" | "logWarn" | "run">,
  event: TaskWorkflowAppendEventInput,
): void {
  if (!input.store) {
    return;
  }
  try {
    input.store.appendEvent(event);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unknown shadow recorder failure";
    input.logWarn?.(
      `Task workflow shadow append failed runId=${input.run.runId} eventId=${event.eventId} error=${message}`,
    );
  }
}

function shadowEventId(
  run: AgentJobRunRecord,
  eventName:
    | "task_triggered"
    | "validation_passed"
    | "attempt_started"
    | "attempt_succeeded"
    | "attempt_failed"
    | "delivery_started"
    | "delivery_succeeded",
): string {
  return `shadow:${run.runId}:${eventName}`;
}

function shadowTriggerKey(run: AgentJobRunRecord): string {
  return `${run.jobId}:${run.triggerSource}:${run.runId}`;
}

function shadowEventTime(
  input: Pick<TaskWorkflowShadowInput, "at" | "run">,
  fallback?: string | null,
): string {
  return fallback ?? input.at?.toISOString() ?? new Date().toISOString();
}

function outputTextDigest(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}
