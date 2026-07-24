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
    ...(scheduledJob.operationGrants ?? []).map(formatScheduledJobOperationGrant),
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

function formatScheduledJobOperationGrant(
  grant: NonNullable<RuntimeScheduledJobContext["operationGrants"]>[number]
): string {
  const inputContract = formatOperationInputContract(grant.inputSchema);
  return `- allowedOperation tool=${grant.tool} operation=${grant.operation}${grant.description ? ` description=${JSON.stringify(grant.description)}` : ""}${inputContract ? ` input=${inputContract}` : ""}`;
}

function formatOperationInputContract(inputSchema: unknown): string {
  if (!isRecord(inputSchema) || !isRecord(inputSchema.properties)) {
    return "";
  }
  const required = new Set(
    Array.isArray(inputSchema.required)
      ? inputSchema.required.filter(
          (field): field is string => typeof field === "string"
        )
      : []
  );
  const fields = Object.entries(inputSchema.properties).map(([name, schema]) =>
    formatOperationInputField(name, schema, required.has(name))
  );
  for (const name of required) {
    if (!Object.hasOwn(inputSchema.properties, name)) {
      fields.push(`${name}:any,required`);
    }
  }
  return boundPromptValue(`{${fields.join("; ")}}`, 3_000);
}

function formatOperationInputField(
  name: string,
  schema: unknown,
  required: boolean
): string {
  if (!isRecord(schema)) {
    return `${name}:any,${required ? "required" : "optional"}`;
  }
  const type = schemaType(schema);
  const values = Array.isArray(schema.enum)
    ? schema.enum
        .slice(0, 20)
        .map(formatSchemaLiteral)
        .filter(Boolean)
        .join("|")
    : "";
  return `${name}:${type}${values ? `(${values})` : ""},${required ? "required" : "optional"}`;
}

function schemaType(schema: Record<string, unknown>): string {
  if (typeof schema.type === "string") {
    return schema.type;
  }
  if (Array.isArray(schema.type)) {
    const types = schema.type.filter(
      (value): value is string => typeof value === "string"
    );
    if (types.length > 0) {
      return types.join("|");
    }
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return typeof schema.enum[0];
  }
  return "any";
}

function formatSchemaLiteral(value: unknown): string {
  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean"
  ) {
    return "";
  }
  return boundPromptValue(String(value).replace(/[|(){};]/g, "_"), 80);
}

function boundPromptValue(value: string, maxLength: number): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
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
