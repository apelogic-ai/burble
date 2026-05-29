import type { Config } from "../../config";

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

type JiraCreateIssueResponse = {
  key?: string;
};

type JiraIssueApiResponse = {
  key?: string;
  fields?: {
    summary?: string;
    description?: unknown;
    status?: { name?: string };
    issuetype?: { name?: string };
    parent?: { key?: string };
    labels?: string[];
  };
};

type JiraErrorResponse = {
  errorMessages?: string[];
  errors?: Record<string, string>;
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

export async function searchJiraUsers(
  token: string,
  query: string
): Promise<JiraUser[]> {
  const resource = await resolveJiraResource(token);
  const url = new URL(
    `https://api.atlassian.com/ex/jira/${resource.id}/rest/api/3/user/search`
  );
  url.searchParams.set("query", query.trim());
  url.searchParams.set("maxResults", "10");

  const response = await fetch(url, {
    headers: jiraHeaders(token)
  });
  const body = (await response.json()) as JiraUser[] | JiraErrorResponse;

  if (!response.ok || !Array.isArray(body)) {
    throw new JiraApiError(
      formatJiraError(body, `Jira user search failed with ${response.status}`),
      response.status
    );
  }

  return body.slice(0, 10).map((user) => ({
    accountId: user.accountId,
    displayName: user.displayName,
    ...(user.emailAddress ? { emailAddress: user.emailAddress } : {})
  }));
}

export async function createJiraIssue(
  token: string,
  input: {
    projectKey: string;
    issueTypeName?: string;
    issueTypeId?: string;
    summary: string;
    description?: string;
    assigneeAccountId?: string;
  }
): Promise<JiraIssue> {
  if (!input.issueTypeName?.trim() && !input.issueTypeId?.trim()) {
    throw new Error("Jira issue creation requires an issue type name or ID");
  }

  const resource = await resolveJiraResource(token);
  const response = await fetch(
    `https://api.atlassian.com/ex/jira/${resource.id}/rest/api/3/issue`,
    {
      method: "POST",
      headers: jiraJsonHeaders(token),
      body: JSON.stringify({
        fields: {
          project: { key: input.projectKey },
          summary: input.summary,
          issuetype: input.issueTypeId
            ? { id: input.issueTypeId }
            : { name: input.issueTypeName },
          ...(input.description
            ? { description: plainTextToAdf(input.description) }
            : {}),
          ...(input.assigneeAccountId
            ? { assignee: { id: input.assigneeAccountId } }
            : {})
        }
      })
    }
  );
  const body = (await response.json()) as JiraCreateIssueResponse | JiraErrorResponse;

  if (!response.ok || !("key" in body) || !body.key) {
    throw new JiraApiError(
      formatJiraError(body, `Jira issue create failed with ${response.status}`),
      response.status
    );
  }

  return {
    key: body.key,
    summary: input.summary,
    url: `${resource.url.replace(/\/+$/, "")}/browse/${body.key}`
  };
}

export async function getJiraIssue(
  token: string,
  input: { issueKey: string }
): Promise<JiraIssue> {
  const resource = await resolveJiraResource(token);
  const url = new URL(
    `https://api.atlassian.com/ex/jira/${resource.id}/rest/api/3/issue/${encodeURIComponent(input.issueKey)}`
  );
  url.searchParams.set(
    "fields",
    "summary,status,description,issuetype,parent,labels"
  );
  const response = await fetch(url, { headers: jiraHeaders(token) });
  const body = (await response.json()) as JiraIssueApiResponse | JiraErrorResponse;

  if (!response.ok || !("key" in body) || !body.key) {
    throw new JiraApiError(
      formatJiraError(body, `Jira issue lookup failed with ${response.status}`),
      response.status
    );
  }

  return jiraIssueFromApi(resource, body);
}

export async function editJiraIssue(
  token: string,
  input: {
    issueKey: string;
    summary?: string;
    description?: string;
    assigneeAccountId?: string | null;
  }
): Promise<JiraIssue> {
  const resource = await resolveJiraResource(token);
  const fields: Record<string, unknown> = {};
  if (input.summary?.trim()) {
    fields.summary = input.summary.trim();
  }
  if (input.description !== undefined) {
    fields.description = plainTextToAdf(input.description);
  }
  if (input.assigneeAccountId !== undefined) {
    fields.assignee = input.assigneeAccountId
      ? { id: input.assigneeAccountId }
      : null;
  }
  if (Object.keys(fields).length === 0) {
    throw new Error("No editable Jira issue fields were provided");
  }

  const response = await fetch(
    `https://api.atlassian.com/ex/jira/${resource.id}/rest/api/3/issue/${encodeURIComponent(input.issueKey)}`,
    {
      method: "PUT",
      headers: jiraJsonHeaders(token),
      body: JSON.stringify({ fields })
    }
  );
  const body = await readOptionalJiraJson(response);

  if (!response.ok) {
    throw new JiraApiError(
      formatJiraError(body, `Jira issue edit failed with ${response.status}`),
      response.status
    );
  }

  return {
    key: input.issueKey,
    summary: input.summary ?? input.issueKey,
    url: `${resource.url.replace(/\/+$/, "")}/browse/${input.issueKey}`
  };
}

export async function updateJiraIssue(
  token: string,
  input: {
    issueKey: string;
    summary?: string;
    description?: string;
    assigneeAccountId?: string | null;
    labels?: string[];
  }
): Promise<JiraIssue> {
  const resource = await resolveJiraResource(token);
  const fields: Record<string, unknown> = {};
  if (input.summary?.trim()) {
    fields.summary = input.summary.trim();
  }
  if (input.description !== undefined) {
    fields.description = plainTextToAdf(input.description);
  }
  if (input.assigneeAccountId !== undefined) {
    fields.assignee = input.assigneeAccountId
      ? { id: input.assigneeAccountId }
      : null;
  }
  if (input.labels !== undefined) {
    fields.labels = input.labels;
  }
  if (Object.keys(fields).length === 0) {
    throw new Error("No editable Jira issue fields were provided");
  }

  const response = await fetch(
    `https://api.atlassian.com/ex/jira/${resource.id}/rest/api/3/issue/${encodeURIComponent(input.issueKey)}`,
    {
      method: "PUT",
      headers: jiraJsonHeaders(token),
      body: JSON.stringify({ fields })
    }
  );
  const body = await readOptionalJiraJson(response);
  if (!response.ok) {
    throw new JiraApiError(
      formatJiraError(body, `Jira issue update failed with ${response.status}`),
      response.status
    );
  }
  return getJiraIssue(token, { issueKey: input.issueKey });
}

export async function addJiraIssueComment(
  token: string,
  input: { issueKey: string; body: string }
): Promise<{ id: string; url: string }> {
  const resource = await resolveJiraResource(token);
  const response = await fetch(
    `https://api.atlassian.com/ex/jira/${resource.id}/rest/api/3/issue/${encodeURIComponent(input.issueKey)}/comment`,
    {
      method: "POST",
      headers: jiraJsonHeaders(token),
      body: JSON.stringify({ body: plainTextToAdf(input.body) })
    }
  );
  const body = (await response.json()) as { id?: string } | JiraErrorResponse;
  if (!response.ok || !("id" in body) || !body.id) {
    throw new JiraApiError(
      formatJiraError(body, `Jira comment create failed with ${response.status}`),
      response.status
    );
  }
  return {
    id: body.id,
    url: `${resource.url.replace(/\/+$/, "")}/browse/${input.issueKey}?focusedCommentId=${body.id}`
  };
}

export async function transitionJiraIssue(
  token: string,
  input: { issueKey: string; transitionId?: string; transitionName?: string }
): Promise<JiraIssue> {
  const resource = await resolveJiraResource(token);
  const transitionId =
    input.transitionId ??
    (input.transitionName
      ? await resolveJiraTransitionId(token, resource, input.issueKey, input.transitionName)
      : null);
  if (!transitionId) {
    throw new Error("Jira transition requires transitionId or transitionName");
  }
  const response = await fetch(
    `https://api.atlassian.com/ex/jira/${resource.id}/rest/api/3/issue/${encodeURIComponent(input.issueKey)}/transitions`,
    {
      method: "POST",
      headers: jiraJsonHeaders(token),
      body: JSON.stringify({ transition: { id: transitionId } })
    }
  );
  const body = await readOptionalJiraJson(response);
  if (!response.ok) {
    throw new JiraApiError(
      formatJiraError(body, `Jira transition failed with ${response.status}`),
      response.status
    );
  }
  return getJiraIssue(token, { issueKey: input.issueKey });
}

export async function addJiraIssueLabels(
  token: string,
  input: { issueKey: string; labels: string[] }
): Promise<JiraIssue> {
  return mutateJiraIssueLabels(token, input.issueKey, input.labels, "add");
}

export async function removeJiraIssueLabels(
  token: string,
  input: { issueKey: string; labels: string[] }
): Promise<JiraIssue> {
  return mutateJiraIssueLabels(token, input.issueKey, input.labels, "remove");
}

export async function linkJiraIssues(
  token: string,
  input: {
    inwardIssueKey: string;
    outwardIssueKey: string;
    typeName?: string;
    comment?: string;
  }
): Promise<{ inwardIssueKey: string; outwardIssueKey: string; typeName: string }> {
  const resource = await resolveJiraResource(token);
  const typeName = input.typeName ?? "Relates";
  const response = await fetch(
    `https://api.atlassian.com/ex/jira/${resource.id}/rest/api/3/issueLink`,
    {
      method: "POST",
      headers: jiraJsonHeaders(token),
      body: JSON.stringify({
        type: { name: typeName },
        inwardIssue: { key: input.inwardIssueKey },
        outwardIssue: { key: input.outwardIssueKey },
        ...(input.comment ? { comment: { body: plainTextToAdf(input.comment) } } : {})
      })
    }
  );
  const body = await readOptionalJiraJson(response);
  if (!response.ok) {
    throw new JiraApiError(
      formatJiraError(body, `Jira issue link failed with ${response.status}`),
      response.status
    );
  }
  return {
    inwardIssueKey: input.inwardIssueKey,
    outwardIssueKey: input.outwardIssueKey,
    typeName
  };
}

export async function createJiraSubtask(
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
): Promise<JiraIssue> {
  if (!input.issueTypeName?.trim() && !input.issueTypeId?.trim()) {
    throw new Error("Jira subtask creation requires an issue type name or ID");
  }
  const projectKey = input.projectKey ?? input.parentIssueKey.split("-")[0];
  const resource = await resolveJiraResource(token);
  const response = await fetch(
    `https://api.atlassian.com/ex/jira/${resource.id}/rest/api/3/issue`,
    {
      method: "POST",
      headers: jiraJsonHeaders(token),
      body: JSON.stringify({
        fields: {
          project: { key: projectKey },
          parent: { key: input.parentIssueKey },
          summary: input.summary,
          issuetype: input.issueTypeId
            ? { id: input.issueTypeId }
            : { name: input.issueTypeName },
          ...(input.description
            ? { description: plainTextToAdf(input.description) }
            : {}),
          ...(input.assigneeAccountId
            ? { assignee: { id: input.assigneeAccountId } }
            : {})
        }
      })
    }
  );
  const body = (await response.json()) as JiraCreateIssueResponse | JiraErrorResponse;
  if (!response.ok || !("key" in body) || !body.key) {
    throw new JiraApiError(
      formatJiraError(body, `Jira subtask create failed with ${response.status}`),
      response.status
    );
  }
  return {
    key: body.key,
    summary: input.summary,
    url: `${resource.url.replace(/\/+$/, "")}/browse/${body.key}`,
    parentKey: input.parentIssueKey
  };
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

function plainTextToAdf(text: string) {
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: text
          ? [
              {
                type: "text",
                text
              }
            ]
          : []
      }
    ]
  };
}

