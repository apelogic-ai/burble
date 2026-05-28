import type { ProviderConnection } from "../db";
import {
  isJiraAuthorizationError,
  type JiraAccessibleResource,
  type JiraVisibleProject,
  type JiraTokenSet
} from "../providers/jira/client";
import type { ToolResult } from "./types";

export type JiraUser = {
  accountId: string;
  displayName: string;
  emailAddress?: string;
};

export type JiraIssue = {
  key: string;
  summary: string;
  url: string;
  status?: string;
  description?: string;
  issueType?: string;
  parentKey?: string;
  labels?: string[];
};

export type JiraToolDeps = {
  getJiraUser: (token: string) => Promise<JiraUser>;
  listJiraAccessibleResources?: (token: string) => Promise<JiraAccessibleResource[]>;
  listVisibleJiraProjects?: (
    token: string,
    input: {
      query?: string;
      action?: "view" | "browse" | "edit" | "create";
      expandIssueTypes?: boolean;
    }
  ) => Promise<JiraVisibleProject[]>;
  searchJiraUsers?: (token: string, query: string) => Promise<JiraUser[]>;
  createJiraIssue?: (
    token: string,
    input: {
      projectKey: string;
      issueTypeName?: string;
      issueTypeId?: string;
      summary: string;
      description?: string;
      assigneeAccountId?: string;
    }
  ) => Promise<JiraIssue>;
  editJiraIssue?: (
    token: string,
    input: {
      issueKey: string;
      summary?: string;
      description?: string;
      assigneeAccountId?: string | null;
    }
  ) => Promise<JiraIssue>;
  getJiraIssue?: (
    token: string,
    input: { issueKey: string }
  ) => Promise<JiraIssue>;
  updateJiraIssue?: (
    token: string,
    input: {
      issueKey: string;
      summary?: string;
      description?: string;
      assigneeAccountId?: string | null;
      labels?: string[];
    }
  ) => Promise<JiraIssue>;
  addJiraIssueComment?: (
    token: string,
    input: { issueKey: string; body: string }
  ) => Promise<{ id: string; url: string }>;
  transitionJiraIssue?: (
    token: string,
    input: { issueKey: string; transitionId?: string; transitionName?: string }
  ) => Promise<JiraIssue>;
  addJiraIssueLabels?: (
    token: string,
    input: { issueKey: string; labels: string[] }
  ) => Promise<JiraIssue>;
  removeJiraIssueLabels?: (
    token: string,
    input: { issueKey: string; labels: string[] }
  ) => Promise<JiraIssue>;
  linkJiraIssues?: (
    token: string,
    input: {
      inwardIssueKey: string;
      outwardIssueKey: string;
      typeName?: string;
      comment?: string;
    }
  ) => Promise<{ inwardIssueKey: string; outwardIssueKey: string; typeName: string }>;
  createJiraSubtask?: (
    token: string,
    input: {
      parentIssueKey: string;
      summary: string;
      projectKey?: string;
      issueTypeName?: string;
      issueTypeId?: string;
      description?: string;
      assigneeAccountId?: string;
    }
  ) => Promise<JiraIssue>;
  listAssignedJiraIssues: (token: string) => Promise<JiraIssue[]>;
  searchJiraIssues: (token: string, jql: string) => Promise<JiraIssue[]>;
  refreshJiraAccessToken?: (refreshToken: string) => Promise<JiraTokenSet>;
  saveJiraConnection?: (connection: ProviderConnection) => void;
  now?: () => Date;
};

export type JiraToolContext = {
  connection: ProviderConnection;
};

type JiraAuthErrorContent = { error: string; message: string };
type JiraAuthErrorResult = ToolResult<JiraAuthErrorContent>;
type JiraIssueContent = Array<{
  key: string;
  title: string;
  url: string;
  status?: string;
}>;
type JiraAccessibleResourceContent = Array<{
  id: string;
  url: string;
  name?: string;
}>;
type JiraVisibleProjectContent = Array<{
  id: string;
  key: string;
  name: string;
  url: string;
  issueTypes?: Array<{
    id: string;
    name: string;
    description?: string;
    subtask?: boolean;
  }>;
}>;
type JiraUserContent = Array<{
  accountId: string;
  displayName: string;
  emailAddress?: string;
}>;

