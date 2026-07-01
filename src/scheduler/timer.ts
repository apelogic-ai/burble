import { randomUUID } from "node:crypto";
import type { AgentJobRunRecord, ScheduledJobRecord, TokenStore } from "../db";
import { DEFAULT_ACTIVE_RUN_TTL_MS } from "./active-run";
import { inferAllowedToolsForScheduledJob } from "./job-capabilities";
import { validateScheduledTask } from "./task-validation";
import { formatScheduledTaskValidationFailureReason } from "./task-validation-format";
import {
  recordTaskWorkflowRunTriggered,
  recordTaskWorkflowRunValidationFailed,
  type TaskWorkflowShadowStore,
} from "../workflow/task-workflow-shadow";
import {
  TASK_WORKFLOW_VALIDATION_FAILURE_CLASS,
} from "../workflow/task-workflow";

type SchedulerTimerStore = Pick<
  TokenStore,
  | "listScheduledJobs"
  | "listAgentJobRunsForJob"
  | "listAgentJobRunsForPrincipal"
  | "createAgentJobRun"
  | "upsertAgentJobCapability"
  | "getAgentJobCapability"
>;

export type SchedulerTimer = {
  tick(): Promise<SchedulerTimerTickResult>;
  start(): void;
  stop(): void;
};

export type SchedulerTimerTickResult = {
  queuedRunIds: string[];
};

export type ScheduledJobScheduleValidation =
  | {
      ok: true;
    }
  | {
      ok: false;
      message: string;
    };

