import type { Provider, ProviderConnection } from "../db";
import type { createGitHubTools } from "../tools/github";
import type { createGoogleTools } from "../tools/google";
import type { createSlackTools } from "../tools/slack";
import type { AgentMode } from "../config";
import type { AgentRunEventHandler, AgentRunner, AgentUsage } from "../agent/types";

export type ResponseVisibility = "public" | "ephemeral" | "dm";
export type ToolClassification = "public" | "user_private" | "restricted";

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
};

export type ConversationResponse = {
  visibility: ResponseVisibility;
  classification: ToolClassification;
  text: string;
  blocks?: unknown[];
  usage?: AgentUsage;
};

export type ConversationDeps = {
  createGitHubOAuthUrl: (slackUserId: string) => string;
  createJiraOAuthUrl?: (slackUserId: string) => string;
  createSlackOAuthUrl?: (slackUserId: string) => string;
  createGoogleOAuthUrl?: (slackUserId: string) => string;
  getConnection: (provider: Provider, email: string) => ProviderConnection | null;
  githubTools: ReturnType<typeof createGitHubTools>;
  googleTools?: ReturnType<typeof createGoogleTools>;
  slackTools?: ReturnType<typeof createSlackTools>;
  agentMode?: AgentMode;
  agentRunner?: AgentRunner;
  agentExecutionMode?: "default" | "openclaw-native";
  onAgentEvent?: AgentRunEventHandler;
};
