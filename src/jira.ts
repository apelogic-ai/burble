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

type JiraAccessibleResource = {
  id: string;
  url: string;
  scopes?: string[];
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

export function buildJiraOAuthUrl(config: Config, state: string): string {
  if (!config.jiraClientId || !config.jiraClientSecret) {
    throw new Error("Jira OAuth is not configured");
  }

  const url = new URL("https://auth.atlassian.com/authorize");
  url.searchParams.set("audience", "api.atlassian.com");
  url.searchParams.set("client_id", config.jiraClientId);
  url.searchParams.set("scope", "read:jira-user read:jira-work");
  url.searchParams.set("redirect_uri", `${config.baseUrl}/oauth/jira/callback`);
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

export async function exchangeJiraCode(
  config: Config,
  code: string
): Promise<string> {
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
    error?: string;
    error_description?: string;
  };

  if (!response.ok || !body.access_token) {
    throw new Error(
      body.error_description ?? body.error ?? "Jira token exchange failed"
    );
  }

  return body.access_token;
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
    throw new Error(`Jira user lookup failed with ${response.status}`);
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
    throw new Error(
      body.errorMessages?.join("; ") ?? `Jira issue search failed with ${response.status}`
    );
  }

  return (body.issues ?? []).map((issue) => ({
    key: issue.key,
    summary: issue.fields?.summary ?? issue.key,
    url: `${resource.url.replace(/\/+$/, "")}/browse/${issue.key}`,
    ...(issue.fields?.status?.name ? { status: issue.fields.status.name } : {})
  }));
}

async function resolveJiraResource(token: string): Promise<JiraAccessibleResource> {
  const response = await fetch(
    "https://api.atlassian.com/oauth/token/accessible-resources",
    {
      headers: jiraHeaders(token)
    }
  );

  if (!response.ok) {
    throw new Error(`Jira accessible resources lookup failed with ${response.status}`);
  }

  const resources = (await response.json()) as JiraAccessibleResource[];
  const resource = resources.find((candidate) =>
    candidate.scopes?.some((scope) => scope.includes("jira"))
  ) ?? resources[0];

  if (!resource) {
    throw new Error("No accessible Jira site found for this Atlassian account");
  }

  return resource;
}

function jiraHeaders(token: string): HeadersInit {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${token}`
  };
}
