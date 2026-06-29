import { randomUUID } from "node:crypto";
import type {
  AgentJobRunRecord,
  AgentRuntimeEngine,
  ConversationRouteRecord,
  ScheduledJobRecord,
  TokenStore,
} from "../db";
import { inferAllowedToolsForScheduledJob } from "./job-capabilities";
import {
  validateScheduledTask,
  type SchedulerTaskGrant,
  type SchedulerTaskValidation,
  type SchedulerTaskValidationIssue,
} from "./task-validation";
import { validateScheduledJobSchedule } from "./timer";
import { DEFAULT_ACTIVE_RUN_TTL_MS } from "./active-run";
import {
  recordTaskWorkflowRunTriggered,
  recordTaskWorkflowRunValidationFailed,
  type TaskWorkflowShadowStore,
} from "../workflow/task-workflow-shadow";
import { TASK_WORKFLOW_VALIDATION_FAILURE_CLASS } from "../workflow/task-workflow";
import { formatScheduledTaskValidationFailureReason } from "./task-validation-format";

export type {
  SchedulerTaskGrant,
  SchedulerTaskValidation,
  SchedulerTaskValidationIssue,
} from "./task-validation";

export type SchedulerJobSummary = {
  jobId: string;
  title: string | null;
  prompt: string | null;
  schedule: unknown | null;
  state: "scheduled" | "paused";
  runtimeType: string | null;
  requiredTools: string[];
  routeId: string | null;
  updatedAt: string;
};

export type SchedulerTaskSummary = SchedulerJobSummary & {
  taskId: string;
};

export type SchedulerControlPlane = {
  listJobs(input: {
    workspaceId: string;
    slackUserId: string;
  }): Promise<SchedulerJobSummary[]> | SchedulerJobSummary[];
  listJobRuns?(
    input: SchedulerListJobRunsInput,
  ): Promise<SchedulerJobRunListResult> | SchedulerJobRunListResult;
  listTasks?(
    input: SchedulerListTasksInput,
  ): Promise<SchedulerTaskSummary[]> | SchedulerTaskSummary[];
  showTask?(
    input: SchedulerShowTaskInput,
  ): Promise<SchedulerShowTaskResult> | SchedulerShowTaskResult;
  validateTask?(
    input: SchedulerValidateTaskInput,
  ): Promise<SchedulerValidateTaskResult> | SchedulerValidateTaskResult;
  createJob?(
    input: SchedulerCreateJobInput,
  ): Promise<SchedulerCreateJobResult> | SchedulerCreateJobResult;
  pauseJob?(
    input: SchedulerJobMutationInput,
  ): Promise<SchedulerJobMutationResult> | SchedulerJobMutationResult;
  resumeJob?(
    input: SchedulerJobMutationInput,
  ): Promise<SchedulerJobMutationResult> | SchedulerJobMutationResult;
  deleteJob?(
    input: SchedulerJobMutationInput,
  ): Promise<SchedulerJobDeleteResult> | SchedulerJobDeleteResult;
  updateJobDelivery?(
    input: SchedulerUpdateJobDeliveryInput,
  ):
    | Promise<SchedulerUpdateJobDeliveryResult>
    | SchedulerUpdateJobDeliveryResult;
  updateJobSchedule?(
    input: SchedulerUpdateJobScheduleInput,
  ):
    | Promise<SchedulerUpdateJobScheduleResult>
    | SchedulerUpdateJobScheduleResult;
  updateJobPrompt?(
    input: SchedulerUpdateJobPromptInput,
  ): Promise<SchedulerUpdateJobPromptResult> | SchedulerUpdateJobPromptResult;
  triggerJob?(input: {
    workspaceId: string;
    slackUserId: string;
    jobId?: string | null;
  }): Promise<SchedulerTriggerResult> | SchedulerTriggerResult;
  getLatestRunStatus?(input: {
    workspaceId: string;
    slackUserId: string;
    jobId?: string | null;
  }): Promise<SchedulerRunStatusResult> | SchedulerRunStatusResult;
};