export function createJiraTools(deps: JiraToolDeps) {
  return {
    getAuthenticatedUser: {
      async execute(
        context: JiraToolContext
      ): Promise<
        ToolResult<{ accountId: string; displayName: string } | JiraAuthErrorContent>
      > {
        const user = await withJiraToken(
          deps,
          context.connection,
          (accessToken) => deps.getJiraUser(accessToken)
        );
        if (isJiraAuthErrorResult(user)) {
          return user;
        }

        return {
          classification: "user_private",
          content: {
            accountId: user.accountId,
            displayName: user.displayName
          }
        };
      }
    },

    listAccessibleResources: {
      async execute(
        context: JiraToolContext
      ): Promise<ToolResult<JiraAccessibleResourceContent | JiraAuthErrorContent>> {
        const resources = await withJiraToken(
          deps,
          context.connection,
          (accessToken) => {
            if (!deps.listJiraAccessibleResources) {
              throw new Error("Jira accessible resources lookup is not configured");
            }

            return deps.listJiraAccessibleResources(accessToken);
          }
        );
        if (isJiraAuthErrorResult(resources)) {
          return resources;
        }

        return {
          classification: "user_private",
          content: resources
            .filter((resource) =>
              resource.scopes?.some((scope) => scope.includes("jira"))
            )
            .slice(0, 20)
            .map((resource) => ({
              id: resource.id,
              url: resource.url,
              ...(resource.name ? { name: resource.name } : {})
            }))
        };
      }
    },

    listVisibleProjects: {
      async execute(
        context: JiraToolContext & {
          input?: {
            query?: string;
            action?: "view" | "browse" | "edit" | "create";
            expandIssueTypes?: boolean;
          };
        }
      ): Promise<ToolResult<JiraVisibleProjectContent | JiraAuthErrorContent>> {
        const projects = await withJiraToken(
          deps,
          context.connection,
          (accessToken) => {
            if (!deps.listVisibleJiraProjects) {
              throw new Error("Jira project lookup is not configured");
            }

            return deps.listVisibleJiraProjects(accessToken, context.input ?? {});
          }
        );
        if (isJiraAuthErrorResult(projects)) {
          return projects;
        }

        return {
          classification: "user_private",
          content: projects.slice(0, 20).map((project) => ({
            id: project.id,
            key: project.key,
            name: project.name,
            url: project.url,
            ...(project.issueTypes
              ? {
                  issueTypes: project.issueTypes.slice(0, 50).map((issueType) => ({
                    id: issueType.id,
                    name: issueType.name,
                    ...(issueType.description
                      ? { description: issueType.description }
                      : {}),
                    ...(typeof issueType.subtask === "boolean"
                      ? { subtask: issueType.subtask }
                      : {})
                  }))
                }
              : {})
          }))
        };
      }
    },

    searchUsers: {
      async execute(
        context: JiraToolContext & { input: { query: string } }
      ): Promise<ToolResult<JiraUserContent | JiraAuthErrorContent>> {
        const users = await withJiraToken(
          deps,
          context.connection,
          (accessToken) => {
            if (!deps.searchJiraUsers) {
              throw new Error("Jira user search is not configured");
            }

            return deps.searchJiraUsers(accessToken, context.input.query);
          }
        );
        if (isJiraAuthErrorResult(users)) {
          return users;
        }

        return {
          classification: "user_private",
          content: users.slice(0, 10).map((user) => ({
            accountId: user.accountId,
            displayName: user.displayName,
            ...(user.emailAddress ? { emailAddress: user.emailAddress } : {})
          }))
        };
      }
    },

    createIssue: {
      async execute(
        context: JiraToolContext & {
          input: {
            projectKey: string;
            issueTypeName?: string;
            issueTypeId?: string;
            summary: string;
            description?: string;
            assigneeAccountId?: string;
          };
        }
      ): Promise<ToolResult<JiraIssueContent[number] | JiraAuthErrorContent>> {
        const issue = await withJiraToken(
          deps,
          context.connection,
          (accessToken) => {
            if (!deps.createJiraIssue) {
              throw new Error("Jira issue create is not configured");
            }

            return deps.createJiraIssue(accessToken, context.input);
          }
        );
        if (isJiraAuthErrorResult(issue)) {
          return issue;
        }

        return {
          classification: "user_private",
          content: sanitizeIssue(issue)
        };
      }
    },

    editIssue: {
      async execute(
        context: JiraToolContext & {
          input: {
            issueKey: string;
            summary?: string;
            description?: string;
            assigneeAccountId?: string | null;
          };
        }
      ): Promise<ToolResult<JiraIssueContent[number] | JiraAuthErrorContent>> {
        const issue = await withJiraToken(
          deps,
          context.connection,
          (accessToken) => {
            if (!deps.editJiraIssue) {
              throw new Error("Jira issue edit is not configured");
            }

            return deps.editJiraIssue(accessToken, context.input);
          }
        );
        if (isJiraAuthErrorResult(issue)) {
          return issue;
        }

        return {
          classification: "user_private",
          content: sanitizeIssue(issue)
        };
      }
    },

    getIssue: {
      async execute(
        context: JiraToolContext & { input: { issueKey: string } }
      ): Promise<ToolResult<JiraIssueContent[number] | JiraAuthErrorContent>> {
        const issue = await withJiraToken(
          deps,
          context.connection,
          (accessToken) => {
            if (!deps.getJiraIssue) {
              throw new Error("Jira issue lookup is not configured");
            }
            return deps.getJiraIssue(accessToken, context.input);
          }
        );
        if (isJiraAuthErrorResult(issue)) {
          return issue;
        }
        return {
          classification: "user_private",
          content: sanitizeIssue(issue)
        };
      }
    },

    updateIssue: {
      async execute(
        context: JiraToolContext & {
          input: {
            issueKey: string;
            summary?: string;
            description?: string;
            assigneeAccountId?: string | null;
            labels?: string[];
          };
        }
      ): Promise<ToolResult<JiraIssueContent[number] | JiraAuthErrorContent>> {
        const issue = await withJiraToken(
          deps,
          context.connection,
          (accessToken) => {
            if (!deps.updateJiraIssue) {
              throw new Error("Jira issue update is not configured");
            }
            return deps.updateJiraIssue(accessToken, context.input);
          }
        );
        if (isJiraAuthErrorResult(issue)) {
          return issue;
        }
        return {
          classification: "user_private",
          content: sanitizeIssue(issue)
        };
      }
    },

    addComment: {
      async execute(
        context: JiraToolContext & { input: { issueKey: string; body: string } }
      ): Promise<ToolResult<{ id: string; url: string } | JiraAuthErrorContent>> {
        const comment = await withJiraToken(
          deps,
          context.connection,
          (accessToken) => {
            if (!deps.addJiraIssueComment) {
              throw new Error("Jira comment create is not configured");
            }
            return deps.addJiraIssueComment(accessToken, context.input);
          }
        );
        if (isJiraAuthErrorResult(comment)) {
          return comment;
        }
        return {
          classification: "user_private",
          content: comment
        };
      }
    },

    transitionIssue: {
      async execute(
        context: JiraToolContext & {
          input: { issueKey: string; transitionId?: string; transitionName?: string };
        }
      ): Promise<ToolResult<JiraIssueContent[number] | JiraAuthErrorContent>> {
        const issue = await withJiraToken(
          deps,
          context.connection,
          (accessToken) => {
            if (!deps.transitionJiraIssue) {
              throw new Error("Jira issue transition is not configured");
            }
            return deps.transitionJiraIssue(accessToken, context.input);
          }
        );
        if (isJiraAuthErrorResult(issue)) {
          return issue;
        }
        return {
          classification: "user_private",
          content: sanitizeIssue(issue)
        };
      }
    },

    addLabels: {
      async execute(
        context: JiraToolContext & { input: { issueKey: string; labels: string[] } }
      ): Promise<ToolResult<JiraIssueContent[number] | JiraAuthErrorContent>> {
        const issue = await withJiraToken(
          deps,
          context.connection,
          (accessToken) => {
            if (!deps.addJiraIssueLabels) {
              throw new Error("Jira label add is not configured");
            }
            return deps.addJiraIssueLabels(accessToken, context.input);
          }
        );
        if (isJiraAuthErrorResult(issue)) {
          return issue;
        }
        return {
          classification: "user_private",
          content: sanitizeIssue(issue)
        };
      }
    },

    removeLabels: {
      async execute(
        context: JiraToolContext & { input: { issueKey: string; labels: string[] } }
      ): Promise<ToolResult<JiraIssueContent[number] | JiraAuthErrorContent>> {
        const issue = await withJiraToken(
          deps,
          context.connection,
          (accessToken) => {
            if (!deps.removeJiraIssueLabels) {
              throw new Error("Jira label remove is not configured");
            }
            return deps.removeJiraIssueLabels(accessToken, context.input);
          }
        );
        if (isJiraAuthErrorResult(issue)) {
          return issue;
        }
        return {
          classification: "user_private",
          content: sanitizeIssue(issue)
        };
      }
    },

    linkIssues: {
      async execute(
        context: JiraToolContext & {
          input: {
            inwardIssueKey: string;
            outwardIssueKey: string;
            typeName?: string;
            comment?: string;
          };
        }
      ): Promise<
        ToolResult<
          { inwardIssueKey: string; outwardIssueKey: string; typeName: string } | JiraAuthErrorContent
        >
      > {
        const link = await withJiraToken(
          deps,
          context.connection,
          (accessToken) => {
            if (!deps.linkJiraIssues) {
              throw new Error("Jira issue link is not configured");
            }
            return deps.linkJiraIssues(accessToken, context.input);
          }
        );
        if (isJiraAuthErrorResult(link)) {
          return link;
        }
        return {
          classification: "user_private",
          content: link
        };
      }
    },

    createSubtask: {
      async execute(
        context: JiraToolContext & {
          input: {
            parentIssueKey: string;
            summary: string;
            projectKey?: string;
            issueTypeName?: string;
            issueTypeId?: string;
            description?: string;
            assigneeAccountId?: string;
          };
        }
      ): Promise<ToolResult<JiraIssueContent[number] | JiraAuthErrorContent>> {
        const issue = await withJiraToken(
          deps,
          context.connection,
          (accessToken) => {
            if (!deps.createJiraSubtask) {
              throw new Error("Jira subtask create is not configured");
            }
            return deps.createJiraSubtask(accessToken, context.input);
          }
        );
        if (isJiraAuthErrorResult(issue)) {
          return issue;
        }
        return {
          classification: "user_private",
          content: sanitizeIssue(issue)
        };
      }
    },

    listAssignedIssues: {
      async execute(
        context: JiraToolContext
      ): Promise<ToolResult<JiraIssueContent | JiraAuthErrorContent>> {
        const issues = await withJiraToken(
          deps,
          context.connection,
          (accessToken) => deps.listAssignedJiraIssues(accessToken)
        );
        if (isJiraAuthErrorResult(issues)) {
          return issues;
        }

        return {
          classification: "user_private",
          content: sanitizeIssues(issues)
        };
      }
    },

    searchIssues: {
      async execute(
        context: JiraToolContext & { input: { jql: string } }
      ): Promise<ToolResult<JiraIssueContent | JiraAuthErrorContent>> {
        const issues = await withJiraToken(
          deps,
          context.connection,
          (accessToken) => deps.searchJiraIssues(accessToken, context.input.jql)
        );
        if (isJiraAuthErrorResult(issues)) {
          return issues;
        }

        return {
          classification: "user_private",
          content: sanitizeIssues(issues)
        };
      }
    }
  };
}

