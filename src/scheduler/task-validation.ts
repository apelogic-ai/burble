import type { AgentJobCapabilityRecord, ScheduledJobRecord } from "../db";
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
  "requiredTools"
>;

export function validateScheduledTask(
  record: ScheduledJobRecord,
  capability: SchedulerTaskGrant | null,
): SchedulerTaskValidation {
  const expectedTools = inferAllowedToolsForScheduledJob(record);
  const grantedTools = [...(capability?.requiredTools ?? [])].sort();
  const grantedToolSet = new Set(grantedTools);
  const errors: SchedulerTaskValidationIssue[] = [];
  const warnings: SchedulerTaskValidationIssue[] = [];

  for (const tool of expectedTools) {
    if (!grantedToolSet.has(tool)) {
      errors.push({
        code: "missing_required_tool",
        message: `Task requires ${tool} but the grant does not include it.`,
        tool,
      });
    }
  }

  if (
    expectedTools.includes("github_search_issues") &&
    grantedToolSet.has("github_list_my_pull_requests") &&
    !grantedToolSet.has("github_search_issues")
  ) {
    warnings.push({
      code: "wrong_github_pr_scope",
      message:
        "github_list_my_pull_requests only lists the authenticated user's PRs; org-wide PR monitoring needs github_search_issues.",
      tool: "github_list_my_pull_requests",
      expectedTool: "github_search_issues",
    });
  }

  return {
    ok: errors.length === 0,
    expectedTools,
    grantedTools,
    errors,
    warnings,
  };
}
