import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SCHEDULED_RUN_AUDIT_RETENTION_DAYS,
  DEFAULT_SCHEDULED_RUN_AUDIT_PRUNE_BATCH_SIZE,
  createScheduledRunAuditMaintenanceLoop,
  pruneScheduledRunAudit,
  type ScheduledRunAuditMaintenanceResult
} from "../../src/scheduler/run-audit-maintenance";

describe("scheduled run audit maintenance", () => {
  test("prunes audits older than the retention window", () => {
    const prunedCutoffs: string[] = [];
    const pruneLimits: number[] = [];
    const result = pruneScheduledRunAudit({
      store: {
        pruneAgentJobRunAuditsBefore(before, limit) {
          prunedCutoffs.push(before.toISOString());
          pruneLimits.push(limit ?? 0);
          return 3;
        }
      },
      now: new Date("2026-06-30T12:00:00.000Z"),
      retentionDays: 7
    });

    expect(result).toEqual({
      status: "pruned",
      cutoff: "2026-06-23T12:00:00.000Z",
      deleted: 3
    });
    expect(prunedCutoffs).toEqual(["2026-06-23T12:00:00.000Z"]);
    expect(pruneLimits).toEqual([DEFAULT_SCHEDULED_RUN_AUDIT_PRUNE_BATCH_SIZE]);
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
      status: "failed",
      error: "database locked",
      deleted: 0
    });
    expect(warnings).toEqual([
      "Scheduled run audit prune failed error=database locked"
    ]);
  });

  test("reports reentrant ticks as skipped without a fake cutoff", () => {
    let nestedResult: ScheduledRunAuditMaintenanceResult | undefined;
    let loop!: ReturnType<typeof createScheduledRunAuditMaintenanceLoop>;
    loop = createScheduledRunAuditMaintenanceLoop({
      store: {
        pruneAgentJobRunAuditsBefore() {
          nestedResult = loop.tick();
          return 1;
        }
      },
      now: () => new Date("2026-06-30T12:00:00.000Z")
    });

    expect(loop.tick()).toMatchObject({
      status: "pruned",
      deleted: 1
    });
    expect(nestedResult).toEqual({
      status: "skipped",
      reason: "already_running",
      deleted: 0
    });
  });

  test("runs an immediate prune when the loop starts", () => {
    let prunes = 0;
    const loop = createScheduledRunAuditMaintenanceLoop({
      store: {
        pruneAgentJobRunAuditsBefore() {
          prunes += 1;
          return 0;
        }
      },
      now: () => new Date("2026-06-30T12:00:00.000Z")
    });

    loop.start();
    loop.stop();

    expect(prunes).toBe(1);
  });
});
