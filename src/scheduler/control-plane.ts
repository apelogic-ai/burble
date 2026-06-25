import { randomUUID } from "node:crypto";
import type {
  AgentJobCapabilityRecord,
  AgentJobRunRecord,
  TokenStore
} from "../db";

export type SchedulerJobSummary = {
  jobId: string;
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
  newRunId?: () => string;
};

export function createSchedulerControlPlane(
  store: Pick<
    TokenStore,
    | "listAgentJobCapabilitiesForPrincipal"
    | "createAgentJobRun"
    | "getLatestAgentJobRunForPrincipal"
  >,
  options: SchedulerControlPlaneOptions = {}
): SchedulerControlPlane {
  const now = options.now ?? (() => new Date());
  const newRunId = options.newRunId ?? (() => `jobrun_${randomUUID()}`);
  return {
    listJobs(input) {
      return store
        .listAgentJobCapabilitiesForPrincipal(
          input.workspaceId,
          input.slackUserId
        )
        .map(summarizeJobCapability);
    },
    triggerJob(input) {
      const jobs = store
        .listAgentJobCapabilitiesForPrincipal(
          input.workspaceId,
          input.slackUserId
        )
        .map(summarizeJobCapability);
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

function summarizeJobCapability(
  record: AgentJobCapabilityRecord
): SchedulerJobSummary {
  return {
    jobId: record.jobId,
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