export function createSchedulerTimer(input: {
  store: SchedulerTimerStore;
  executeRun: (runId: string) => Promise<void> | void;
  now?: () => Date;
  newRunId?: () => string;
  intervalMs?: number;
  activeRunTtlMs?: number;
  workflowAuthority?: "off" | "manual" | "timer";
  workflowShadowStore?: TaskWorkflowShadowStore;
  logInfo?: (message: string) => void;
  logWarn?: (message: string) => void;
}): SchedulerTimer {
  const now = input.now ?? (() => new Date());
  const newRunId = input.newRunId ?? (() => `jobrun_${randomUUID()}`);
  const intervalMs = input.intervalMs ?? 60_000;
  const activeRunTtlMs = input.activeRunTtlMs ?? DEFAULT_ACTIVE_RUN_TTL_MS;
  const workflowTimerAuthority = input.workflowAuthority === "timer";
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
        const existingCapability = input.store.getAgentJobCapability(job.jobId);
        if (existingCapability) {
          const validation = validateScheduledTask(job, existingCapability);
          if (!validation.ok && !workflowTimerAuthority) {
            const failureReason =
              formatScheduledTaskValidationFailureReason(validation);
            const run = input.store.createAgentJobRun({
              runId: newRunId(),
              jobId: job.jobId,
              workspaceId: job.workspaceId,
              slackUserId: job.slackUserId,
              triggerSource: "schedule",
              status: "failed",
              failureReason,
              finishedAt: timestamp.toISOString(),
              now: timestamp,
            });
            recordTaskWorkflowRunValidationFailed({
              store: input.workflowShadowStore,
              run,
              failureClass: TASK_WORKFLOW_VALIDATION_FAILURE_CLASS,
              reason: failureReason,
              at: timestamp,
              logWarn: input.logWarn,
            });
            activePrincipals.add(principalKey);
            input.logWarn?.(
              [
                `Scheduled job timer failed invalid task runId=${run.runId} jobId=${job.jobId}`,
                ...validation.errors.map(
                  (issue) => `${issue.code}: ${issue.message}`,
                ),
              ].join("; "),
            );
            continue;
          }
        }
        if (!workflowTimerAuthority || !existingCapability) {
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
        }
        const run = input.store.createAgentJobRun({
          runId: newRunId(),
          jobId: job.jobId,
          workspaceId: job.workspaceId,
          slackUserId: job.slackUserId,
          triggerSource: "schedule",
          status: "queued",
          now: timestamp,
        });
        if (!workflowTimerAuthority) {
          recordTaskWorkflowRunTriggered({
            store: input.workflowShadowStore,
            run,
            at: timestamp,
            logWarn: input.logWarn,
          });
        }
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
  const cronSlotMs = scheduledJobCronDueSlotMs(job.schedule, now);
  if (cronSlotMs !== null) {
    const latestRunAtMs = latestScheduledJobRunCreatedAtMs(job, store);
    if (latestRunAtMs !== null && latestRunAtMs >= cronSlotMs) {
      return false;
    }
    const createdAtMs = Date.parse(job.createdAt);
    if (!Number.isFinite(createdAtMs) || cronSlotMs <= createdAtMs) {
      return false;
    }
    return true;
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

function latestScheduledJobRunCreatedAtMs(
  job: ScheduledJobRecord,
  store: Pick<TokenStore, "listAgentJobRunsForJob">,
): number | null {
  const latestRun = store.listAgentJobRunsForJob(job.jobId)[0];
  if (!latestRun) {
    return null;
  }
  const createdAtMs = Date.parse(latestRun.createdAt);
  return Number.isFinite(createdAtMs) ? createdAtMs : null;
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

export function validateScheduledJobSchedule(
  schedule: unknown,
): ScheduledJobScheduleValidation {
  if (!isRecord(schedule)) {
    return { ok: false, message: "schedule must be an object" };
  }
  if (schedule.kind === "interval") {
    return validateScheduledJobInterval(schedule);
  }
  if (schedule.kind === "cron") {
    return validateScheduledJobCron(schedule);
  }
  return {
    ok: false,
    message: "schedule kind must be interval or cron",
  };
}

function validateScheduledJobInterval(
  schedule: Record<string, unknown>,
): ScheduledJobScheduleValidation {
  const every = schedule.every;
  if (!isRecord(every)) {
    return { ok: false, message: "interval schedule must include every" };
  }
  const totalMs =
    intervalPartMs(every.minutes, 60_000) +
    intervalPartMs(every.hours, 60 * 60_000) +
    intervalPartMs(every.days, 24 * 60 * 60_000) +
    intervalPartMs(every.weeks, 7 * 24 * 60 * 60_000);
  if (totalMs <= 0) {
    return {
      ok: false,
      message: "interval schedule must include a positive interval",
    };
  }
  return { ok: true };
}

function validateScheduledJobCron(
  schedule: Record<string, unknown>,
): ScheduledJobScheduleValidation {
  if (schedule.timezone && schedule.timezone !== "UTC") {
    return {
      ok: false,
      message: "cron schedules currently support UTC only",
    };
  }
  if (typeof schedule.expression !== "string") {
    return { ok: false, message: "cron schedule must include expression" };
  }
  const parts = schedule.expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    return {
      ok: false,
      message: "cron schedule must use five fields",
    };
  }
  const [minuteExpr, hourExpr, dayOfMonthExpr, monthExpr, dayOfWeekExpr] =
    parts;
  const supportedFields: Array<[string, string, number, number]> = [
    ["minute", minuteExpr, 0, 59],
    ["hour", hourExpr, 0, 23],
    ["day of month", dayOfMonthExpr, 1, 31],
    ["day of week", dayOfWeekExpr, 0, 6],
  ];
  for (const [label, expression, min, max] of supportedFields) {
    if (!isSupportedCronFieldExpression(expression, min, max)) {
      return {
        ok: false,
        message: `unsupported cron field ${label}: ${expression}`,
      };
    }
  }
  if (monthExpr !== "*") {
    return {
      ok: false,
      message: `unsupported cron field month: ${monthExpr}`,
    };
  }
  return { ok: true };
}

function scheduledJobCronDueSlotMs(
  schedule: unknown,
  now: Date,
): number | null {
  if (!isRecord(schedule) || schedule.kind !== "cron") {
    return null;
  }
  if (schedule.timezone && schedule.timezone !== "UTC") {
    return null;
  }
  if (typeof schedule.expression !== "string") {
    return null;
  }

  const parts = schedule.expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    return null;
  }
  const [minuteExpr, hourExpr, dayOfMonthExpr, monthExpr, dayOfWeekExpr] =
    parts;
  if (monthExpr !== "*") {
    return null;
  }

  const slot = new Date(now);
  slot.setUTCSeconds(0, 0);

  for (let i = 0; i < 60 * 24 * 8; i += 1) {
    if (
      cronFieldMatches(slot.getUTCMinutes(), minuteExpr, 0, 59) &&
      cronFieldMatches(slot.getUTCHours(), hourExpr, 0, 23) &&
      cronFieldMatches(slot.getUTCDate(), dayOfMonthExpr, 1, 31) &&
      cronFieldMatches(slot.getUTCDay(), dayOfWeekExpr, 0, 6)
    ) {
      return slot.getTime();
    }
    slot.setUTCMinutes(slot.getUTCMinutes() - 1);
  }

  return null;
}

function cronFieldMatches(
  value: number,
  expression: string,
  min: number,
  max: number,
): boolean {
  if (!isSupportedCronFieldExpression(expression, min, max)) {
    return false;
  }
  if (expression === "*") {
    return true;
  }
  const step = /^\*\/(\d+)$/.exec(expression);
  if (step) {
    const interval = Number(step[1]);
    return (
      Number.isSafeInteger(interval) &&
      interval > 0 &&
      value >= min &&
      value <= max &&
      (value - min) % interval === 0
    );
  }
  const range = /^(\d+)-(\d+)$/.exec(expression);
  if (range) {
    const start = Number(range[1]);
    const end = Number(range[2]);
    return (
      Number.isSafeInteger(start) &&
      Number.isSafeInteger(end) &&
      start >= min &&
      end <= max &&
      start <= end &&
      value >= start &&
      value <= end
    );
  }
  const exact = Number(expression);
  return Number.isSafeInteger(exact) && exact >= min && exact <= max
    ? value === exact
    : false;
}

function isSupportedCronFieldExpression(
  expression: string,
  min: number,
  max: number,
): boolean {
  if (expression === "*") {
    return true;
  }
  const step = /^\*\/(\d+)$/.exec(expression);
  if (step) {
    const interval = Number(step[1]);
    return Number.isSafeInteger(interval) && interval > 0;
  }
  const range = /^(\d+)-(\d+)$/.exec(expression);
  if (range) {
    const start = Number(range[1]);
    const end = Number(range[2]);
    return (
      Number.isSafeInteger(start) &&
      Number.isSafeInteger(end) &&
      start >= min &&
      end <= max &&
      start <= end
    );
  }
  const exact = Number(expression);
  return Number.isSafeInteger(exact) && exact >= min && exact <= max;
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
