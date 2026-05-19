import type { ConnectedUser } from "../db";
import type { GitHubIssue, GitHubUser } from "../github";

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
  getGitHubConnection: (email: string) => ConnectedUser | null;
  getGitHubUser: (token: string) => Promise<GitHubUser>;
  listAssignedIssues: (token: string) => Promise<GitHubIssue[]>;
};
