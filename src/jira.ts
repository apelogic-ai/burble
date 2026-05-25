import type { Config } from "./config";

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

export type JiraTokenSet = {
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: string | null;
};

export class JiraApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "JiraApiError";
  }
}

export type JiraAccessibleResource = {
  id: string;
  url: string;
  name?: string;
  scopes?: string[];
};

export type JiraProjectIssueType = {
  id: string;
  name: string;
  description?: string;
  subtask?: boolean;
};

export type JiraVisibleProject = {
  id: string;
  key: string;
  name: string;
  url: string;
  issueTypes?: JiraProjectIssueType[];
};

type JiraSearchResponse = {
  issues?: Array<{
    key: string;
    fields?: {
      summary?: string;
      status?: {
        name?: string;
      };
    };
  }>;
};

type JiraProjectSearchResponse = {
  values?: Array<{
    id?: string;
    key?: string;
    name?: string;
    issueTypes?: Array<{
      id?: string;
      name?: string;
      description?: string;
      subtask?: boolean;
    }>;
  }>;
};

export function buildJiraOAuthUrl(config: Config, state: string): string {
  if (!config.jiraClientId || !config.jiraClientSecret) {
    throw new Error("Jira OAuth is not configured");
  }

  const url = new URL("https://auth.atlassian.com/authorize");
  url.searchParams.set("audience", "api.atlassian.com");
  url.searchParams.set("client_id", config.jiraClientId);
  url.searchParams.set(
    "scope",
    "read:jira-user read:jira-work write:jira-work offline_access"
  );
  url.searchParams.set("redirect_uri", `${config.baseUrl}/oauth/jira/callback`);
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

export async function exchangeJiraCode(
  config: Config,
  code: string
): Promise<JiraTokenSet> {
  if (!config.jiraClientId || !config.jiraClientSecret) {
    throw new Error("Jira OAuth is not configured");
  }

  const response = await fetch("https://auth.atlassian.com/oauth/token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: config.jiraClientId,
      client_secret: config.jiraClientSecret,
      code,
      redirect_uri: `${config.baseUrl}/oauth/jira/callback`
    })
  });

  const body = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || !body.access_token) {
    throw new Error(
      body.error_description ?? body.error ?? "Jira token exchange failed"
    );
  }

  return jiraTokenSetFromResponse(body);
}

export async function refreshJiraAccessToken(
  config: Config,
  refreshToken: string
): Promise<JiraTokenSet> {
  if (!config.jiraClientId || !config.jiraClientSecret) {
    throw new Error("Jira OAuth is not configured");
  }

  const response = await fetch("https://auth.atlassian.com/oauth/token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: config.jiraClientId,
      client_secret: config.jiraClientSecret,
      refresh_token: refreshToken
    })
  });

  const body = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || !body.access_token) {
    throw new Error(
      body.error_description ?? body.error ?? "Jira token refresh failed"
    );
  }

  return jiraTokenSetFromResponse(body);
}

export async function getJiraUser(token: string): Promise<JiraUser> {
  const resource = await resolveJiraResource(token);
  const response = await fetch(
    `https://api.atlassian.com/ex/jira/${resource.id}/rest/api/3/myself`,
    {
      headers: jiraHeaders(token)
    }
  );

  if (!response.ok) {
    throw new JiraApiError(`Jira user lookup failed with ${response.status}`, response.status);
  }

  return (await response.json()) as JiraUser;
}

export async function listAssignedJiraIssues(
  token: string
): Promise<JiraIssue[]> {
  return searchJiraIssues(
    token,
    "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC"
  );
}

