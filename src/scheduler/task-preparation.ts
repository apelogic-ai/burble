import * as z from "zod/v4";
import type {
  SchedulerTaskPlan,
  SchedulerTaskPlanOperation,
  SchedulerTaskPreparationStep,
} from "../conversation/types";
import {
  expandProviderToolDependencies,
  findProviderToolSpec,
} from "../providers/catalog";
import { providerToolInputSchema } from "../providers/tool-specs";
import type { ScheduledJobStateRef } from "../agent/scheduled-job-context";
import type { AgentJobOperationGrant } from "../db";

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
  operationGrants?: AgentJobOperationGrant[];
  stateRefs: ScheduledJobStateRef[];
  resources: Record<string, unknown>;
};

export type ScheduledTaskOperationCatalogEntry = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
};

export type ScheduledTaskOperationPreflight = {
  operationGrants: AgentJobOperationGrant[];
  errors: string[];
  catalogs: Record<string, ScheduledTaskOperationCatalogEntry[]>;
};

export type ScheduledTaskPlanValidation =
  | { ok: true; errors: [] }
  | { ok: false; errors: string[] };

export function validateScheduledTaskPlan(
  plan: SchedulerTaskPlan,
): ScheduledTaskPlanValidation {
  const errors: string[] = [];
  const stepIds = new Set<string>();
  const preparationBindings = new Set<string>();

  for (const step of plan.preparation) {
    if (stepIds.has(step.id)) {
      errors.push(`Task plan step id ${step.id} is duplicated.`);
    }
    stepIds.add(step.id);
    if (preparationBindings.has(step.saveAs)) {
      errors.push(`Preparation binding ${step.saveAs} is duplicated.`);
    }
    preparationBindings.add(step.saveAs);
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
    if (stepIds.has(step.id)) {
      errors.push(`Task plan step id ${step.id} is duplicated.`);
    }
    stepIds.add(step.id);
    for (const toolName of step.tools) {
      if (!findProviderToolSpec(toolName)) {
        errors.push(
          `Recurring step ${step.id} references unknown provider tool ${toolName}.`,
        );
      }
    }
    for (const selection of step.operations ?? []) {
      validateOperationSelection(step, selection, errors);
    }
    for (const binding of resourceBindings(step.instruction)) {
      if (!preparationBindings.has(binding)) {
        errors.push(
          `Recurring step ${step.id} references unknown preparation binding ${binding}.`,
        );
      }
    }
  }

  return errors.length > 0
    ? { ok: false, errors: [...new Set(errors)] }
    : { ok: true, errors: [] };
}

function resourceBindings(instruction: string): string[] {
  return [
    ...instruction.matchAll(
      /\{\{resources\.([A-Za-z][A-Za-z0-9_]{0,63})\.[a-zA-Z0-9_.]+\}\}/g,
    ),
  ].map((match) => match[1]!);
}

export async function executeScheduledTaskPreparation(input: {
  workspaceId: string;
  slackUserId: string;
  plan: SchedulerTaskPlan;
  executeTool: ScheduledTaskPreparationToolExecutor;
  operationPreflight?: ScheduledTaskOperationPreflight;
}): Promise<ScheduledTaskPreparationResult> {
  const validation = validateScheduledTaskPlan(input.plan);
  if (!validation.ok) {
    throw new Error(validation.errors.join(" "));
  }

  const operationPreflight =
    input.operationPreflight ??
    (await preflightScheduledTaskOperations({
      workspaceId: input.workspaceId,
      slackUserId: input.slackUserId,
      plan: input.plan,
      executeTool: input.executeTool,
    }));
  if (operationPreflight.errors.length > 0) {
    throw new Error(operationPreflight.errors.join(" "));
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
    ...(operationPreflight.operationGrants.length > 0
      ? { operationGrants: operationPreflight.operationGrants }
      : {}),
    stateRefs: dedupeStateRefs(stateRefs),
    resources,
  };
}

export function scheduledTaskOperationBridgeTools(
  plan: SchedulerTaskPlan,
): string[] {
  return [
    ...new Set(
      plan.steps
        .flatMap((step) => step.tools)
        .filter((toolName) => {
          const spec = findProviderToolSpec(toolName);
          return Boolean(spec?.operationNameInput);
        }),
    ),
  ].sort();
}

