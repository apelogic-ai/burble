export function taskWorkflowScheduledTriggerKey(input: {
  taskId: string;
  dueSlot: string;
}): string {
  return joinTaskWorkflowKeyParts(
    "task",
    keyPart("taskId", input.taskId),
    "trigger",
    "schedule",
    encodedKeyPart("dueSlot", input.dueSlot),
  );
}

export function taskWorkflowManualTriggerKey(input: {
  taskId: string;
  requestId: string;
}): string {
  return joinTaskWorkflowKeyParts(
    "task",
    keyPart("taskId", input.taskId),
    "trigger",
    "manual",
    keyPart("requestId", input.requestId),
  );
}

export function taskWorkflowStepAttemptKey(input: {
  jobRunId: string;
  stepId: string;
  attempt: number;
}): string {
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
    throw new Error("Task workflow attempt must be a positive safe integer");
  }
  return joinTaskWorkflowKeyParts(
    "jobrun",
    keyPart("jobRunId", input.jobRunId),
    "step",
    keyPart("stepId", input.stepId),
    "attempt",
    String(input.attempt),
  );
}

export function taskWorkflowDeliveryKey(input: {
  jobRunId: string;
  deliveryRouteId: string;
  outputDigest: string;
}): string {
  return joinTaskWorkflowKeyParts(
    "jobrun",
    keyPart("jobRunId", input.jobRunId),
    "delivery",
    keyPart("deliveryRouteId", input.deliveryRouteId),
    encodedKeyPart("outputDigest", input.outputDigest),
  );
}

export function taskWorkflowFailureWindowKey(input: {
  taskId: string;
  failureClass: string;
  window: string;
}): string {
  return joinTaskWorkflowKeyParts(
    "task",
    keyPart("taskId", input.taskId),
    "failure",
    keyPart("failureClass", input.failureClass),
    "window",
    keyPart("window", input.window),
  );
}

function joinTaskWorkflowKeyParts(...parts: string[]): string {
  return parts.map((part) => keyPart("literal", part)).join(":");
}

function keyPart(name: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Task workflow key part ${name} is empty`);
  }
  if (trimmed.includes(":")) {
    throw new Error(`Task workflow key part ${name} cannot contain ':'`);
  }
  return trimmed;
}

function encodedKeyPart(name: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Task workflow key part ${name} is empty`);
  }
  return encodeURIComponent(trimmed);
}
