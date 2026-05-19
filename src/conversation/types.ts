import type { Provider, ProviderConnection } from "../db";
import type { createGitHubTools } from "../tools/github";

export type ResponseVisibility = "public" | "ephemeral" | "dm";
export type ToolClassification = "public" | "user_private" | "restricted";

export type ConversationRequest = {
  source: "slack";
  workspaceId: string;
  channelId: string;
  threadTs?: string;
  messageTs: string;
  isDirectMessage: boolean;
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
};

export type ConversationDeps = {
  createGitHubOAuthUrl: (slackUserId: string) => string;
  getConnection: (provider: Provider, email: string) => ProviderConnection | null;
  githubTools: ReturnType<typeof createGitHubTools>;
};