export type SchedulerTriggerResult =
  | {
      ok: true;
      jobId: string;
      run: AgentJobRunRecord;
    }
  | {
      ok: false;
      reason: "no_jobs" | "not_found" | "ambiguous";
      jobs: SchedulerJobSummary[];
    }
  | {
      ok: false;
      reason: "validation_failed";
      task: SchedulerTaskSummary;
      validation: SchedulerTaskValidation;
    }
  | {
      ok: false;
      reason: "already_running";
      jobId: string;
      run: AgentJobRunRecord;
    }
  | {
      ok: false;
      reason: "recent_validation_failure";
      jobId: string;
      run: AgentJobRunRecord;
    };

export type SchedulerListJobRunsInput = {
  workspaceId: string;
  slackUserId: string;
  jobId?: string | null;
  limit?: number | null;
};

export type SchedulerListTasksInput = {
  workspaceId: string;
  slackUserId: string;
};

export type SchedulerValidateTaskInput = {
  workspaceId: string;
  slackUserId: string;
  taskId?: string | null;
  jobId?: string | null;
};

export type SchedulerShowTaskInput = SchedulerValidateTaskInput;

export type SchedulerShowTaskResult =
  | {
      ok: true;
      task: SchedulerTaskSummary;
      validation: SchedulerTaskValidation;
    }
  | {
      ok: false;
      reason: "no_jobs" | "not_found" | "ambiguous";
      tasks: SchedulerTaskSummary[];
    };

export type SchedulerJobRunListResult = {
  runs: AgentJobRunRecord[];
};

export type SchedulerValidateTaskResult =
  | {
      ok: true;
      taskId: string;
      validation: SchedulerTaskValidation;
    }
  | {
      ok: false;
      reason: "no_jobs" | "not_found" | "ambiguous";
      tasks: SchedulerTaskSummary[];
    };

export type SchedulerCreateJobInput = {
  workspaceId: string;
  slackUserId: string;
  title: string;
  prompt: string;
  schedule: unknown;
  routeId?: string | null;
  runtimeType?: AgentRuntimeEngine | null;
};

export type SchedulerCreateJobResult =
  | {
      ok: true;
      job: ScheduledJobRecord;
    }
  | {
      ok: false;
      reason: "invalid_schedule";
      message: string;
    };

export type SchedulerJobMutationInput = {
  workspaceId: string;
  slackUserId: string;
  jobId?: string | null;
};

export type SchedulerUpdateJobDeliveryInput = SchedulerJobMutationInput & {
  routeId?: string | null;
  channelId?: string | null;
  channelName?: string | null;
};

export type SchedulerUpdateJobScheduleInput = SchedulerJobMutationInput & {
  schedule: unknown;
};

export type SchedulerUpdateJobPromptInput = SchedulerJobMutationInput & {
  prompt: string;
};

export type SchedulerJobMutationResult =
  | {
      ok: true;
      job: ScheduledJobRecord;
    }
  | {
      ok: false;
      reason: "no_jobs" | "not_found" | "ambiguous";
      jobs: SchedulerJobSummary[];
    };

export type SchedulerUpdateJobDeliveryResult =
  | {
      ok: true;
      job: ScheduledJobRecord;
      routeId: string;
    }
  | {
      ok: false;
      reason:
        | "no_jobs"
        | "not_found"
        | "ambiguous"
        | "no_destination"
        | "no_grant"
        | "unresolved_channel";
      jobs: SchedulerJobSummary[];
      channelId?: string | null;
      channelName?: string | null;
    };

export type SchedulerUpdateJobScheduleResult =
  | SchedulerJobMutationResult
  | {
      ok: false;
      reason: "invalid_schedule";
      message: string;
      jobs: SchedulerJobSummary[];
    };
export type SchedulerUpdateJobPromptResult = SchedulerJobMutationResult;

