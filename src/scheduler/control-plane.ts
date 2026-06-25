import { randomUUID } from "node:crypto";
import type {
  AgentJobRunRecord,
  AgentRuntimeEngine,
  ScheduledJobRecord,
  TokenStore,
} from "../db";
import { inferAllowedToolsForScheduledJob } from "./job-capabilities";

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

export type SchedulerControlPlane = {
  listJobs(input: {
    workspaceId: string;
    slackUserId: string;
  }): Promise<SchedulerJobSummary[]> | SchedulerJobSummary[];
  listJobRuns?(
    input: SchedulerListJobRunsInput,
  ): Promise<SchedulerJobRunListResult> | SchedulerJobRunListResult;
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
    };

export type SchedulerListJobRunsInput = {
  workspaceId: string;
  slackUserId: string;
  jobId?: string | null;
  limit?: number | null;
};

export type SchedulerJobRunListResult = {
  runs: AgentJobRunRecord[];
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

export type SchedulerCreateJobResult = {
  ok: true;
  job: ScheduledJobRecord;
};

export type SchedulerJobMutationInput = {
  workspaceId: string;
  slackUserId: string;
  jobId?: string | null;
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
};

export function createSchedulerControlPlane(
  store: Pick<
    TokenStore,
    | "listScheduledJobsForPrincipal"
    | "upsertScheduledJob"
    | "deleteScheduledJob"
    | "createAgentJobRun"
    | "listAgentJobRunsForPrincipal"
    | "upsertAgentJobCapability"
    | "getLatestAgentJobRunForPrincipal"
  >,
  options: SchedulerControlPlaneOptions = {},
): SchedulerControlPlane {
  const now = options.now ?? (() => new Date());
  const newJobId = options.newJobId ?? (() => `job_${randomUUID()}`);
  const newRunId = options.newRunId ?? (() => `jobrun_${randomUUID()}`);
  const listJobs = (input: {
    workspaceId: string;
    slackUserId: string;
  }): SchedulerJobSummary[] => {
    return store
      .listScheduledJobsForPrincipal(input.workspaceId, input.slackUserId)
      .map(summarizeScheduledJob);
  };

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
    createJob(input) {
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
        ensureScheduledJobCapability(store, record, timestamp);
      }

      return {
        ok: true,
        jobId: job.job.jobId,
        run: store.createAgentJobRun({
          runId: newRunId(),
          jobId: job.job.jobId,
          workspaceId: input.workspaceId,
          slackUserId: input.slackUserId,
          triggerSource: "manual",
          status: "queued",
          now: timestamp,
        }),
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

function selectSchedulerJob(
  jobs: SchedulerJobSummary[],
  jobId?: string | null,
):
  | { ok: true; job: SchedulerJobSummary }
  | {
      ok: false;
      reason: "no_jobs" | "not_found" | "ambiguous";
      jobs: SchedulerJobSummary[];
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