export async function searchJiraIssues(
  token: string,
  jql: string
): Promise<JiraIssue[]> {
  const resource = await resolveJiraResource(token);
  const url = new URL(
    `https://api.atlassian.com/ex/jira/${resource.id}/rest/api/3/search/jql`
  );
  url.searchParams.set("jql", jql);
  url.searchParams.set("maxResults", "10");
  url.searchParams.set("fields", "summary,status");

  const response = await fetch(url, {
    headers: jiraHeaders(token)
  });
  const body = (await response.json()) as JiraSearchResponse & {
    errorMessages?: string[];
  };

  if (!response.ok) {
    throw new JiraApiError(
      body.errorMessages?.join("; ") ?? `Jira issue search failed with ${response.status}`,
      response.status
    );
  }

  return (body.issues ?? []).map((issue) => ({
    key: issue.key,
    summary: issue.fields?.summary ?? issue.key,
    url: `${resource.url.replace(/\/+$/, "")}/browse/${issue.key}`,
    ...(issue.fields?.status?.name ? { status: issue.fields.status.name } : {})
  }));
}

export async function listJiraAccessibleResources(
  token: string
): Promise<JiraAccessibleResource[]> {
  const response = await fetch(
    "https://api.atlassian.com/oauth/token/accessible-resources",
    {
      headers: jiraHeaders(token)
    }
  );

  if (!response.ok) {
    throw new JiraApiError(
      `Jira accessible resources lookup failed with ${response.status}`,
      response.status
    );
  }

  return (await response.json()) as JiraAccessibleResource[];
}

export async function listVisibleJiraProjects(
  token: string,
  input: {
    query?: string;
    action?: "view" | "browse" | "edit" | "create";
    expandIssueTypes?: boolean;
  } = {}
): Promise<JiraVisibleProject[]> {
  const resource = await resolveJiraResource(token);
  const url = new URL(
    `https://api.atlassian.com/ex/jira/${resource.id}/rest/api/3/project/search`
  );
  url.searchParams.set("maxResults", "20");
  if (input.query?.trim()) {
    url.searchParams.set("query", input.query.trim());
  }
  if (input.action) {
    url.searchParams.set("action", input.action);
  }
  if (input.expandIssueTypes) {
    url.searchParams.set("expand", "issueTypes");
  }

  const response = await fetch(url, {
    headers: jiraHeaders(token)
  });
  const body = (await response.json()) as JiraProjectSearchResponse & {
    errorMessages?: string[];
  };

  if (!response.ok) {
    throw new JiraApiError(
      body.errorMessages?.join("; ") ??
        `Jira project search failed with ${response.status}`,
      response.status
    );
  }

  return (body.values ?? [])
    .filter((project) => project.key && project.name)
    .slice(0, 20)
    .map((project) => ({
      id: project.id ?? project.key!,
      key: project.key!,
      name: project.name!,
      url: `${resource.url.replace(/\/+$/, "")}/jira/projects/${project.key}`,
      ...(input.expandIssueTypes
        ? { issueTypes: sanitizeProjectIssueTypes(project.issueTypes ?? []) }
        : {})
    }));
}

async function resolveJiraResource(token: string): Promise<JiraAccessibleResource> {
  const resources = await listJiraAccessibleResources(token);
  const resource = resources.find((candidate) =>
    candidate.scopes?.some((scope) => scope.includes("jira"))
  ) ?? resources[0];

  if (!resource) {
    throw new Error("No accessible Jira site found for this Atlassian account");
  }

  return resource;
}

function sanitizeProjectIssueTypes(
  issueTypes: NonNullable<JiraProjectSearchResponse["values"]>[number]["issueTypes"]
): JiraProjectIssueType[] {
  return (issueTypes ?? [])
    .filter((issueType) => issueType.id && issueType.name)
    .map((issueType) => ({
      id: issueType.id!,
      name: issueType.name!,
      ...(issueType.description ? { description: issueType.description } : {}),
      ...(typeof issueType.subtask === "boolean"
        ? { subtask: issueType.subtask }
        : {})
    }));
}

function jiraTokenSetFromResponse(body: {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}): JiraTokenSet {
  if (!body.access_token) {
    throw new Error("Jira token response did not include an access token");
  }

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    accessTokenExpiresAt:
      typeof body.expires_in === "number" && body.expires_in > 0
        ? new Date(Date.now() + body.expires_in * 1000).toISOString()
        : null
  };
}

export function isJiraAuthorizationError(error: unknown): boolean {
  return error instanceof JiraApiError && error.status === 401;
}

function jiraHeaders(token: string): HeadersInit {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${token}`
  };
}
