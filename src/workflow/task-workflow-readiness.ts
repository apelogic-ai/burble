export type TaskWorkflowAuthority = "off" | "manual" | "timer";

export type TaskWorkflowAuthorityReadinessIssueCode =
  | "missing_workflow_store"
  | "missing_maintenance_loop"
  | "missing_reconcile_loop"
  | "missing_oracle_loop";

export type TaskWorkflowAuthorityReadinessIssue = {
  code: TaskWorkflowAuthorityReadinessIssueCode;
  message: string;
};

export type TaskWorkflowAuthorityReadinessResult = {
  ok: boolean;
  issues: TaskWorkflowAuthorityReadinessIssue[];
};

export function assessTaskWorkflowAuthorityReadiness(input: {
  authority: TaskWorkflowAuthority;
  hasWorkflowStore: boolean;
  hasMaintenanceLoop: boolean;
  hasReconcileLoop: boolean;
  hasOracleLoop: boolean;
}): TaskWorkflowAuthorityReadinessResult {
  if (input.authority === "off") {
    return { ok: true, issues: [] };
  }

  const issues: TaskWorkflowAuthorityReadinessIssue[] = [];
  if (!input.hasWorkflowStore) {
    issues.push({
      code: "missing_workflow_store",
      message: "Workflow authority requires a persistent workflow event store.",
    });
  }
  if (!input.hasMaintenanceLoop) {
    issues.push({
      code: "missing_maintenance_loop",
      message: "Workflow authority requires workflow maintenance/compaction.",
    });
  }
  if (!input.hasReconcileLoop) {
    issues.push({
      code: "missing_reconcile_loop",
      message: "Workflow authority requires stale-run reconciliation.",
    });
  }
  if (!input.hasOracleLoop) {
    issues.push({
      code: "missing_oracle_loop",
      message: "Workflow authority requires the shadow oracle loop.",
    });
  }

  return {
    ok: issues.length === 0,
    issues,
  };
}
