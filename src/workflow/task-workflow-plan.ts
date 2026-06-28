import { findProviderToolSpec } from "../providers/catalog";

export type TaskWorkflowPlanMode =
  "literal" | "burble_workflow" | "agent_tool_loop";

export type TaskWorkflowPlan = {
  mode: TaskWorkflowPlanMode;
  grants?: {
    tools?: string[];
  };
  availableBindings?: string[];
  steps?: TaskWorkflowStep[];
};

export type TaskWorkflowStep =
  | TaskWorkflowProviderCallStep
  | TaskWorkflowTransformStep
  | TaskWorkflowModelStep
  | TaskWorkflowDeliveryStep;

export type TaskWorkflowProviderCallStep = {
  id: string;
  kind: "provider_call";
  tool: string;
  input: unknown;
  foreach?: string;
  saveAs?: string;
  idempotencyKey?: string;
};

export type TaskWorkflowTransformStep = {
  id: string;
  kind: "transform";
  operation?: string;
  input: unknown;
  saveAs?: string;
};

export type TaskWorkflowModelStep = {
  id: string;
  kind: "model";
  modelProfile?: string;
  input: unknown;
  saveAs?: string;
};

export type TaskWorkflowDeliveryStep = {
  id: string;
  kind: "delivery";
  tool: string;
  input: unknown;
  idempotencyKey?: string;
};

export type TaskWorkflowPlanValidationError = {
  code:
    | "duplicate_step_id"
    | "invalid_step_id"
    | "unknown_step_kind"
    | "binding_collision"
    | "tool_not_granted"
    | "unknown_provider_tool"
    | "missing_idempotency_key"
    | "unbound_template_variable"
    | "unsupported_template_expression";
  stepId: string;
  message: string;
};

export type TaskWorkflowPlanValidationResult =
  | { ok: true; errors: [] }
  | { ok: false; errors: TaskWorkflowPlanValidationError[] };

