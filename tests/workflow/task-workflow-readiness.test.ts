import { describe, expect, test } from "bun:test";
import { assessTaskWorkflowAuthorityReadiness } from "../../src/workflow/task-workflow-readiness";

describe("task workflow authority readiness", () => {
  test("does not require workflow infrastructure when authority is off", () => {
    expect(
      assessTaskWorkflowAuthorityReadiness({
        authority: "off",
        hasWorkflowStore: false,
        hasMaintenanceLoop: false,
        hasReconcileLoop: false,
        hasOracleLoop: false,
      }),
    ).toEqual({ ok: true, issues: [] });
  });

  test("requires store, maintenance, reconcile, and oracle when authority is enabled", () => {
    const result = assessTaskWorkflowAuthorityReadiness({
      authority: "manual",
      hasWorkflowStore: false,
      hasMaintenanceLoop: false,
      hasReconcileLoop: false,
      hasOracleLoop: false,
    });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "missing_workflow_store",
      "missing_maintenance_loop",
      "missing_reconcile_loop",
      "missing_oracle_loop",
    ]);
  });

  test("accepts timer authority only when the workflow loops are present", () => {
    expect(
      assessTaskWorkflowAuthorityReadiness({
        authority: "timer",
        hasWorkflowStore: true,
        hasMaintenanceLoop: true,
        hasReconcileLoop: true,
        hasOracleLoop: true,
      }).ok,
    ).toBe(true);
  });
});
