import {
  type TaskWorkflowDeliveryStep,
  type TaskWorkflowModelStep,
  type TaskWorkflowPlan,
  type TaskWorkflowPlanValidationError,
  type TaskWorkflowProviderCallStep,
  type TaskWorkflowTransformStep,
  validateTaskWorkflowPlan,
} from "./task-workflow-plan";

export type TaskWorkflowExecutionHandlers = {
  providerCall(input: {
    stepId: string;
    tool: string;
    input: unknown;
    idempotencyKey?: string;
  }): Promise<unknown>;
  model(input: {
    stepId: string;
    modelProfile?: string;
    input: unknown;
  }): Promise<unknown>;
  delivery(input: {
    stepId: string;
    tool: string;
    input: unknown;
    idempotencyKey: string;
  }): Promise<unknown>;
  transform?(input: {
    stepId: string;
    operation?: string;
    input: unknown;
  }): Promise<unknown>;
};

export type TaskWorkflowExecutionResult =
  | {
      ok: true;
      bindings: Record<string, unknown>;
      artifacts: Array<{
        stepId: string;
        output: unknown;
      }>;
    }
  | {
      ok: false;
      errors: Array<
        | TaskWorkflowPlanValidationError
        | {
            code: "step_failed";
            stepId: string;
            message: string;
          }
      >;
    };

export async function executeTaskWorkflowPlan(input: {
  plan: TaskWorkflowPlan;
  initialBindings?: Record<string, unknown>;
  handlers: TaskWorkflowExecutionHandlers;
}): Promise<TaskWorkflowExecutionResult> {
  const validation = validateTaskWorkflowPlan(input.plan);
  if (!validation.ok) {
    return validation;
  }

  const bindings = { ...(input.initialBindings ?? {}) };
  const artifacts: Array<{ stepId: string; output: unknown }> = [];

  for (const step of input.plan.steps ?? []) {
    try {
      const output = await executeStep({
        step,
        bindings,
        handlers: input.handlers,
      });
      artifacts.push({
        stepId: step.id,
        output,
      });
      if ("saveAs" in step && step.saveAs) {
        bindings[step.saveAs] = output;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "step failed";
      return {
        ok: false,
        errors: [
          {
            code: "step_failed",
            stepId: step.id,
            message: `Workflow step ${step.id} failed: ${message}`,
          },
        ],
      };
    }
  }

  return {
    ok: true,
    bindings,
    artifacts,
  };
}

async function executeStep(input: {
  step:
    | TaskWorkflowProviderCallStep
    | TaskWorkflowTransformStep
    | TaskWorkflowModelStep
    | TaskWorkflowDeliveryStep;
  bindings: Record<string, unknown>;
  handlers: TaskWorkflowExecutionHandlers;
}): Promise<unknown> {
  if (input.step.kind === "provider_call" && input.step.foreach) {
    return executeProviderCallForeach(input.step, input.bindings, input.handlers);
  }

  const resolvedInput = resolveTemplateValue(input.step.input, input.bindings);
  switch (input.step.kind) {
    case "provider_call":
      return input.handlers.providerCall({
        stepId: input.step.id,
        tool: input.step.tool,
        input: resolvedInput,
        idempotencyKey: input.step.idempotencyKey
          ? resolveTemplateString(input.step.idempotencyKey, input.bindings)
          : undefined,
      });
    case "model":
      return input.handlers.model({
        stepId: input.step.id,
        modelProfile: input.step.modelProfile,
        input: resolvedInput,
      });
    case "delivery":
      return input.handlers.delivery({
        stepId: input.step.id,
        tool: input.step.tool,
        input: resolvedInput,
        idempotencyKey: resolveTemplateString(
          input.step.idempotencyKey ?? "",
          input.bindings,
        ),
      });
    case "transform":
      if (!input.handlers.transform) {
        return resolvedInput;
      }
      return input.handlers.transform({
        stepId: input.step.id,
        operation: input.step.operation,
        input: resolvedInput,
      });
  }
}

async function executeProviderCallForeach(
  step: TaskWorkflowProviderCallStep,
  bindings: Record<string, unknown>,
  handlers: TaskWorkflowExecutionHandlers,
): Promise<unknown[]> {
  const collection = readBinding(bindings, step.foreach ?? "");
  if (!Array.isArray(collection)) {
    throw new Error(`Workflow foreach ${step.foreach} did not resolve to an array`);
  }

  const outputs: unknown[] = [];
  for (const item of collection) {
    const itemBindings = { ...bindings, item };
    outputs.push(
      await handlers.providerCall({
        stepId: step.id,
        tool: step.tool,
        input: resolveTemplateValue(step.input, itemBindings),
        idempotencyKey: step.idempotencyKey
          ? resolveTemplateString(step.idempotencyKey, itemBindings)
          : undefined,
      }),
    );
  }
  return outputs;
}

function resolveTemplateValue(
  value: unknown,
  bindings: Record<string, unknown>,
): unknown {
  if (typeof value === "string") {
    const exactMatch = /^\{(?<name>[A-Za-z0-9_.-]+)\}$/.exec(value);
    const exactName = exactMatch?.groups?.name;
    if (exactName) {
      return readBinding(bindings, exactName);
    }
    return resolveTemplateString(value, bindings);
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveTemplateValue(item, bindings));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      resolveTemplateValue(item, bindings),
    ]),
  );
}

function resolveTemplateString(
  value: string,
  bindings: Record<string, unknown>,
): string {
  return value.replace(
    /\{(?<name>[A-Za-z0-9_.-]+)\}/g,
    (_match: string, name: string) => String(readBinding(bindings, name)),
  );
}

function readBinding(bindings: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = bindings;
  for (const part of parts) {
    if (!current || typeof current !== "object" || !(part in current)) {
      throw new Error(`Unbound workflow value ${path}`);
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