export function validateTaskWorkflowPlan(
  plan: TaskWorkflowPlan,
): TaskWorkflowPlanValidationResult {
  const errors: TaskWorkflowPlanValidationError[] = [];
  const grantedTools = new Set(plan.grants?.tools ?? []);
  const availableBindings = new Set(plan.availableBindings ?? []);
  const seenStepIds = new Set<string>();

  for (const step of plan.steps ?? []) {
    const stepId = readStepId(step);
    validateStepId(stepId, errors);
    if (!isKnownStepKind(step)) {
      errors.push({
        code: "unknown_step_kind",
        stepId,
        message: `Workflow step ${stepId} has unsupported kind ${String(
          (step as { kind?: unknown }).kind,
        )}.`,
      });
      continue;
    }

    if (seenStepIds.has(step.id)) {
      errors.push({
        code: "duplicate_step_id",
        stepId: step.id,
        message: `Workflow step id ${step.id} is duplicated.`,
      });
    }
    seenStepIds.add(step.id);

    const scopedBindings = new Set(availableBindings);
    if ("foreach" in step && step.foreach) {
      scopedBindings.add("item");
      scopedBindings.add("item.key");
    }

    validateToolGrant(step, grantedTools, errors);
    validateProviderToolCatalog(step, errors);
    validateIdempotency(step, errors);
    validateTemplateBindings(step, scopedBindings, errors);

    if ("saveAs" in step && step.saveAs) {
      validateSaveAsBinding(step, availableBindings, errors);
      availableBindings.add(step.saveAs);
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, errors: [] };
}

function readStepId(step: TaskWorkflowStep): string {
  return typeof step.id === "string" ? step.id : "";
}

function validateStepId(
  stepId: string,
  errors: TaskWorkflowPlanValidationError[],
): void {
  if (stepId.trim() && !stepId.includes(":")) {
    return;
  }
  errors.push({
    code: "invalid_step_id",
    stepId,
    message: `Workflow step id ${stepId} must be non-empty and cannot contain ':'.`,
  });
}

function isKnownStepKind(step: TaskWorkflowStep): step is TaskWorkflowStep {
  return (
    step.kind === "provider_call" ||
    step.kind === "transform" ||
    step.kind === "model" ||
    step.kind === "delivery"
  );
}

function validateSaveAsBinding(
  step: TaskWorkflowProviderCallStep | TaskWorkflowTransformStep | TaskWorkflowModelStep,
  availableBindings: Set<string>,
  errors: TaskWorkflowPlanValidationError[],
): void {
  const binding = step.saveAs;
  if (!binding) {
    return;
  }
  if (availableBindings.has(binding)) {
    errors.push({
      code: "binding_collision",
      stepId: step.id,
      message: `Workflow step ${step.id} saveAs binding ${binding} already exists.`,
    });
  }
}

function validateToolGrant(
  step: TaskWorkflowStep,
  grantedTools: Set<string>,
  errors: TaskWorkflowPlanValidationError[],
): void {
  if (
    (step.kind === "provider_call" || step.kind === "delivery") &&
    !grantedTools.has(step.tool)
  ) {
    errors.push({
      code: "tool_not_granted",
      stepId: step.id,
      message: `Workflow step ${step.id} uses ungranted tool ${step.tool}.`,
    });
  }
}

function validateIdempotency(
  step: TaskWorkflowStep,
  errors: TaskWorkflowPlanValidationError[],
): void {
  if (step.kind === "delivery" && !step.idempotencyKey?.trim()) {
    errors.push({
      code: "missing_idempotency_key",
      stepId: step.id,
      message: `Workflow delivery step ${step.id} requires an idempotencyKey.`,
    });
    return;
  }

  if (
    step.kind === "provider_call" &&
    providerToolRequiresIdempotency(step.tool) &&
    !step.idempotencyKey?.trim()
  ) {
    errors.push({
      code: "missing_idempotency_key",
      stepId: step.id,
      message: `Workflow step ${step.id} uses a mutating tool and requires an idempotencyKey.`,
    });
  }
}

function validateProviderToolCatalog(
  step: TaskWorkflowStep,
  errors: TaskWorkflowPlanValidationError[],
): void {
  if (step.kind !== "provider_call") {
    return;
  }
  if (findProviderToolSpec(step.tool)) {
    return;
  }
  errors.push({
    code: "unknown_provider_tool",
    stepId: step.id,
    message: `Workflow step ${step.id} uses unknown provider tool ${step.tool}.`,
  });
}

function providerToolRequiresIdempotency(toolName: string): boolean {
  const spec = findProviderToolSpec(toolName);
  return !spec || spec.risk !== "read";
}

function validateTemplateBindings(
  step: TaskWorkflowStep,
  availableBindings: Set<string>,
  errors: TaskWorkflowPlanValidationError[],
): void {
  const valuesToScan: unknown[] = [step.input];
  if ("idempotencyKey" in step && step.idempotencyKey) {
    valuesToScan.push(step.idempotencyKey);
  }

  for (const expression of valuesToScan.flatMap(unsupportedTemplateExpressions)) {
    errors.push({
      code: "unsupported_template_expression",
      stepId: step.id,
      message: `Workflow step ${step.id} contains unsupported template expression ${expression}.`,
    });
  }

  for (const variable of valuesToScan.flatMap(templateVariables)) {
    if (
      variable === "jobRunId" ||
      variable.startsWith("state.") ||
      hasAvailableBinding(availableBindings, variable)
    ) {
      continue;
    }
    errors.push({
      code: "unbound_template_variable",
      stepId: step.id,
      message: `Workflow step ${step.id} references unbound template variable ${variable}.`,
    });
  }
}

function hasAvailableBinding(
  availableBindings: Set<string>,
  variable: string,
): boolean {
  if (availableBindings.has(variable)) {
    return true;
  }
  return [...availableBindings].some((binding) =>
    variable.startsWith(`${binding}.`),
  );
}

function templateVariables(value: unknown): string[] {
  const variables = new Set<string>();
  visitTemplateValue(value, variables);
  return [...variables].sort();
}

function unsupportedTemplateExpressions(value: unknown): string[] {
  const expressions = new Set<string>();
  visitUnsupportedTemplateExpressions(value, expressions);
  return [...expressions].sort();
}

function visitUnsupportedTemplateExpressions(
  value: unknown,
  expressions: Set<string>,
): void {
  if (typeof value === "string") {
    const matches = value.matchAll(/\{(?<body>[^{}]*)\}/g);
    for (const match of matches) {
      const body = match.groups?.body;
      if (!body || /^[A-Za-z0-9_.-]+$/.test(body)) {
        continue;
      }
      expressions.add(match[0]);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      visitUnsupportedTemplateExpressions(item, expressions);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  for (const item of Object.values(value)) {
    visitUnsupportedTemplateExpressions(item, expressions);
  }
}

function visitTemplateValue(value: unknown, variables: Set<string>): void {
  if (typeof value === "string") {
    const matches = value.matchAll(/\{(?<name>[A-Za-z0-9_.-]+)\}/g);
    for (const match of matches) {
      const name = match.groups?.name;
      if (name) {
        variables.add(name);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      visitTemplateValue(item, variables);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  for (const item of Object.values(value)) {
    visitTemplateValue(item, variables);
  }
}
