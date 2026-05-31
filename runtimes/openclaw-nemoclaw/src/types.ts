export type ToolClassification = "public" | "user_private" | "restricted";

export type ConversationAttachment = {
  id: string;
  kind: "file" | "image" | "audio" | "video";
  mimeType: string;
  source: "slack" | "burble" | "agent";
  name?: string;
  sizeBytes?: number;
  externalId?: string;
};

export type ToolResult<TContent = unknown> = {
  classification: ToolClassification;
  content: TContent;
};

export type RunRequest = {
  runId?: string;
  executionMode?: "default" | "openclaw-native";
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
      memoryContext?: Array<{
        scope: "user" | "workspace" | "job";
        ownerId: string;
        key: string;
        valuePreview: string;
        updatedAt: string;
      }>;
    };
  };
  input: {
    text: string;
    attachments?: ConversationAttachment[];
    conversation?: {
      routeId?: string;
      source: "slack";
      workspaceId: string;
      channelId: string;
      rootId: string;
      isDirectMessage: boolean;
    };
    context?: {
      currentChannel?: {
        id: string;
        isDirectMessage: boolean;
        historyAvailable: boolean;
        historyError?: string;
      };
      recentMessages: Array<{
        author: "user" | "assistant";
        speaker?: string;
        text: string;
      }>;
    };
    connections: {
      github: {
        connected: boolean;
        email?: string;
        providerLogin?: string;
      };
      google?: {
        connected: boolean;
        email?: string;
        providerLogin?: string;
      };
      jira?: {
        connected: boolean;
        email?: string;
        providerLogin?: string;
      };
      slack?: {
        connected: boolean;
        email?: string;
        providerLogin?: string;
      };
    };
  };
};

export type RunResponse = {
  response: {
    classification: ToolClassification;
    text: string;
    attachments?: ConversationAttachment[];
    usage?: RunUsage;
    telemetry?: RunTelemetry;
  };
};

export type RunUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
};

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
  | { type: "tool_call"; toolName: string; callId: string }
  | {
      type: "tool_result";
      toolName: string;
      callId: string;
      classification: ToolClassification;
    }
  | { type: "message_delta"; text: string }
  | { type: "final"; response: RunResponse["response"] }
  | { type: "error"; message: string };

export type ToolExecutor = (
  toolName: string,
  body: unknown
) => Promise<ToolResult>;
