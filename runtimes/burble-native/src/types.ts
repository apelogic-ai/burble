import type {
  RuntimeCapabilityManifest,
  RuntimeFinalResponse,
  RuntimeRunEvent,
  RuntimeRunRequest,
  RuntimeUsage
} from "@burble/runtime-sdk/runtime-contract";

export type ToolClassification = RuntimeFinalResponse["classification"];
export type RunUsage = RuntimeUsage & {
  usageSource: string;
};
export type RunRequest = RuntimeRunRequest & {
  runId: string;
};
export type RunResponse = {
  response: RuntimeFinalResponse;
};
export type RunEvent = RuntimeRunEvent;
export type ToolResult = {
  classification?: ToolClassification;
  content?: unknown;
};
export type ToolExecutor = (
  toolName: string,
  body: unknown
) => Promise<ToolResult | unknown>;
export type CapabilityManifest = RuntimeCapabilityManifest;