export async function preflightScheduledTaskOperations(input: {
  workspaceId: string;
  slackUserId: string;
  plan: SchedulerTaskPlan;
  executeTool: ScheduledTaskPreparationToolExecutor;
  catalogs?: Record<string, ScheduledTaskOperationCatalogEntry[]>;
}): Promise<ScheduledTaskOperationPreflight> {
  const bridgeTools = scheduledTaskOperationBridgeTools(input.plan);
  if (bridgeTools.length === 0) {
    return { operationGrants: [], errors: [], catalogs: {} };
  }

  const errors: string[] = [];
  const grants: AgentJobOperationGrant[] = [];
  const catalogs = { ...input.catalogs };
  for (const toolName of bridgeTools) {
    const tool = findProviderToolSpec(toolName);
    const catalogToolName = tool?.operationCatalogTool;
    if (!tool?.operationNameInput || !catalogToolName) {
      errors.push(
        `Recurring operation bridge ${toolName} does not declare a discovery tool.`,
      );
      continue;
    }
    const catalogTool = findProviderToolSpec(catalogToolName);
    if (
      !catalogTool ||
      catalogTool.provider !== tool.provider ||
      catalogTool.risk !== "read"
    ) {
      errors.push(
        `Recurring operation bridge ${toolName} declares an invalid discovery tool ${catalogToolName}.`,
      );
      continue;
    }
    let catalog = catalogs[toolName];
    if (!catalog) {
      const result = await input.executeTool({
        workspaceId: input.workspaceId,
        slackUserId: input.slackUserId,
        tool: catalogToolName,
        input: {},
        purpose: "Resolve recurring operation contracts",
      });
      catalog = normalizeOperationCatalog(result.value);
      catalogs[toolName] = catalog;
    }
    const selected = selectedOperations(input.plan, toolName);
    if (selected.length === 0) {
      errors.push(
        operationSelectionError(
          toolName,
          "requires at least one exact recurring operation",
          catalog,
        ),
      );
      continue;
    }
    for (const operation of selected) {
      const advertised = catalog.find((entry) => entry.name === operation);
      if (!advertised) {
        errors.push(
          operationSelectionError(
            toolName,
            `does not currently advertise selected operation ${operation}`,
            catalog,
          ),
        );
        continue;
      }
      grants.push({
        tool: toolName,
        operation,
        ...(advertised.description
          ? { description: advertised.description }
          : {}),
        ...(advertised.inputSchema !== undefined
          ? { inputSchema: advertised.inputSchema }
          : {}),
      });
    }
  }

  return {
    operationGrants: dedupeOperationGrants(grants),
    errors: [...new Set(errors)],
    catalogs,
  };
}

function validateOperationSelection(
  step: SchedulerTaskPlan["steps"][number],
  selection: SchedulerTaskPlanOperation,
  errors: string[],
): void {
  if (!step.tools.includes(selection.tool)) {
    errors.push(
      `Recurring step ${step.id} selects an operation for ungranted tool ${selection.tool}.`,
    );
    return;
  }
  const tool = findProviderToolSpec(selection.tool);
  if (!tool?.operationNameInput) {
    errors.push(
      `Recurring step ${step.id} selects an operation for non-bridge tool ${selection.tool}.`,
    );
  }
}

function selectedOperations(
  plan: SchedulerTaskPlan,
  toolName: string,
): string[] {
  return [
    ...new Set(
      plan.steps.flatMap((step) =>
        (step.operations ?? [])
          .filter((selection) => selection.tool === toolName)
          .map((selection) => selection.operation.trim())
          .filter(Boolean),
      ),
    ),
  ].sort();
}

function normalizeOperationCatalog(
  value: unknown,
): ScheduledTaskOperationCatalogEntry[] {
  const entries = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.tools)
      ? value.tools
      : [];
  const normalized: ScheduledTaskOperationCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const entry of entries.slice(0, 200)) {
    if (!isRecord(entry) || typeof entry.name !== "string") {
      continue;
    }
    const name = entry.name.trim();
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    normalized.push({
      name,
      ...(typeof entry.title === "string" && entry.title.trim()
        ? { title: entry.title.trim() }
        : {}),
      ...(typeof entry.description === "string" && entry.description.trim()
        ? { description: entry.description.trim() }
        : {}),
      ...(entry.inputSchema !== undefined
        ? { inputSchema: entry.inputSchema }
        : {}),
    });
  }
  return normalized.sort((left, right) => left.name.localeCompare(right.name));
}

function operationSelectionError(
  toolName: string,
  reason: string,
  catalog: ScheduledTaskOperationCatalogEntry[],
): string {
  return [
    `Dynamic operation preflight: ${toolName} ${reason}.`,
    `Advertised operations: ${JSON.stringify(
      catalog.map((entry) => ({
        name: entry.name,
        ...(entry.title ? { title: entry.title } : {}),
        ...(entry.description ? { description: entry.description } : {}),
      })),
    )}.`,
    `Select exact operations in the matching recurring step's operations array.`,
  ].join(" ");
}

function dedupeOperationGrants(
  grants: AgentJobOperationGrant[],
): AgentJobOperationGrant[] {
  const byKey = new Map<string, AgentJobOperationGrant>();
  for (const grant of grants) {
    byKey.set(`${grant.tool}\u0000${grant.operation}`, grant);
  }
  return [...byKey.values()].sort(
    (left, right) =>
      left.tool.localeCompare(right.tool) ||
      left.operation.localeCompare(right.operation),
  );
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