export type SchedulerJobDeleteResult =
  | {
      ok: true;
      jobId: string;
    }
  | {
      ok: false;
      reason: "no_jobs" | "not_found" | "ambiguous";
      jobs: SchedulerJobSummary[];
    };

export type SchedulerRunStatusResult =
  | {
      ok: true;
      run: AgentJobRunRecord;
    }
  | {
      ok: false;
      reason: "no_runs";
    };

type SchedulerControlPlaneOptions = {
  now?: () => Date;
  newJobId?: () => string;
  newRunId?: () => string;
  workflowAuthority?: "off" | "manual";
  workflowShadowStore?: TaskWorkflowShadowStore;
  logWarn?: (message: string) => void;
  resolveSlackChannelIdByName?: (input: {
    workspaceId: string;
    channelName: string;
  }) => Promise<string | null> | string | null;
};

export function createSchedulerControlPlane(
  store: Pick<
    TokenStore,
    | "listScheduledJobsForPrincipal"
    | "upsertScheduledJob"
    | "deleteScheduledJob"
    | "createAgentJobRun"
    | "listAgentJobRunsForPrincipal"
    | "findRecentFailedAgentJobRunForPrincipal"
    | "upsertAgentJobCapability"
    | "getAgentJobCapability"
    | "getLatestAgentJobRunForPrincipal"
    | "getConversationGrantRouteForSlackChannel"
  >,
  options: SchedulerControlPlaneOptions = {},
): SchedulerControlPlane {
  const now = options.now ?? (() => new Date());
  const newJobId = options.newJobId ?? (() => `job_${randomUUID()}`);
  const newRunId = options.newRunId ?? (() => `jobrun_${randomUUID()}`);
  const workflowAuthority = options.workflowAuthority ?? "off";
  const listJobs = (input: {
    workspaceId: string;
    slackUserId: string;
  }): SchedulerJobSummary[] => {
    return store
      .listScheduledJobsForPrincipal(input.workspaceId, input.slackUserId)
      .map(summarizeScheduledJob);
  };
  const listTasks = (input: SchedulerListTasksInput): SchedulerTaskSummary[] =>
    store
      .listScheduledJobsForPrincipal(input.workspaceId, input.slackUserId)
      .map((record) =>
        summarizeScheduledTask(
          record,
          store.getAgentJobCapability(record.jobId),
        ),
      );

  return {
    listJobs,
    listJobRuns(input) {
      return {
        runs: store.listAgentJobRunsForPrincipal(
          input.workspaceId,
          input.slackUserId,
          input.jobId,
          input.limit ?? 10,
        ),
      };
    },
    listTasks,
    showTask(input) {
      const records = store.listScheduledJobsForPrincipal(
        input.workspaceId,
        input.slackUserId,
      );
      const tasks = records.map((record) =>
        summarizeScheduledTask(
          record,
          store.getAgentJobCapability(record.jobId),
        ),
      );
      const selection = selectSchedulerJob(tasks, input.taskId ?? input.jobId);
      if (!selection.ok) {
        return { ok: false, reason: selection.reason, tasks };
      }
      const record = records.find((job) => job.jobId === selection.job.jobId);
      if (!record) {
        return { ok: false, reason: "not_found", tasks };
      }
      return {
        ok: true,
        task: selection.job,
        validation: validateScheduledTask(
          record,
          store.getAgentJobCapability(record.jobId),
        ),
      };
    },
    validateTask(input) {
      const records = store.listScheduledJobsForPrincipal(
        input.workspaceId,
        input.slackUserId,
      );
      const tasks = records.map((record) =>
        summarizeScheduledTask(
          record,
          store.getAgentJobCapability(record.jobId),
        ),
      );
      const selection = selectSchedulerJob(tasks, input.taskId ?? input.jobId);
      if (!selection.ok) {
        return { ok: false, reason: selection.reason, tasks };
      }
      const record = records.find((job) => job.jobId === selection.job.jobId);
      if (!record) {
        return { ok: false, reason: "not_found", tasks };
      }
      return {
        ok: true,
        taskId: record.jobId,
        validation: validateScheduledTask(
          record,
          store.getAgentJobCapability(record.jobId),
        ),
      };
    },
    createJob(input) {
      const scheduleValidation = validateScheduledJobSchedule(input.schedule);
      if (!scheduleValidation.ok) {
        return {
          ok: false,
          reason: "invalid_schedule",
          message: scheduleValidation.message,
        };
      }
      const jobId = newJobId();
      const timestamp = now();
      const job = store.upsertScheduledJob({
        jobId,
        workspaceId: input.workspaceId,
        slackUserId: input.slackUserId,
        title: input.title,
        prompt: input.prompt,
        schedule: input.schedule,
        routeId: input.routeId,
        runtimeType: input.runtimeType,
        state: "scheduled",
        now: timestamp,
      });
      ensureScheduledJobCapability(store, job, timestamp);
      return {
        ok: true,
        job,
      };
    },
    pauseJob(input) {
      return updateScheduledJobState(store, input, "paused", now());
    },
    resumeJob(input) {
      return updateScheduledJobState(store, input, "scheduled", now());
    },
    deleteJob(input) {
      const jobs = store
        .listScheduledJobsForPrincipal(input.workspaceId, input.slackUserId)
        .map(summarizeScheduledJob);
      const selection = selectSchedulerJob(jobs, input.jobId);
      if (!selection.ok) {
        return selection;
      }
      store.deleteScheduledJob(selection.job.jobId);
      return { ok: true, jobId: selection.job.jobId };
    },
    updateJobDelivery(input) {
      return updateScheduledJobDelivery(
        store,
        input,
        now(),
        options.resolveSlackChannelIdByName,
      );
    },
    updateJobSchedule(input) {
      return updateScheduledJobSchedule(store, input, now());
    },
    updateJobPrompt(input) {
      return updateScheduledJobPrompt(store, input, now());
    },
    triggerJob(input) {
      const jobs = listJobs(input);
      const job = selectSchedulerJob(jobs, input.jobId);
      if (!job.ok) {
        return job;
      }
      const timestamp = now();
      const record = store
        .listScheduledJobsForPrincipal(input.workspaceId, input.slackUserId)
        .find((candidate) => candidate.jobId === job.job.jobId);
      if (record) {
        let capability: SchedulerTaskGrant | null = store.getAgentJobCapability(
          record.jobId,
        );
        if (!capability) {
          ensureScheduledJobCapability(store, record, timestamp);
          capability = {
            requiredTools: inferAllowedToolsForScheduledJob(record),
          };
        }
        const validation = validateScheduledTask(record, capability);
        if (!validation.ok) {
          if (workflowAuthority === "manual") {
            const failureReason =
              formatScheduledTaskValidationFailureReason(validation);
            const recentFailure = findRecentFailedScheduledJobRun(
              store,
              input.workspaceId,
              input.slackUserId,
              record.jobId,
              timestamp,
              failureReason,
            );
            if (recentFailure) {
              return {
                ok: false,
                reason: "recent_validation_failure",
                jobId: record.jobId,
                run: recentFailure,
              };
            }
            const failedRun = store.createAgentJobRun({
              runId: newRunId(),
              jobId: record.jobId,
              workspaceId: input.workspaceId,
              slackUserId: input.slackUserId,
              triggerSource: "manual",
              status: "failed",
              failureReason,
              finishedAt: timestamp.toISOString(),
              now: timestamp,
            });
            recordTaskWorkflowRunValidationFailed({
              store: options.workflowShadowStore,
              run: failedRun,
              failureClass: TASK_WORKFLOW_VALIDATION_FAILURE_CLASS,
              reason: failedRun.failureReason ?? "Scheduled task validation failed.",
              at: timestamp,
              logWarn: options.logWarn,
            });
          }
          return {
            ok: false,
            reason: "validation_failed",
            task: summarizeScheduledTask(record, capability),
            validation,
          };
        }
      }
      const activeRun = findActiveScheduledJobRun(
        store,
        input.workspaceId,
        input.slackUserId,
        job.job.jobId,
        timestamp,
      );
      if (activeRun) {
        return {
          ok: false,
          reason: "already_running",
          jobId: job.job.jobId,
          run: activeRun,
        };
      }

      const run = store.createAgentJobRun({
        runId: newRunId(),
        jobId: job.job.jobId,
        workspaceId: input.workspaceId,
        slackUserId: input.slackUserId,
        triggerSource: "manual",
        status: "queued",
        now: timestamp,
      });
      recordTaskWorkflowRunTriggered({
        store: options.workflowShadowStore,
        run,
        at: timestamp,
      });
      return {
        ok: true,
        jobId: job.job.jobId,
        run,
      };
    },
    getLatestRunStatus(input) {
      const run = store.getLatestAgentJobRunForPrincipal(
        input.workspaceId,
        input.slackUserId,
        input.jobId,
      );
      return run ? { ok: true, run } : { ok: false, reason: "no_runs" };
    },
  };
}

