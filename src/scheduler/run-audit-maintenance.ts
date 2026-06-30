import type { TokenStore } from "../db";

export const DEFAULT_SCHEDULED_RUN_AUDIT_RETENTION_DAYS = 90;
export const DEFAULT_SCHEDULED_RUN_AUDIT_PRUNE_INTERVAL_MS =
  24 * 60 * 60 * 1000;

export type ScheduledRunAuditMaintenanceResult = {
  cutoff: string;
  deleted: number;
};

export type ScheduledRunAuditMaintenanceLoop = {
  tick(): ScheduledRunAuditMaintenanceResult;
  start(): void;
  stop(): void;
};

type ScheduledRunAuditMaintenanceStore = Pick<
  TokenStore,
  "pruneAgentJobRunAuditsBefore"
>;

export function pruneScheduledRunAudit(input: {
  store: ScheduledRunAuditMaintenanceStore;
  now: Date;
  retentionDays?: number;
}): ScheduledRunAuditMaintenanceResult {
  const retentionDays = normalizeRetentionDays(input.retentionDays);
  const cutoff = new Date(
    input.now.getTime() - retentionDays * 24 * 60 * 60 * 1000
  );
  return {
    cutoff: cutoff.toISOString(),
    deleted: input.store.pruneAgentJobRunAuditsBefore(cutoff)
  };
}

export function createScheduledRunAuditMaintenanceLoop(input: {
  store: ScheduledRunAuditMaintenanceStore;
  retentionDays?: number;
  intervalMs?: number;
  now?: () => Date;
  logInfo?: (message: string) => void;
  logWarn?: (message: string) => void;
}): ScheduledRunAuditMaintenanceLoop {
  const now = input.now ?? (() => new Date());
  const intervalMs =
    input.intervalMs ?? DEFAULT_SCHEDULED_RUN_AUDIT_PRUNE_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;

  const tick = (): ScheduledRunAuditMaintenanceResult => {
    if (running) {
      return {
        cutoff: new Date(0).toISOString(),
        deleted: 0
      };
    }
    running = true;
    try {
      const result = pruneScheduledRunAudit({
        store: input.store,
        now: now(),
        retentionDays: input.retentionDays
      });
      if (result.deleted > 0) {
        input.logInfo?.(
          `Scheduled run audit pruned deleted=${result.deleted} cutoff=${result.cutoff}`
        );
      }
      return result;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "unknown audit prune error";
      input.logWarn?.(`Scheduled run audit prune failed error=${message}`);
      return {
        cutoff: new Date(0).toISOString(),
        deleted: 0
      };
    } finally {
      running = false;
    }
  };

  return {
    tick,
    start() {
      if (timer) {
        return;
      }
      timer = setInterval(tick, intervalMs);
      if ("unref" in timer && typeof timer.unref === "function") {
        timer.unref();
      }
    },
    stop() {
      if (!timer) {
        return;
      }
      clearInterval(timer);
      timer = undefined;
    }
  };
}

function normalizeRetentionDays(retentionDays: number | undefined): number {
  return Number.isFinite(retentionDays) && retentionDays && retentionDays > 0
    ? retentionDays
    : DEFAULT_SCHEDULED_RUN_AUDIT_RETENTION_DAYS;
}
