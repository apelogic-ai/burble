import { randomUUID } from "node:crypto";
import type { AgentJobRunRecord, ScheduledJobRecord, TokenStore } from "../db";
import { inferAllowedToolsForScheduledJob } from "./job-capabilities";

type SchedulerTimerStore = Pick<
  TokenStore,
  | "listScheduledJobs"
  | "listAgentJobRunsForJob"
  | "listAgentJobRunsForPrincipal"
  | "createAgentJobRun"
  | "upsertAgentJobCapability"
>;

export type SchedulerTimer = {
  tick(): Promise<SchedulerTimerTickResult>;
  start(): void;
  stop(): void;
};

export type SchedulerTimerTickResult = {
  queuedRunIds: string[];
};

const DEFAULT_ACTIVE_RUN_TTL_MS = 10 * 60_000;

export function createSchedulerTimer(input: {
  store: SchedulerTimerStore;
  executeRun: (runId: string) => Promise<void> | void;
  now?: () => Date;
  newRunId?: () => string;
  intervalMs?: number;
  activeRunTtlMs?: number;
  logInfo?: (message: string) => void;
  logWarn?: (message: string) => void;
}): SchedulerTimer {
  const now = input.now ?? (() => new Date());
  const newRunId = input.newRunId ?? (() => `jobrun_${randomUUID()}`);
  const intervalMs = input.intervalMs ?? 60_000;
  const activeRunTtlMs = input.activeRunTtlMs ?? DEFAULT_ACTIVE_RUN_TTL_MS;
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking = false;

  const tick = async (): Promise<SchedulerTimerTickResult> => {
    if (ticking) {
      return { queuedRunIds: [] };
    }
    ticking = true;
    try {
      const queuedRunIds: string[] = [];
      const timestamp = now();
      const activePrincipals = new Set<string>();
      for (const job of input.store.listScheduledJobs()) {
        const principalKey = scheduledJobPrincipalKey(job);
        if (
          activePrincipals.has(principalKey) ||
          hasActiveScheduledJobRunForPrincipal(
            job,
            input.store,
            timestamp,
            activeRunTtlMs,
          )
        ) {
          continue;
        }
        if (!isScheduledJobDue(job, input.store, timestamp, activeRunTtlMs)) {
          continue;
        }
        input.store.upsertAgentJobCapability({
          jobId: job.jobId,
          workspaceId: job.workspaceId,
          slackUserId: job.slackUserId,
          requiredTools: inferAllowedToolsForScheduledJob(job),
          routeId: job.routeId,
          runtimeType: job.runtimeType,
          capabilityProfile: "scheduled_job",
          stateRefs: [],
          visibilityPolicy: {},
          now: timestamp,
        });
        const run = input.store.createAgentJobRun({
          runId: newRunId(),
          jobId: job.jobId,
          workspaceId: job.workspaceId,
          slackUserId: job.slackUserId,
          triggerSource: "schedule",
          status: "queued",
          now: timestamp,
        });
        queuedRunIds.push(run.runId);
        activePrincipals.add(principalKey);
        input.logInfo?.(
          `Scheduled job timer queued runId=${run.runId} jobId=${job.jobId}`,
        );
        Promise.resolve(input.executeRun(run.runId)).catch((error) => {
          const message =
            error instanceof Error ? error.message : "Scheduled run failed";
          input.logWarn?.(
            `Scheduled job timer execution failed runId=${run.runId} error=${message}`,
          );
        });
      }
      return { queuedRunIds };
    } finally {
      ticking = false;
    }
  };

  return {
    tick,
    start() {
      if (timer) {
        return;
      }
      timer = setInterval(() => {
        tick().catch((error) => {
          const message =
            error instanceof Error ? error.message : "Scheduled timer failed";
          input.logWarn?.(`Scheduled job timer tick failed error=${message}`);
        });
      }, intervalMs);
      if (typeof timer.unref === "function") {
        timer.unref();
      }
    },
    stop() {
      if (!timer) {
        return;
      }
      clearInterval(timer);
      timer = undefined;
    },
  };
}

function isScheduledJobDue(
  job: ScheduledJobRecord,
  store: Pick<TokenStore, "listAgentJobRunsForJob">,
  now: Date,
  activeRunTtlMs: number,
): boolean {
  if (job.state !== "scheduled") {
    return false;
  }
  const intervalMs = scheduledJobIntervalMs(job.schedule);
  if (!intervalMs) {
    return false;
  }
  const runs = store.listAgentJobRunsForJob(job.jobId);
  const latestRun = runs[0];
  if (latestRun && isActiveRun(latestRun, now, activeRunTtlMs)) {
    return false;
  }
  const anchor = latestRun?.createdAt ?? job.updatedAt ?? job.createdAt;
  const anchorMs = Date.parse(anchor);
  if (!Number.isFinite(anchorMs)) {
    return false;
  }
  return now.getTime() - anchorMs >= intervalMs;
}

function hasActiveScheduledJobRunForPrincipal(
  job: ScheduledJobRecord,
  store: Pick<TokenStore, "listAgentJobRunsForPrincipal">,
  now: Date,
  activeRunTtlMs: number,
): boolean {
  return store
    .listAgentJobRunsForPrincipal(job.workspaceId, job.slackUserId, null, 25)
    .some((run) => isActiveRun(run, now, activeRunTtlMs));
}

function scheduledJobPrincipalKey(job: ScheduledJobRecord): string {
  return `${job.workspaceId}:${job.slackUserId}`;
}

function isActiveRun(
  run: AgentJobRunRecord,
  now: Date,
  activeRunTtlMs: number,
): boolean {
  if (run.status !== "queued" && run.status !== "running") {
    return false;
  }
  const updatedAtMs = Date.parse(run.updatedAt);
  if (!Number.isFinite(updatedAtMs)) {
    return true;
  }
  return now.getTime() - updatedAtMs <= activeRunTtlMs;
}

function scheduledJobIntervalMs(schedule: unknown): number | null {
  if (!isRecord(schedule) || schedule.kind !== "interval") {
    return null;
  }
  const every = schedule.every;
  if (!isRecord(every)) {
    return null;
  }
  let totalMs = 0;
  totalMs += intervalPartMs(every.minutes, 60_000);
  totalMs += intervalPartMs(every.hours, 60 * 60_000);
  totalMs += intervalPartMs(every.days, 24 * 60 * 60_000);
  totalMs += intervalPartMs(every.weeks, 7 * 24 * 60 * 60_000);
  return totalMs > 0 ? totalMs : null;
}

function intervalPartMs(value: unknown, multiplier: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value) * multiplier;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
