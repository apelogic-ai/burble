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
    | "tool_not_granted"
    | "missing_idempotency_key"
    | "unbound_template_variable";
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
    validateIdempotency(step, errors);
    validateTemplateBindings(step, scopedBindings, errors);

    if ("saveAs" in step && step.saveAs) {
      availableBindings.add(step.saveAs);
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, errors: [] };
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
    isMutatingProviderTool(step.tool) &&
    !step.idempotencyKey?.trim()
  ) {
    errors.push({
      code: "missing_idempotency_key",
      stepId: step.id,
      message: `Workflow step ${step.id} uses a mutating tool and requires an idempotencyKey.`,
    });
  }
}

function isMutatingProviderTool(toolName: string): boolean {
  const spec = findProviderToolSpec(toolName);
  return Boolean(spec?.risk && spec.risk !== "read");
}

function validateTemplateBindings(
  step: TaskWorkflowStep,
  availableBindings: Set<string>,
  errors: TaskWorkflowPlanValidationError[],
): void {
  for (const variable of templateVariables(step.input)) {
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
