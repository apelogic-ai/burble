import type {
  RuntimeConnectionSummary,
  RuntimeConversationAttachment,
  RuntimeConversationSummary,
  RuntimeFinalResponse,
  RuntimeRequestContext,
  RuntimeUsage,
  ToolClassification
} from "@burble/runtime-sdk/runtime-contract";
import type { RuntimeScheduledJobContext } from "@burble/runtime-sdk/scheduled-job-context";

export type { ToolClassification };

export type ConversationAttachment = RuntimeConversationAttachment;

export type ToolResult<TContent = unknown> = {
  classification: ToolClassification;
  content: TContent;
};

export type RunRequest = {
  runId?: string;
  executionMode?: "default" | "native-runtime";
  runtime?: {
    id: string;
    policyHash?: string;
    manifest?: {
      version: string;
      policyHash: string;
      skills: Array<{
        id: string;
        version: string;
        enabled: boolean;
      }>;
      memory: {
        userMemoryEnabled: boolean;
        workspaceMemoryEnabled: boolean;
        jobMemoryEnabled: boolean;
      };
      streaming?: {
        messageDeltasEnabled: boolean;
      };
      memoryContext?: Array<{
        scope: "user" | "workspace" | "job";
        ownerId: string;
        key: string;
        valuePreview: string;
        updatedAt: string;
      }>;
      tools?: Array<{
        name: string;
        alias: string;
        provider: string;
        title?: string;
        description?: string;
        enabled: boolean;
        risk?: "read" | "low_write" | "moderate_write" | "high_write";
        routeRequired?: boolean;
        confirmation?: "none" | "explicit" | "strong";
        retrySafe?: boolean;
        input?: Array<{
          name: string;
          type: string;
          required: boolean;
          nullable?: boolean;
          description?: string;
          values?: string[];
          aliases?: string[];
        }>;
      }>;
    };
  };
  input: {
    text: string;
    toolGroups?: {
      groups: Array<
        | "attachments"
        | "conversation"
        | "github"
        | "google"
        | "hubspot"
        | "jira"
        | "scheduler"
        | "slack"
        | "web"
      >;
      reasons: string[];
    };
    scheduledJob?: RuntimeScheduledJobContext;
    attachments?: ConversationAttachment[];
    conversation?: RuntimeConversationSummary;
    context?: RuntimeRequestContext;
    connections: {
      github?: RuntimeConnectionSummary;
      google?: RuntimeConnectionSummary;
      hubspot?: RuntimeConnectionSummary;
      jira?: RuntimeConnectionSummary;
      slack?: RuntimeConnectionSummary;
    };
  };
};

export type RunResponse = {
  response: Omit<RuntimeFinalResponse, "telemetry"> & {
    telemetry?: RunTelemetry;
  };
};

export type RunUsage = RuntimeUsage;

export type RunTelemetry = {
  promptChars?: number;
  promptApproxTokens?: number;
  steps?: RunTelemetryStep[];
};

export type RunTelemetryStep = {
  step: number;
  promptChars: number;
  promptApproxTokens: number;
  usageSource: "provider-output" | "estimate-only";
  modelDiagnostics?: {
    modelStarts?: number;
    fetchStarts?: number;
    streamDone?: number;
    streamDoneElapsedMs?: number[];
    streamDoneEvents?: number[];
    providerRequestIds?: string[];
    compactions?: number;
    exactUsageFields?: number;
    exactUsageAvailable?: boolean;
    rawStreamBytes?: number;
  };
  phaseTimings?: {
    requestToLaneMs?: number;
    laneWaitMs?: number;
    laneToRunStartMs?: number;
    runStartToPromptMs?: number;
    promptToProviderMs?: number;
    providerToFirstEventMs?: number;
    providerStreamMs?: number;
    providerElapsedMs?: number;
    gatewayRunDurationMs?: number;
    systemPromptChars?: number;
    gatewayPromptChars?: number;
    historyTextChars?: number;
  };
};

export type RunEvent =
  | { type: "status"; text: string }
  | { type: "tool_call"; toolName: string; callId: string; input?: unknown }
  | {
      type: "tool_result";
      toolName: string;
      callId: string;
      classification: ToolClassification;
      content?: unknown;
    }
  | { type: "message_delta"; text: string }
  | { type: "message_replace"; text: string }
  | { type: "final"; response: RunResponse["response"] }
  | { type: "error"; message: string };

export type ToolExecutor = (
  toolName: string,
  body: unknown
) => Promise<ToolResult>;
