import type { AgentJobCapabilityRecord, AgentRuntimeRecord } from "../db";
import type { RuntimeJwtIssuer } from "../runtime-jwt";

export function issueScheduledJobRuntimeJwt(input: {
  issuer: RuntimeJwtIssuer;
  audience: string;
  runtime: AgentRuntimeRecord;
  capability: AgentJobCapabilityRecord;
  ttlSeconds?: number;
}): string {
  assertScheduledJobCapabilityMatchesRuntime(input.runtime, input.capability);

  return input.issuer.issueRuntimeJwt({
    audience: input.audience,
    runtimeId: input.runtime.id,
    workspaceId: input.runtime.workspaceId,
    slackUserId: input.runtime.slackUserId,
    jobId: input.capability.jobId,
    allowedTools: input.capability.requiredTools,
    ttlSeconds: input.ttlSeconds
  });
}

export function assertScheduledJobCapabilityMatchesRuntime(
  runtime: AgentRuntimeRecord,
  capability: AgentJobCapabilityRecord
): void {
  if (
    capability.workspaceId !== runtime.workspaceId ||
    capability.slackUserId !== runtime.slackUserId
  ) {
    throw new Error("Scheduled job capability does not match runtime principal");
  }

  if (capability.runtimeType && capability.runtimeType !== runtime.engine) {
    throw new Error("Scheduled job capability does not match runtime type");
  }
}