function updateScheduledJobSchedule(
  store: Pick<
    TokenStore,
    | "listScheduledJobsForPrincipal"
    | "upsertScheduledJob"
    | "upsertAgentJobCapability"
  >,
  input: SchedulerUpdateJobScheduleInput,
  now: Date,
): SchedulerUpdateJobScheduleResult {
  const records = store.listScheduledJobsForPrincipal(
    input.workspaceId,
    input.slackUserId,
  );
  const jobs = records.map(summarizeScheduledJob);
  const selection = selectSchedulerJob(jobs, input.jobId);
  if (!selection.ok) {
    return selection;
  }
  const record = records.find((job) => job.jobId === selection.job.jobId);
  if (!record) {
    return { ok: false, reason: "not_found", jobs };
  }
  const scheduleValidation = validateScheduledJobSchedule(input.schedule);
  if (!scheduleValidation.ok) {
    return {
      ok: false,
      reason: "invalid_schedule",
      message: scheduleValidation.message,
      jobs,
    };
  }
  const job = store.upsertScheduledJob({
    jobId: record.jobId,
    workspaceId: record.workspaceId,
    slackUserId: record.slackUserId,
    title: record.title,
    prompt: record.prompt,
    schedule: input.schedule,
    routeId: record.routeId,
    runtimeType: record.runtimeType,
    state: record.state,
    now,
  });
  ensureScheduledJobCapability(store, job, now);
  return { ok: true, job };
}

