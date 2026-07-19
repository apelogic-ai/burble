import type { AgentJobCapabilityRecord, ScheduledJobRecord } from "../db";
import {
  findProviderToolSpec,
  providerToolCatalog,
} from "../providers/catalog";
import { inferAllowedToolsForScheduledJob } from "./job-capabilities";

export type SchedulerTaskValidationIssue = {
  code: string;
  message: string;
  tool?: string;
  expectedTool?: string;
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
>;

export function validateScheduledTask(
  record: ScheduledJobRecord,
  capability: SchedulerTaskGrant | null,
): SchedulerTaskValidation {
  const expectedTools = [
    ...(capability?.expectedTools === null ||
    capability?.expectedTools === undefined
      ? inferAllowedToolsForScheduledJob(record)
      : capability.expectedTools),
  ].sort();
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
  }

  return {
    ok: errors.length === 0,
    expectedTools,
    grantedTools,
    errors,
    warnings,
  };
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
