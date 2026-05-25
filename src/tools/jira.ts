import type { ProviderConnection } from "../db";
import {
  isJiraAuthorizationError,
  type JiraAccessibleResource,
  type JiraTokenSet
} from "../jira";
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
};

export type JiraToolDeps = {
  getJiraUser: (token: string) => Promise<JiraUser>;
  listJiraAccessibleResources?: (token: string) => Promise<JiraAccessibleResource[]>;
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
  return issues.slice(0, 10).map((issue) => ({
    key: issue.key,
    title: issue.summary,
    url: issue.url,
    ...(issue.status ? { status: issue.status } : {})
  }));
}