function updateScheduledJobPrompt(
  store: Pick<
    TokenStore,
    | "listScheduledJobsForPrincipal"
    | "upsertScheduledJob"
    | "upsertAgentJobCapability"
  >,
  input: SchedulerUpdateJobPromptInput,
  now: Date,
): SchedulerUpdateJobPromptResult {
  const records = store.listScheduledJobsForPrincipal(
    input.workspaceId,
    input.slackUserId,
  );
  const jobs = records.map(summarizeScheduledJob);
  const selection = selectSchedulerJob(jobs, input.jobId);
  if (!selection.ok) {
    return selection;
  }
  const record = records.find((job) => job.jobId === selection.job.jobId);
  if (!record) {
    return { ok: false, reason: "not_found", jobs };
  }
  const job = store.upsertScheduledJob({
    jobId: record.jobId,
    workspaceId: record.workspaceId,
    slackUserId: record.slackUserId,
    title: record.title,
    prompt: input.prompt,
    schedule: record.schedule,
    routeId: record.routeId,
    runtimeType: record.runtimeType,
    state: record.state,
    now,
  });
  ensureScheduledJobCapability(store, job, now);
  return { ok: true, job };
}

function updateScheduledJobDelivery(
  store: Pick<
    TokenStore,
    | "listScheduledJobsForPrincipal"
    | "upsertScheduledJob"
    | "upsertAgentJobCapability"
    | "getConversationGrantRouteForSlackChannel"
  >,
  input: SchedulerUpdateJobDeliveryInput,
  now: Date,
  resolveSlackChannelIdByName?: (input: {
    workspaceId: string;
    channelName: string;
  }) => Promise<string | null> | string | null,
):
  Promise<SchedulerUpdateJobDeliveryResult> | SchedulerUpdateJobDeliveryResult {
  const records = store.listScheduledJobsForPrincipal(
    input.workspaceId,
    input.slackUserId,
  );
  const jobs = records.map(summarizeScheduledJob);
  const selection = selectSchedulerJob(jobs, input.jobId);
  if (!selection.ok) {
    return selection;
  }
  const record = records.find((job) => job.jobId === selection.job.jobId);
  if (!record) {
    return { ok: false, reason: "not_found", jobs };
  }

  const routeId = input.routeId?.trim();
  const channelId = input.channelId?.trim();
  const channelName = input.channelName?.trim();
  let resolvedRouteId = routeId || null;

  if (!resolvedRouteId && channelId) {
    const route = activeGrantRoute(
      store.getConversationGrantRouteForSlackChannel({
        workspaceId: input.workspaceId,
        slackUserId: input.slackUserId,
        channelId,
      }),
    );
    if (!route) {
      return {
        ok: false,
        reason: "no_grant",
        jobs,
        channelId,
        ...(channelName ? { channelName } : {}),
      };
    }
    resolvedRouteId = route.id;
  }

  if (!resolvedRouteId && channelName) {
    if (resolveSlackChannelIdByName) {
      return Promise.resolve(
        resolveSlackChannelIdByName({
          workspaceId: input.workspaceId,
          channelName,
        }),
      ).then((resolvedChannelId) => {
        if (!resolvedChannelId) {
          return {
            ok: false,
            reason: "unresolved_channel",
            jobs,
            channelName,
          };
        }
        return updateScheduledJobDelivery(
          store,
          {
            ...input,
            channelId: resolvedChannelId,
            channelName,
          },
          now,
          undefined,
        );
      });
    }
    return {
      ok: false,
      reason: "unresolved_channel",
      jobs,
      channelName,
    };
  }

  if (!resolvedRouteId) {
    return { ok: false, reason: "no_destination", jobs };
  }

  const job = store.upsertScheduledJob({
    jobId: record.jobId,
    workspaceId: record.workspaceId,
    slackUserId: record.slackUserId,
    title: record.title,
    prompt: record.prompt,
    schedule: record.schedule,
    routeId: resolvedRouteId,
    runtimeType: record.runtimeType,
    state: record.state,
    now,
  });
  ensureScheduledJobCapability(store, job, now);
  return { ok: true, job, routeId: resolvedRouteId };
}

