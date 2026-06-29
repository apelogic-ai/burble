import { createHash } from "node:crypto";
import type { AgentJobRunRecord } from "../db";
import { TASK_WORKFLOW_AGENT_ATTEMPT_MODE } from "./task-workflow";
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
    eventId: shadowEventId(input.run, "attempt_started", "1"),
    event: {
      type: "attempt_started",
      taskId: input.run.jobId,
      jobRunId: input.run.runId,
      attempt: 1,
      mode: TASK_WORKFLOW_AGENT_ATTEMPT_MODE,
      at,
    },
    recordedAt: at,
  });
}

export function recordTaskWorkflowRunValidationFailed(
  input: TaskWorkflowShadowInput & {
    failureClass: string;
    reason: string;
  },
): void {
  const at = shadowEventTime(input);
  recordTaskWorkflowRunTriggered(input);
  appendShadowEvent(input, {
    eventId: shadowEventId(input.run, "validation_failed"),
    event: {
      type: "validation_failed",
      taskId: input.run.jobId,
      jobRunId: input.run.runId,
      failureClass: input.failureClass,
      reason: input.reason,
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
  const at = shadowEventTime(input, input.run.finishedAt);
  const outputDigest = outputTextDigest(input.outputText);
  const deliveryKey = `${input.run.runId}:${input.routeId ?? "no-route"}:${outputDigest}`;
  appendShadowEvent(input, {
    eventId: shadowEventId(input.run, "attempt_succeeded", "1", outputDigest),
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
    eventId: shadowEventId(input.run, "delivery_started", deliveryKey),
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
    eventId: shadowEventId(input.run, "delivery_succeeded", deliveryKey),
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
  const at = shadowEventTime(input, input.run.finishedAt);
  appendShadowEvent(input, {
    eventId: shadowEventId(input.run, "attempt_failed", "1", input.failureClass),
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
    | "validation_failed"
    | "attempt_started"
    | "attempt_succeeded"
    | "attempt_failed"
    | "delivery_started"
    | "delivery_succeeded",
  ...parts: string[]
): string {
  const suffix =
    parts.length > 0 ? `:${parts.map(encodeURIComponent).join(":")}` : "";
  return `shadow:${run.runId}:${eventName}${suffix}`;
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