export async function withFreshJiraToken<T>(
  deps: JiraToolDeps,
  connection: ProviderConnection,
  callback: (accessToken: string) => Promise<T>
): Promise<T | JiraAuthErrorResult> {
  return withJiraToken(deps, connection, callback);
}

async function withJiraToken<T>(
  deps: JiraToolDeps,
  connection: ProviderConnection,
  callback: (accessToken: string) => Promise<T>
): Promise<T | JiraAuthErrorResult> {
  let current = await refreshIfNeeded(deps, connection);

  try {
    return await callback(current.accessToken);
  } catch (error) {
    if (!isJiraAuthorizationError(error)) {
      throw error;
    }

    const refreshed = await refreshConnection(deps, current);
    if (!refreshed) {
      return jiraReconnectResult();
    }

    current = refreshed;
    try {
      return await callback(current.accessToken);
    } catch (retryError) {
      if (isJiraAuthorizationError(retryError)) {
        return jiraReconnectResult();
      }
      throw retryError;
    }
  }
}

async function refreshIfNeeded(
  deps: JiraToolDeps,
  connection: ProviderConnection
): Promise<ProviderConnection> {
  if (!connection.accessTokenExpiresAt) {
    return connection;
  }

  const expiresAtMs = new Date(connection.accessTokenExpiresAt).getTime();
  if (!Number.isFinite(expiresAtMs)) {
    return connection;
  }

  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  return expiresAtMs - nowMs <= 60_000
    ? (await refreshConnection(deps, connection)) ?? connection
    : connection;
}

