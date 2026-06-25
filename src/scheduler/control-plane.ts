import { randomUUID } from "node:crypto";
import type {
  AgentJobCapabilityRecord,
  AgentJobRunRecord,
  AgentRuntimeEngine,
  ScheduledJobRecord,
  TokenStore
} from "../db";

export type SchedulerJobSummary = {
  jobId: string;
  title: string | null;
  prompt: string | null;
  schedule: unknown | null;
  state: "scheduled" | "paused" | "registered";
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
  createJob?(input: SchedulerCreateJobInput):
    | Promise<SchedulerCreateJobResult>
    | SchedulerCreateJobResult;
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
    | "listAgentJobCapabilitiesForPrincipal"
    | "createAgentJobRun"
    | "getLatestAgentJobRunForPrincipal"
  >,
  options: SchedulerControlPlaneOptions = {}
): SchedulerControlPlane {
  const now = options.now ?? (() => new Date());
  const newJobId = options.newJobId ?? (() => `job_${randomUUID()}`);
  const newRunId = options.newRunId ?? (() => `jobrun_${randomUUID()}`);
  const listJobs = (input: {
    workspaceId: string;
    slackUserId: string;
  }): SchedulerJobSummary[] => {
    const jobs = store
      .listScheduledJobsForPrincipal(input.workspaceId, input.slackUserId)
      .map(summarizeScheduledJob);
    const jobIds = new Set(jobs.map((job) => job.jobId));
    const capabilityOnlyJobs = store
      .listAgentJobCapabilitiesForPrincipal(input.workspaceId, input.slackUserId)
      .filter((record) => !jobIds.has(record.jobId))
      .map(summarizeJobCapability);
    return [...jobs, ...capabilityOnlyJobs];
  };

  return {
    listJobs,
    createJob(input) {
      return {
        ok: true,
        job: store.upsertScheduledJob({
          jobId: newJobId(),
          workspaceId: input.workspaceId,
          slackUserId: input.slackUserId,
          title: input.title,
          prompt: input.prompt,
          schedule: input.schedule,
          routeId: input.routeId,
          runtimeType: input.runtimeType,
          state: "scheduled",
          now: now()
        })
      };
    },
    triggerJob(input) {
      const jobs = listJobs(input);
      const job = selectSchedulerJob(jobs, input.jobId);
      if (!job.ok) {
        return job;
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
          now: now()
        })
      };
    },
    getLatestRunStatus(input) {
      const run = store.getLatestAgentJobRunForPrincipal(
        input.workspaceId,
        input.slackUserId,
        input.jobId
      );
      return run ? { ok: true, run } : { ok: false, reason: "no_runs" };
    }
  };
}

function summarizeScheduledJob(record: ScheduledJobRecord): SchedulerJobSummary {
  return {
    jobId: record.jobId,
    title: record.title,
    prompt: record.prompt,
    schedule: record.schedule,
    state: record.state,
    runtimeType: record.runtimeType,
    requiredTools: [],
    routeId: record.routeId,
    updatedAt: record.updatedAt
  };
}

function summarizeJobCapability(
  record: AgentJobCapabilityRecord
): SchedulerJobSummary {
  return {
    jobId: record.jobId,
    title: null,
    prompt: null,
    schedule: null,
    state: "registered",
    runtimeType: record.runtimeType,
    requiredTools: record.requiredTools,
    routeId: record.routeId,
    updatedAt: record.updatedAt
  };
}

function selectSchedulerJob(
  jobs: SchedulerJobSummary[],
  jobId?: string | null
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
    return job
      ? { ok: true, job }
      : { ok: false, reason: "not_found", jobs };
  }
  if (jobs.length === 0) {
    return { ok: false, reason: "no_jobs", jobs };
  }
  if (jobs.length > 1) {
    return { ok: false, reason: "ambiguous", jobs };
  }
  return { ok: true, job: jobs[0] };
}
