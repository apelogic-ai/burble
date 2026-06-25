import type { AgentJobRunRecord, Provider, ProviderConnection } from "../db";
import type { createGitHubTools } from "../tools/github";
import type { createGoogleTools } from "../tools/google";
import type { createHubSpotTools } from "../tools/hubspot";
import type { createJiraTools } from "../tools/jira";
import type { createSlackTools } from "../tools/slack";
import type { AgentMode } from "../config";
import type { AgentRuntimeEngine } from "@burble/runtime-sdk/runtime-engines";
import type { AgentRunEventHandler, AgentRunner, AgentUsage } from "../agent/types";
import type { ObservabilitySink } from "../observability";
import type { SchedulerControlPlane } from "../scheduler/control-plane";

export type ResponseVisibility = "public" | "ephemeral" | "dm";
export type ToolClassification = "public" | "user_private" | "restricted";
export type ConversationAttachmentKind = "file" | "image" | "audio" | "video";

export type ConversationAttachment = {
  id: string;
  kind: ConversationAttachmentKind;
  mimeType: string;
  source: "slack" | "burble" | "agent";
  name?: string;
  sizeBytes?: number;
  externalId?: string;
};

export type ConversationRequest = {
  source: "slack";
  workspaceId: string;
  channelId: string;
  threadTs?: string;
  messageTs: string;
  isDirectMessage: boolean;
  conversationRouteId?: string;
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
  user: {
    slackUserId: string;
    email: string;
  };
  text: string;
  attachments?: ConversationAttachment[];
};

export type ConversationResponse = {
  visibility: ResponseVisibility;
  classification: ToolClassification;
  text: string;
  attachments?: ConversationAttachment[];
  blocks?: unknown[];
  usage?: AgentUsage;
};

export type ConversationToolCatalog = {
  github: ReturnType<typeof createGitHubTools>;
  google?: ReturnType<typeof createGoogleTools>;
  hubspot?: ReturnType<typeof createHubSpotTools>;
  jira?: ReturnType<typeof createJiraTools>;
  slack?: ReturnType<typeof createSlackTools>;
};

export type ConversationDeps = {
  createGitHubOAuthUrl: (slackUserId: string) => string;
  createJiraOAuthUrl?: (slackUserId: string) => string;
  createSlackOAuthUrl?: (slackUserId: string) => string;
  createGoogleOAuthUrl?: (slackUserId: string) => string;
  createHubSpotOAuthUrl?: (slackUserId: string) => string;
  getConnection: (provider: Provider, email: string) => ProviderConnection | null;
  tools: ConversationToolCatalog;
  agentMode?: AgentMode;
  agentFastTrack?: boolean;
  agentRuntimeEngine?: AgentRuntimeEngine;
  agentRunner?: AgentRunner;
  agentExecutionMode?: "default" | "native-runtime";
  schedulerControl?: SchedulerControlPlane;
  onSchedulerRunQueued?: (run: AgentJobRunRecord) => void | Promise<void>;
  onAgentEvent?: AgentRunEventHandler;
  observability?: ObservabilitySink;
  traceId?: string;
};
