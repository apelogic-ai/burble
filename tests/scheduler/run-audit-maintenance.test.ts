import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SCHEDULED_RUN_AUDIT_RETENTION_DAYS,
  createScheduledRunAuditMaintenanceLoop,
  pruneScheduledRunAudit
} from "../../src/scheduler/run-audit-maintenance";

describe("scheduled run audit maintenance", () => {
  test("prunes audits older than the retention window", () => {
    const prunedCutoffs: string[] = [];
    const result = pruneScheduledRunAudit({
      store: {
        pruneAgentJobRunAuditsBefore(before) {
          prunedCutoffs.push(before.toISOString());
          return 3;
        }
      },
      now: new Date("2026-06-30T12:00:00.000Z"),
      retentionDays: 7
    });

    expect(result).toEqual({
      cutoff: "2026-06-23T12:00:00.000Z",
      deleted: 3
    });
    expect(prunedCutoffs).toEqual(["2026-06-23T12:00:00.000Z"]);
  });

  test("uses the default retention window when input is invalid", () => {
    const result = pruneScheduledRunAudit({
      store: {
        pruneAgentJobRunAuditsBefore(before) {
          expect(before.toISOString()).toBe("2026-04-01T12:00:00.000Z");
          return 1;
        }
      },
      now: new Date("2026-06-30T12:00:00.000Z"),
      retentionDays: 0
    });

    expect(result.deleted).toBe(1);
    expect(DEFAULT_SCHEDULED_RUN_AUDIT_RETENTION_DAYS).toBe(90);
  });

  test("logs prune failures without throwing from the loop", () => {
    const warnings: string[] = [];
    const loop = createScheduledRunAuditMaintenanceLoop({
      store: {
        pruneAgentJobRunAuditsBefore() {
          throw new Error("database locked");
        }
      },
      now: () => new Date("2026-06-30T12:00:00.000Z"),
      logWarn: (message) => warnings.push(message)
    });

    expect(loop.tick()).toEqual({
      cutoff: "1970-01-01T00:00:00.000Z",
      deleted: 0
    });
    expect(warnings).toEqual([
      "Scheduled run audit prune failed error=database locked"
    ]);
  });
});
