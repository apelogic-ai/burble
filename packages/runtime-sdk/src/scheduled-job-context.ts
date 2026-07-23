import type { RuntimeRunRequest } from "./runtime-contract";

export type RuntimeScheduledJobContext = NonNullable<
  RuntimeRunRequest["input"]["scheduledJob"]
>;

export type RuntimeScheduledJobContextFormatOptions = {
  includeRuntimeType?: boolean;
  guidanceLines?: readonly string[];
};

const defaultGuidanceLines = [
  "For this scheduled job, use only the listed allowedTools for Burble provider calls. Treat stateRefs as durable job state locations supplied by Burble.",
  "Respect maxOutputVisibility when sending scheduled output. Do not publicly post private-tool-derived content; public channel delivery for authenticated provider read output requires an explicit declassification approval flow that is not implemented yet. Write-only provider state tools do not by themselves make public-source output private."
];

export function formatRuntimeScheduledJobContextLines(
  scheduledJob: RuntimeScheduledJobContext,
  options: RuntimeScheduledJobContextFormatOptions = {}
): string[] {
  return [
    "Scheduled Burble job context:",
    `- jobId=${scheduledJob.jobId}`,
    `- capabilityProfile=${scheduledJob.capabilityProfile}`,
    `- allowedTools=${formatAllowedTools(scheduledJob.allowedTools)}`,
    ...(scheduledJob.operationGrants ?? []).map(
      (grant) =>
        `- allowedOperation tool=${grant.tool} operation=${grant.operation}${grant.description ? ` description=${JSON.stringify(grant.description)}` : ""}`
    ),
    ...(scheduledJob.routeId ? [`- routeId=${scheduledJob.routeId}`] : []),
    ...(options.includeRuntimeType && scheduledJob.runtimeType
      ? [`- runtimeType=${scheduledJob.runtimeType}`]
      : []),
    `- maxOutputVisibility=${scheduledJob.visibilityPolicy.maxOutputVisibility ?? "user_private"}`,
    `- allowPrivateToolDeclassification=${scheduledJob.visibilityPolicy.allowPrivateToolDeclassification === true ? "true" : "false"}`,
    ...scheduledJob.stateRefs.map(formatScheduledJobStateRef),
    ...(options.guidanceLines ?? defaultGuidanceLines)
  ];
}

export function formatRuntimeScheduledJobContext(
  scheduledJob: RuntimeScheduledJobContext,
  options: RuntimeScheduledJobContextFormatOptions = {}
): string {
  return formatRuntimeScheduledJobContextLines(scheduledJob, options).join("\n");
}

export function withTrustedScheduledJobId(
  input: unknown,
  scheduledJob?: RuntimeScheduledJobContext
): unknown {
  if (!scheduledJob) {
    return input;
  }
  return {
    ...(isRecord(input) ? input : {}),
    jobId: scheduledJob.jobId
  };
}

function formatAllowedTools(allowedTools: readonly string[]): string {
  return [...new Set(allowedTools)].sort().join(",");
}

function formatScheduledJobStateRef(
  stateRef: RuntimeScheduledJobContext["stateRefs"][number]
): string {
  const parts = [
    `provider=${stateRef.provider}`,
    `kind=${stateRef.kind}`,
    ...(stateRef.id ? [`id=${stateRef.id}`] : []),
    ...(stateRef.name ? [`name=${stateRef.name}`] : []),
    ...(stateRef.purpose ? [`purpose=${stateRef.purpose}`] : [])
  ];
  return `- stateRef ${parts.join(" ")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