function activeGrantRoute(
  route: ConversationRouteRecord | null,
): ConversationRouteRecord | null {
  return route && !route.revokedAt ? route : null;
}

function ensureScheduledJobCapability(
  store: Pick<TokenStore, "upsertAgentJobCapability">,
  job: ScheduledJobRecord,
  now: Date,
): void {
  store.upsertAgentJobCapability({
    jobId: job.jobId,
    workspaceId: job.workspaceId,
    slackUserId: job.slackUserId,
    requiredTools: inferAllowedToolsForScheduledJob(job),
    routeId: job.routeId,
    runtimeType: job.runtimeType,
    capabilityProfile: "scheduled_job",
    stateRefs: [],
    visibilityPolicy: {},
    now,
  });
}

function findActiveScheduledJobRun(
  store: Pick<TokenStore, "listAgentJobRunsForPrincipal">,
  workspaceId: string,
  slackUserId: string,
  jobId: string,
  now: Date,
): AgentJobRunRecord | null {
  return (
    store
      .listAgentJobRunsForPrincipal(workspaceId, slackUserId, jobId, 10)
      .find((run) => isActiveScheduledJobRun(run, now)) ?? null
  );
}

function isActiveScheduledJobRun(run: AgentJobRunRecord, now: Date): boolean {
  if (run.status !== "queued" && run.status !== "running") {
    return false;
  }
  const updatedAtMs = Date.parse(run.updatedAt);
  if (!Number.isFinite(updatedAtMs)) {
    return true;
  }
  return now.getTime() - updatedAtMs <= DEFAULT_ACTIVE_RUN_TTL_MS;
}

