import type { ToolClassification } from "../conversation/types";
import type { AgentJobCapabilityRecord, AgentRuntimeEngine } from "../db";

export type ScheduledJobStateRef = {
  provider: string;
  kind: string;
  id?: string;
  name?: string;
  purpose?: string;
};

export type ScheduledJobVisibilityPolicy = {
  maxOutputVisibility?: ToolClassification;
  allowPrivateToolDeclassification?: boolean;
};

export type ScheduledJobContext = {
  jobId: string;
  capabilityProfile: string;
  allowedTools: string[];
  nativeToolsets?: string[];
  routeId?: string;
  runtimeType?: AgentRuntimeEngine;
  stateRefs: ScheduledJobStateRef[];
  visibilityPolicy: ScheduledJobVisibilityPolicy;
};

export function buildScheduledJobContext(
  capability: AgentJobCapabilityRecord
): ScheduledJobContext {
  return {
    jobId: capability.jobId,
    capabilityProfile: capability.capabilityProfile,
    allowedTools: [...new Set(capability.requiredTools)].sort(),
    ...nativeToolsetsForScheduledJob(capability),
    ...(capability.routeId ? { routeId: capability.routeId } : {}),
    ...(capability.runtimeType ? { runtimeType: capability.runtimeType } : {}),
    stateRefs: normalizeStateRefs(capability.stateRefs),
    visibilityPolicy: normalizeVisibilityPolicy(capability.visibilityPolicy)
  };
}

function nativeToolsetsForScheduledJob(
  capability: AgentJobCapabilityRecord
): Pick<ScheduledJobContext, "nativeToolsets"> {
  if (capability.runtimeType !== "hermes") {
    return {};
  }

  const toolsets = new Set(["burble"]);
  for (const toolName of capability.requiredTools) {
    if (toolName === "web_extract" || toolName === "web_search") {
      toolsets.add("web");
    }
  }
  return { nativeToolsets: [...toolsets].sort() };
}

function normalizeStateRefs(value: unknown): ScheduledJobStateRef[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.provider !== "string" || typeof record.kind !== "string") {
      return [];
    }

    return [
      {
        provider: record.provider,
        kind: record.kind,
        ...(typeof record.id === "string" ? { id: record.id } : {}),
        ...(typeof record.name === "string" ? { name: record.name } : {}),
        ...(typeof record.purpose === "string" ? { purpose: record.purpose } : {})
      }
    ];
  });
}

function normalizeVisibilityPolicy(
  value: unknown
): ScheduledJobVisibilityPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const record = value as Record<string, unknown>;
  return {
    ...(isToolClassification(record.maxOutputVisibility)
      ? { maxOutputVisibility: record.maxOutputVisibility }
      : {}),
    ...(typeof record.allowPrivateToolDeclassification === "boolean"
      ? {
          allowPrivateToolDeclassification:
            record.allowPrivateToolDeclassification
        }
      : {})
  };
}

function isToolClassification(value: unknown): value is ToolClassification {
  return (
    value === "public" ||
    value === "user_private" ||
    value === "restricted"
  );
}
