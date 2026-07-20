import * as z from "zod/v4";
import type {
  SchedulerTaskPlan,
  SchedulerTaskPreparationStep,
} from "../conversation/types";
import {
  expandProviderToolDependencies,
  findProviderToolSpec,
} from "../providers/catalog";
import { providerToolInputSchema } from "../providers/tool-specs";
import type { ScheduledJobStateRef } from "../agent/scheduled-job-context";

export type ScheduledTaskPreparationToolResult = {
  value: unknown;
  stateRef?: ScheduledJobStateRef;
};

export type ScheduledTaskPreparationToolExecutor = (input: {
  workspaceId: string;
  slackUserId: string;
  tool: string;
  input: Record<string, unknown>;
  purpose?: string;
}) => Promise<ScheduledTaskPreparationToolResult>;

export type ScheduledTaskPreparationResult = {
  prompt: string;
  requiredTools: string[];
  stateRefs: ScheduledJobStateRef[];
  resources: Record<string, unknown>;
};

export type ScheduledTaskPlanValidation =
  | { ok: true; errors: [] }
  | { ok: false; errors: string[] };

export function validateScheduledTaskPlan(
  plan: SchedulerTaskPlan,
): ScheduledTaskPlanValidation {
  const errors: string[] = [];

  for (const step of plan.preparation) {
    const tool = findProviderToolSpec(step.tool);
    if (!tool) {
      errors.push(
        `Preparation step ${step.id} references unknown provider tool ${step.tool}.`,
      );
      continue;
    }
    if (tool.risk !== "read" && tool.risk !== "low_write") {
      errors.push(
        `Preparation step ${step.id} cannot automatically execute ${tool.name} because it is ${tool.risk ?? "write"}.`,
      );
      continue;
    }
    if (!z.object(providerToolInputSchema(tool)).safeParse(step.input).success) {
      errors.push(
        `Preparation step ${step.id} has invalid input for ${tool.name}.`,
      );
    }
  }

  for (const step of plan.steps) {
    for (const toolName of step.tools) {
      if (!findProviderToolSpec(toolName)) {
        errors.push(
          `Recurring step ${step.id} references unknown provider tool ${toolName}.`,
        );
      }
    }
  }

  return errors.length > 0
    ? { ok: false, errors: [...new Set(errors)] }
    : { ok: true, errors: [] };
}

export async function executeScheduledTaskPreparation(input: {
  workspaceId: string;
  slackUserId: string;
  plan: SchedulerTaskPlan;
  executeTool: ScheduledTaskPreparationToolExecutor;
}): Promise<ScheduledTaskPreparationResult> {
  const validation = validateScheduledTaskPlan(input.plan);
  if (!validation.ok) {
    throw new Error(validation.errors.join(" "));
  }

  const resources: Record<string, unknown> = {};
  const stateRefs: ScheduledJobStateRef[] = [];
  for (const step of input.plan.preparation) {
    const result = await executePreparationStep(input, step);
    resources[step.saveAs] = bindPreparationResource(result);
    if (result.stateRef) {
      stateRefs.push(normalizeStateRef(result.stateRef, step));
    }
  }

  return {
    prompt: input.plan.steps
      .map(
        (step, index) =>
          `${index + 1}. ${renderResourceBindings(step.instruction, resources)}`,
      )
      .join("\n"),
    requiredTools: canonicalRecurringTools(input.plan),
    stateRefs: dedupeStateRefs(stateRefs),
    resources,
  };
}

function bindPreparationResource(
  result: ScheduledTaskPreparationToolResult,
): unknown {
  if (!result.stateRef) {
    return result.value;
  }
  const resource: Record<string, unknown> = isRecord(result.value)
    ? { ...result.value }
    : { value: result.value };
  const stateRef = result.stateRef;
  return {
    ...resource,
    ...(resource.id === undefined && stateRef.id ? { id: stateRef.id } : {}),
    ...(resource.name === undefined && stateRef.name
      ? { name: stateRef.name }
      : {}),
  };
}

async function executePreparationStep(
  input: {
    workspaceId: string;
    slackUserId: string;
    executeTool: ScheduledTaskPreparationToolExecutor;
  },
  step: SchedulerTaskPreparationStep,
): Promise<ScheduledTaskPreparationToolResult> {
  const tool = findProviderToolSpec(step.tool);
  if (!tool) {
    throw new Error(`Unknown preparation tool ${step.tool}.`);
  }
  return input.executeTool({
    workspaceId: input.workspaceId,
    slackUserId: input.slackUserId,
    tool: tool.name,
    input: step.input,
    ...(step.purpose ? { purpose: step.purpose } : {}),
  });
}

function canonicalRecurringTools(plan: SchedulerTaskPlan): string[] {
  return expandProviderToolDependencies(
    plan.steps.flatMap((step) => step.tools),
  );
}

function renderResourceBindings(
  instruction: string,
  resources: Record<string, unknown>,
): string {
  return instruction.replace(
    /\{\{resources\.([A-Za-z][A-Za-z0-9_]{0,63})\.([a-zA-Z0-9_.]+)\}\}/g,
    (_placeholder, binding: string, path: string) => {
      const value = readPath(resources[binding], path);
      if (
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean"
      ) {
        throw new Error(
          `Preparation output ${binding}.${path} is unavailable or is not a scalar value.`,
        );
      }
      return String(value);
    },
  );
}

function readPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split(".")) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function normalizeStateRef(
  stateRef: ScheduledJobStateRef,
  step: SchedulerTaskPreparationStep,
): ScheduledJobStateRef {
  return {
    provider: stateRef.provider,
    kind: stateRef.kind,
    ...(stateRef.id ? { id: stateRef.id } : {}),
    ...(stateRef.name ? { name: stateRef.name } : {}),
    ...(stateRef.purpose
      ? { purpose: stateRef.purpose }
      : step.purpose
        ? { purpose: step.purpose }
        : {}),
  };
}

function dedupeStateRefs(
  stateRefs: ScheduledJobStateRef[],
): ScheduledJobStateRef[] {
  const seen = new Set<string>();
  return stateRefs.filter((stateRef) => {
    const key = [stateRef.provider, stateRef.kind, stateRef.id ?? ""].join(":");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
