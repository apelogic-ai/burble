import type { AgentJobCapabilityRecord, TokenStore } from "../db";

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
};

export function createSchedulerControlPlane(
  store: Pick<TokenStore, "listAgentJobCapabilitiesForPrincipal">
): SchedulerControlPlane {
  return {
    listJobs(input) {
      return store
        .listAgentJobCapabilitiesForPrincipal(
          input.workspaceId,
          input.slackUserId
        )
        .map(summarizeJobCapability);
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
