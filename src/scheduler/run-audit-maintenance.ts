import type { TokenStore } from "../db";

export const DEFAULT_SCHEDULED_RUN_AUDIT_RETENTION_DAYS = 90;
export const DEFAULT_SCHEDULED_RUN_AUDIT_PRUNE_INTERVAL_MS =
  24 * 60 * 60 * 1000;
export const MAX_SCHEDULED_RUN_AUDIT_PRUNE_INTERVAL_MS =
  7 * 24 * 60 * 60 * 1000;
export const DEFAULT_SCHEDULED_RUN_AUDIT_PRUNE_BATCH_SIZE = 1000;

export type ScheduledRunAuditMaintenanceResult =
  | {
      status: "pruned";
      cutoff: string;
      deleted: number;
    }
  | {
      status: "skipped";
      reason: "already_running";
      deleted: 0;
    }
  | {
      status: "failed";
      error: string;
      deleted: 0;
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
  batchSize?: number;
}): ScheduledRunAuditMaintenanceResult {
  const retentionDays = normalizeRetentionDays(input.retentionDays);
  const batchSize = normalizePositiveInt(
    input.batchSize,
    DEFAULT_SCHEDULED_RUN_AUDIT_PRUNE_BATCH_SIZE
  );
  const cutoff = new Date(
    input.now.getTime() - retentionDays * 24 * 60 * 60 * 1000
  );
  return {
    status: "pruned",
    cutoff: cutoff.toISOString(),
    deleted: input.store.pruneAgentJobRunAuditsBefore(cutoff, batchSize)
  };
}

export function createScheduledRunAuditMaintenanceLoop(input: {
  store: ScheduledRunAuditMaintenanceStore;
  retentionDays?: number;
  intervalMs?: number;
  batchSize?: number;
  now?: () => Date;
  logInfo?: (message: string) => void;
  logWarn?: (message: string) => void;
}): ScheduledRunAuditMaintenanceLoop {
  const now = input.now ?? (() => new Date());
  const intervalMs = normalizePruneIntervalMs(input.intervalMs);
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;

  const tick = (): ScheduledRunAuditMaintenanceResult => {
    if (running) {
      return {
        status: "skipped",
        reason: "already_running",
        deleted: 0
      };
    }
    running = true;
    try {
      const result = pruneScheduledRunAudit({
        store: input.store,
        now: now(),
        retentionDays: input.retentionDays,
        batchSize: input.batchSize
      });
      if (result.status === "pruned" && result.deleted > 0) {
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
        status: "failed",
        error: message,
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
      tick();
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
  return typeof retentionDays === "number" &&
    Number.isFinite(retentionDays) &&
    retentionDays > 0
    ? retentionDays
    : DEFAULT_SCHEDULED_RUN_AUDIT_RETENTION_DAYS;
}

function normalizePruneIntervalMs(intervalMs: number | undefined): number {
  return Math.min(
    normalizePositiveInt(
      intervalMs,
      DEFAULT_SCHEDULED_RUN_AUDIT_PRUNE_INTERVAL_MS
    ),
    MAX_SCHEDULED_RUN_AUDIT_PRUNE_INTERVAL_MS
  );
}

function normalizePositiveInt(
  value: number | undefined,
  fallback: number
): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}