function findRecentFailedScheduledJobRun(
  store: Pick<
    TokenStore,
    "listAgentJobRunsForPrincipal" | "findRecentFailedAgentJobRunForPrincipal"
  >,
  workspaceId: string,
  slackUserId: string,
  jobId: string,
  now: Date,
  failureReason: string,
): AgentJobRunRecord | null {
  const since = new Date(now.getTime() - DEFAULT_ACTIVE_RUN_TTL_MS);
  const directMatch = store.findRecentFailedAgentJobRunForPrincipal({
    workspaceId,
    slackUserId,
    jobId,
    failureReason,
    since,
  });
  if (directMatch) {
    return directMatch;
  }

  return (
    store
      .listAgentJobRunsForPrincipal(workspaceId, slackUserId, jobId, 100)
      .find((run) => {
        if (run.status !== "failed" || run.failureReason !== failureReason) {
          return false;
        }
        const updatedAtMs = Date.parse(run.updatedAt);
        if (!Number.isFinite(updatedAtMs)) {
          return false;
        }
        return now.getTime() - updatedAtMs <= DEFAULT_ACTIVE_RUN_TTL_MS;
      }) ?? null
  );
}

function updateScheduledJobState(
  store: Pick<
    TokenStore,
    "listScheduledJobsForPrincipal" | "upsertScheduledJob"
  >,
  input: SchedulerJobMutationInput,
  state: "scheduled" | "paused",
  now: Date,
): SchedulerJobMutationResult {
  const records = store.listScheduledJobsForPrincipal(
    input.workspaceId,
    input.slackUserId,
  );
  const jobs = records.map(summarizeScheduledJob);
  const selection = selectSchedulerJob(jobs, input.jobId);
  if (!selection.ok) {
    return selection;
  }
  const record = records.find((job) => job.jobId === selection.job.jobId);
  if (!record) {
    return { ok: false, reason: "not_found", jobs };
  }
  return {
    ok: true,
    job: store.upsertScheduledJob({
      jobId: record.jobId,
      workspaceId: record.workspaceId,
      slackUserId: record.slackUserId,
      title: record.title,
      prompt: record.prompt,
      schedule: record.schedule,
      routeId: record.routeId,
      runtimeType: record.runtimeType,
      state,
      now,
    }),
  };
}

function summarizeScheduledJob(
  record: ScheduledJobRecord,
): SchedulerJobSummary {
  return {
    jobId: record.jobId,
    title: record.title,
    prompt: record.prompt,
    schedule: record.schedule,
    state: record.state,
    runtimeType: record.runtimeType,
    requiredTools: [],
    routeId: record.routeId,
    updatedAt: record.updatedAt,
  };
}

function summarizeScheduledTask(
  record: ScheduledJobRecord,
  capability: SchedulerTaskGrant | null,
): SchedulerTaskSummary {
  return {
    ...summarizeScheduledJob(record),
    taskId: record.jobId,
    requiredTools: capability?.requiredTools ?? [],
  };
}

function selectSchedulerJob<T extends SchedulerJobSummary>(
  jobs: T[],
  jobId?: string | null,
):
  | { ok: true; job: T }
  | {
      ok: false;
      reason: "no_jobs" | "not_found" | "ambiguous";
      jobs: T[];
    } {
  const normalizedJobId = jobId?.trim();
  if (normalizedJobId) {
    const job = jobs.find((candidate) => candidate.jobId === normalizedJobId);
    return job ? { ok: true, job } : { ok: false, reason: "not_found", jobs };
  }
  if (jobs.length === 0) {
    return { ok: false, reason: "no_jobs", jobs };
  }
  if (jobs.length > 1) {
    return { ok: false, reason: "ambiguous", jobs };
  }
  return { ok: true, job: jobs[0] };
}
