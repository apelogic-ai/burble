import type { AgentJobRunRecord, AgentJobRunStatus } from "../db";
import type {
  TaskWorkflowRunState,
  TaskWorkflowRunStatus,
  TaskWorkflowState,
} from "./task-workflow";

export type TaskWorkflowOracleMismatchKind =
  | "missing_workflow_run"
  | "missing_authoritative_run"
  | "job_id_mismatch"
  | "trigger_source_mismatch"
  | "status_mismatch"
  | "terminal_mismatch"
  | "failure_reason_mismatch"
  | "oracle_failed";

export type TaskWorkflowOracleMismatch = {
  kind: TaskWorkflowOracleMismatchKind;
  runId: string;
  jobId?: string;
  authoritativeStatus?: AgentJobRunStatus;
  workflowStatus?: TaskWorkflowRunStatus;
  expected?: string;
  actual?: string;
};

export type TaskWorkflowOracleResult = {
  ok: boolean;
  mismatches: TaskWorkflowOracleMismatch[];
};

export type TaskWorkflowOracleLoop = {
  tick(): Promise<TaskWorkflowOracleResult>;
  start(): void;
  stop(): void;
};

export function compareTaskWorkflowProjection(input: {
  workflowState: TaskWorkflowState;
  authoritativeRuns: AgentJobRunRecord[];
}): TaskWorkflowOracleResult {
  const workflowRuns = input.workflowState.runs;
  const authoritativeByRunId = new Map(
    input.authoritativeRuns.map((run) => [run.runId, run]),
  );
  const mismatches: TaskWorkflowOracleMismatch[] = [];

  for (const authoritativeRun of input.authoritativeRuns) {
    const workflowRun = workflowRuns[authoritativeRun.runId];
    if (!workflowRun) {
      mismatches.push({
        kind: "missing_workflow_run",
        runId: authoritativeRun.runId,
        jobId: authoritativeRun.jobId,
        authoritativeStatus: authoritativeRun.status,
      });
      continue;
    }

    mismatches.push(
      ...compareRunPair({
        authoritativeRun,
        workflowRun,
      }),
    );
  }

  for (const workflowRun of Object.values(workflowRuns)) {
    if (!authoritativeByRunId.has(workflowRun.jobRunId)) {
      mismatches.push({
        kind: "missing_authoritative_run",
        runId: workflowRun.jobRunId,
        jobId: workflowRun.taskId,
        workflowStatus: workflowRun.status,
      });
    }
  }

  return {
    ok: mismatches.length === 0,
    mismatches,
  };
}

export function createTaskWorkflowOracleLoop(input: {
  replayWorkflowState: () => TaskWorkflowState;
  listAuthoritativeRuns: () => AgentJobRunRecord[] | Promise<AgentJobRunRecord[]>;
  intervalMs?: number;
  logWarn?: (message: string) => void;
  logInfo?: (message: string) => void;
}): TaskWorkflowOracleLoop {
  const intervalMs = input.intervalMs ?? 5 * 60_000;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;

  const tick = async (): Promise<TaskWorkflowOracleResult> => {
    if (running) {
      return { ok: true, mismatches: [] };
    }
    running = true;
    try {
      const result = compareTaskWorkflowProjection({
        workflowState: input.replayWorkflowState(),
        authoritativeRuns: await input.listAuthoritativeRuns(),
      });
      if (!result.ok) {
        input.logWarn?.(
          `Task workflow oracle found mismatches count=${result.mismatches.length} details=${JSON.stringify(
            result.mismatches.slice(0, 20),
          )}`,
        );
      } else {
        input.logInfo?.("Task workflow oracle found no mismatches");
      }
      return result;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "unknown workflow oracle error";
      input.logWarn?.(`Task workflow oracle failed error=${message}`);
      return {
        ok: false,
        mismatches: [
          {
            kind: "oracle_failed",
            runId: "oracle",
            expected: "oracle_tick",
            actual: message,
          },
        ],
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
      timer = setInterval(() => {
        void tick();
      }, intervalMs);
      if ("unref" in timer && typeof timer.unref === "function") {
        timer.unref();
      }
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}

function compareRunPair(input: {
  authoritativeRun: AgentJobRunRecord;
  workflowRun: TaskWorkflowRunState;
}): TaskWorkflowOracleMismatch[] {
  const mismatches: TaskWorkflowOracleMismatch[] = [];
  const { authoritativeRun, workflowRun } = input;

  if (authoritativeRun.jobId !== workflowRun.taskId) {
    mismatches.push({
      kind: "job_id_mismatch",
      runId: authoritativeRun.runId,
      jobId: authoritativeRun.jobId,
      expected: authoritativeRun.jobId,
      actual: workflowRun.taskId,
      authoritativeStatus: authoritativeRun.status,
      workflowStatus: workflowRun.status,
    });
  }

  if (authoritativeRun.triggerSource !== workflowRun.source) {
    mismatches.push({
      kind: "trigger_source_mismatch",
      runId: authoritativeRun.runId,
      jobId: authoritativeRun.jobId,
      expected: authoritativeRun.triggerSource,
      actual: workflowRun.source,
      authoritativeStatus: authoritativeRun.status,
      workflowStatus: workflowRun.status,
    });
  }

  if (!statusProjectionMatches(authoritativeRun.status, workflowRun.status)) {
    mismatches.push({
      kind: "status_mismatch",
      runId: authoritativeRun.runId,
      jobId: authoritativeRun.jobId,
      expected: authoritativeRun.status,
      actual: workflowRun.status,
      authoritativeStatus: authoritativeRun.status,
      workflowStatus: workflowRun.status,
    });
  }

  if (
    isAuthoritativeTerminal(authoritativeRun.status) !==
    isWorkflowTerminal(workflowRun.status)
  ) {
    mismatches.push({
      kind: "terminal_mismatch",
      runId: authoritativeRun.runId,
      jobId: authoritativeRun.jobId,
      authoritativeStatus: authoritativeRun.status,
      workflowStatus: workflowRun.status,
    });
  }

  if (
    authoritativeRun.status === "failed" &&
    workflowRun.status === "failed" &&
    authoritativeRun.failureReason &&
    workflowRun.failureReason &&
    authoritativeRun.failureReason !== workflowRun.failureReason
  ) {
    mismatches.push({
      kind: "failure_reason_mismatch",
      runId: authoritativeRun.runId,
      jobId: authoritativeRun.jobId,
      expected: authoritativeRun.failureReason,
      actual: workflowRun.failureReason,
      authoritativeStatus: authoritativeRun.status,
      workflowStatus: workflowRun.status,
    });
  }

  return mismatches;
}

function statusProjectionMatches(
  authoritativeStatus: AgentJobRunStatus,
  workflowStatus: TaskWorkflowRunStatus,
): boolean {
  switch (authoritativeStatus) {
    case "queued":
      return workflowStatus === "created" || workflowStatus === "validating";
    case "running":
      return workflowStatus === "running" || workflowStatus === "delivering";
    case "succeeded":
      return workflowStatus === "succeeded";
    case "failed":
      return workflowStatus === "failed" || workflowStatus === "paused_after_failures";
  }
}

function isAuthoritativeTerminal(status: AgentJobRunStatus): boolean {
  return status === "succeeded" || status === "failed";
}

function isWorkflowTerminal(status: TaskWorkflowRunStatus): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "paused_after_failures"
  );
}