async function refreshConnection(
  deps: JiraToolDeps,
  connection: ProviderConnection
): Promise<ProviderConnection | null> {
  if (!connection.refreshToken || !deps.refreshJiraAccessToken) {
    return null;
  }

  const tokenSet = await deps.refreshJiraAccessToken(connection.refreshToken);
  const refreshed = {
    ...connection,
    accessToken: tokenSet.accessToken,
    refreshToken: tokenSet.refreshToken ?? connection.refreshToken,
    accessTokenExpiresAt: tokenSet.accessTokenExpiresAt
  };
  deps.saveJiraConnection?.(refreshed);
  return refreshed;
}

function jiraReconnectResult(): JiraAuthErrorResult {
  return {
    classification: "user_private",
    content: {
      error: "jira_authorization_failed",
      message: "Jira authorization expired. Reconnect Jira with `@Burble connect jira`."
    }
  };
}

export function isJiraAuthErrorResult(value: unknown): value is JiraAuthErrorResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "classification" in value &&
    "content" in value
  );
}

function sanitizeIssues(issues: JiraIssue[]) {
  return issues.slice(0, 10).map(sanitizeIssue);
}

function sanitizeIssue(issue: JiraIssue) {
  return {
    key: issue.key,
    title: issue.summary,
    url: issue.url,
    ...(issue.status ? { status: issue.status } : {}),
    ...(issue.description ? { description: issue.description } : {}),
    ...(issue.issueType ? { issueType: issue.issueType } : {}),
    ...(issue.parentKey ? { parentKey: issue.parentKey } : {}),
    ...(issue.labels ? { labels: issue.labels } : {})
  };
}
