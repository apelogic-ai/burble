import type { AgentJobCapabilityRecord, ScheduledJobRecord } from "../db";
import {
  expandProviderToolDependencies,
  findProviderToolSpec,
  providerToolCatalog,
} from "../providers/catalog";
import { inferAllowedToolsForScheduledJob } from "./job-capabilities";

export type SchedulerTaskValidationIssue = {
  code: string;
  message: string;
  tool?: string;
  expectedTool?: string;
  stateInput?: string;
};

export type SchedulerTaskValidation = {
  ok: boolean;
  expectedTools: string[];
  grantedTools: string[];
  runtimeAdmission?: SchedulerTaskRuntimeAdmission;
  errors: SchedulerTaskValidationIssue[];
  warnings: SchedulerTaskValidationIssue[];
};

export type SchedulerTaskRuntimeAdmission =
  | {
      checked: true;
      ok: true;
      runtimeId: string;
      runtimeType: string;
    }
  | {
      checked: true;
      ok: false;
      runtimeId?: string;
      runtimeType?: string;
      reason: string;
    }
  | {
      checked: false;
      ok: true;
      reason: string;
    };

export type SchedulerTaskGrant = Pick<
  AgentJobCapabilityRecord,
  "requiredTools" | "expectedTools"
> &
  Partial<Pick<AgentJobCapabilityRecord, "stateRefs">>;

export function validateScheduledTask(
  record: ScheduledJobRecord,
  capability: SchedulerTaskGrant | null,
): SchedulerTaskValidation {
  const expectedTools = expandProviderToolDependencies(
    capability?.expectedTools === null ||
      capability?.expectedTools === undefined
      ? inferAllowedToolsForScheduledJob(record)
      : capability.expectedTools,
  );
  const grantedTools = [...(capability?.requiredTools ?? [])].sort();
  const grantedToolSet = new Set(grantedTools);
  const errors: SchedulerTaskValidationIssue[] = [];
  const warnings: SchedulerTaskValidationIssue[] = [];

  for (const tool of expectedTools) {
    if (!isExpectedToolCovered(tool, grantedToolSet)) {
      errors.push({
        code: "missing_required_tool",
        message: `Task requires ${tool} but the grant does not include it.`,
        tool,
      });
    }
    const spec = findProviderToolSpec(tool);
    for (const stateInput of spec?.stateRefRequired
      ? (spec.stateRefInputs ?? [])
      : []) {
      if (!hasBoundProviderState(capability?.stateRefs, spec!.provider)) {
        errors.push({
          code: "missing_state_ref",
          message: `Task requires a bound ${spec!.provider} state reference for ${tool}.${stateInput}.`,
          tool,
          stateInput,
        });
      }
    }
  }

  return {
    ok: errors.length === 0,
    expectedTools,
    grantedTools,
    errors,
    warnings,
  };
}

function hasBoundProviderState(
  stateRefs: unknown[] | undefined,
  provider: string,
): boolean {
  return Boolean(
    stateRefs?.some(
      (stateRef) =>
        stateRef !== null &&
        typeof stateRef === "object" &&
        !Array.isArray(stateRef) &&
        (stateRef as { provider?: unknown }).provider === provider &&
        typeof (stateRef as { id?: unknown }).id === "string" &&
        Boolean((stateRef as { id: string }).id.trim()),
    ),
  );
}

function isExpectedToolCovered(
  expectedTool: string,
  grantedToolSet: Set<string>,
): boolean {
  if (grantedToolSet.has(expectedTool)) {
    return true;
  }

  const expectedSpec = findProviderToolSpec(expectedTool);
  if (!expectedSpec) {
    return false;
  }
  return providerToolCatalog.some(
    (tool) =>
      tool.provider === expectedSpec.provider &&
      tool.grantCoverage === "provider" &&
      grantedToolSet.has(tool.name),
  );
}