function adfToPlainText(value: unknown): string | undefined {
  const parts: string[] = [];
  walkAdf(value, parts);
  const text = parts.join("").replace(/\n{3,}/g, "\n\n").trim();
  return text ? text : undefined;
}

function walkAdf(value: unknown, parts: string[]): void {
  if (!value || typeof value !== "object") {
    return;
  }
  const record = value as { type?: string; text?: string; content?: unknown[] };
  if (record.type === "text" && record.text) {
    parts.push(record.text);
  }
  if (record.type === "hardBreak") {
    parts.push("\n");
  }
  for (const child of record.content ?? []) {
    walkAdf(child, parts);
  }
  if (record.type === "paragraph") {
    parts.push("\n");
  }
}

function jiraIssueFromApi(
  resource: JiraAccessibleResource,
  issue: JiraIssueApiResponse
): JiraIssue {
  const key = issue.key!;
  return {
    key,
    summary: issue.fields?.summary ?? key,
    url: `${resource.url.replace(/\/+$/, "")}/browse/${key}`,
    ...(issue.fields?.status?.name ? { status: issue.fields.status.name } : {}),
    ...(issue.fields?.description
      ? { description: adfToPlainText(issue.fields.description) }
      : {}),
    ...(issue.fields?.issuetype?.name ? { issueType: issue.fields.issuetype.name } : {}),
    ...(issue.fields?.parent?.key ? { parentKey: issue.fields.parent.key } : {}),
    ...(issue.fields?.labels ? { labels: issue.fields.labels } : {})
  };
}

