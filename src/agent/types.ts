import type { ProviderConnection } from "../db";
import type {
  ConversationAttachment,
  ToolClassification
} from "../conversation/types";
import type { RuntimeToolGroupSelection } from "./tool-groups";
import type { PrincipalId } from "./runtime-factory";

export type AgentRunnerCapabilities = {
  streaming: boolean;
  toolEvents: boolean;
  remote: boolean;
  requiresToolGateway?: boolean;
};

export type AgentInput = {
  principal: PrincipalId;
  executionMode?: "default" | "openclaw-native";
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
  text: string;
  toolGroups?: RuntimeToolGroupSelection;
  attachments?: ConversationAttachment[];
  connections: {
    github: ProviderConnection | null;
    google?: ProviderConnection | null;
    jira?: ProviderConnection | null;
    slack?: ProviderConnection | null;
  };
};

export type AgentOutput = {
  classification: ToolClassification;
  text: string;
  attachments?: ConversationAttachment[];
  blocks?: unknown[];
  usage?: AgentUsage;
  telemetry?: AgentTelemetry;
};

export type AgentUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  usageSource?: "provider-output" | "estimate-only" | string;
};

export type AgentTelemetry = {
  promptChars?: number;
  promptApproxTokens?: number;
  steps?: Array<Record<string, unknown>>;
};

export type AgentRunEvent =
  | { type: "status"; text: string }
  | { type: "tool_call"; toolName: string; callId: string }
  | {
      type: "tool_result";
      toolName: string;
      callId: string;
      classification: ToolClassification;
    }
  | { type: "message_delta"; text: string }
  | { type: "final"; response: AgentOutput }
  | { type: "error"; message: string };

export type AgentRunner = {
  name: string;
  capabilities: AgentRunnerCapabilities;
  run: (input: AgentInput) => AsyncIterable<AgentRunEvent>;
};

export type AgentRunEventHandler = (
  event: AgentRunEvent
) => void | Promise<void>;

export async function collectAgentRun(
  runner: AgentRunner,
  input: AgentInput,
  onEvent?: AgentRunEventHandler
): Promise<AgentOutput> {
  for await (const event of runner.run(input)) {
    if (event.type === "error") {
      throw new Error(event.message);
    }

    if (event.type === "final") {
      return event.response;
    }

    try {
      await onEvent?.(event);
    } catch {
      // Progress delivery is best-effort. A Slack update failure must not abort
      // the underlying agent run or be mistaken for a runtime stream failure.
    }
  }

  throw new Error(`Agent runner ${runner.name} finished without a final response`);
}
