import type { Provider, ProviderConnection } from "../db";
import type { createGitHubTools } from "../tools/github";
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
  context?: {
    recentMessages: Array<{
      author: "user" | "assistant";
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
  getConnection: (provider: Provider, email: string) => ProviderConnection | null;
  githubTools: ReturnType<typeof createGitHubTools>;
  slackTools?: ReturnType<typeof createSlackTools>;
  agentMode?: AgentMode;
  agentRunner?: AgentRunner;
  onAgentEvent?: AgentRunEventHandler;
};