async function resolveJiraTransitionId(
  token: string,
  resource: JiraAccessibleResource,
  issueKey: string,
  transitionName: string
): Promise<string> {
  const response = await fetch(
    `https://api.atlassian.com/ex/jira/${resource.id}/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`,
    { headers: jiraHeaders(token) }
  );
  const body = (await response.json()) as {
    transitions?: Array<{ id?: string; name?: string }>;
  } & JiraErrorResponse;
  if (!response.ok) {
    throw new JiraApiError(
      formatJiraError(body, `Jira transition lookup failed with ${response.status}`),
      response.status
    );
  }
  const transition = body.transitions?.find(
    (candidate) =>
      candidate.name?.toLowerCase() === transitionName.trim().toLowerCase()
  );
  if (!transition?.id) {
    throw new Error(`No Jira transition named "${transitionName}" is available`);
  }
  return transition.id;
}

async function mutateJiraIssueLabels(
  token: string,
  issueKey: string,
  labels: string[],
  operation: "add" | "remove"
): Promise<JiraIssue> {
  const resource = await resolveJiraResource(token);
  const response = await fetch(
    `https://api.atlassian.com/ex/jira/${resource.id}/rest/api/3/issue/${encodeURIComponent(issueKey)}`,
    {
      method: "PUT",
      headers: jiraJsonHeaders(token),
      body: JSON.stringify({
        update: {
          labels: labels.map((label) => ({ [operation]: label }))
        }
      })
    }
  );
  const body = await readOptionalJiraJson(response);
  if (!response.ok) {
    throw new JiraApiError(
      formatJiraError(body, `Jira label ${operation} failed with ${response.status}`),
      response.status
    );
  }
  return getJiraIssue(token, { issueKey });
}

async function readOptionalJiraJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function formatJiraError(body: unknown, fallback: string): string {
  if (!body || typeof body !== "object") {
    return fallback;
  }

  const record = body as JiraErrorResponse;
  const messages = [
    ...(record.errorMessages ?? []),
    ...Object.values(record.errors ?? {})
  ].filter(Boolean);
  return messages.length > 0 ? messages.join("; ") : fallback;
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

function jiraJsonHeaders(token: string): HeadersInit {
  return {
    ...jiraHeaders(token),
    "Content-Type": "application/json"
  };
}
