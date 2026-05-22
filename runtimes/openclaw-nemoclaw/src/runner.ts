import type { RuntimeConfig } from "./config";
import { createBurbleToolExecutor } from "./burble-tools";
import type { RunRequest, RunResponse, ToolExecutor, ToolResult } from "./types";

type LinkedItem = {
  title: string;
  url: string;
};

export async function runBurbleRequest(
  request: RunRequest,
  config: RuntimeConfig,
  executeTool: ToolExecutor = createBurbleToolExecutor(config)
): Promise<RunResponse> {
  const text = request.input.text.trim();
  if (!isSupportedProviderRequest(text)) {
    return response("user_private", "No Burble tool context is needed for this request.");
  }

  if (isSupportedJiraRequest(text)) {
    return runJiraRequest(request, executeTool);
  }

  return runGitHubRequest(request, executeTool);
}

async function runGitHubRequest(
  request: RunRequest,
  executeTool: ToolExecutor
): Promise<RunResponse> {
  const text = request.input.text.trim();
  const github = request.input.connections.github;
  if (!github.connected || !github.email) {
    return response("user_private", "Connect GitHub first: `@Burble connect github`.");
  }

  const normalized = text.toLowerCase();
  const user = { email: github.email };

  if (
    /\bwho\s+am\s+i\b/.test(normalized) ||
    /\bgithub\s+(me|identity|login)\b/.test(normalized)
  ) {
    const result = await executeTool("github.getAuthenticatedUser", { user });
    const login = readLogin(result);
    return response(
      result.classification,
      login
        ? `Authenticated to GitHub as \`${login}\`.`
        : "I could not determine your GitHub identity."
    );
  }

  if (/\bsearch\b/.test(normalized) && /\b(issue|issues)\b/.test(normalized)) {
    const query = buildIssueSearchQuery(text);
    const result = await executeTool("github.searchIssues", {
      user,
      input: { query }
    });
    return response(result.classification, formatItems("GitHub issue matches", result));
  }

  if (/\b(pull request|pull requests|prs?|reviews?)\b/.test(normalized)) {
    const result = await executeTool("github.listMyPullRequests", { user });
    return response(result.classification, formatItems("Your open PRs", result));
  }

  if (
    /\b(issue|issues)\b/.test(normalized) &&
    !/\bsummary|summarize|prioritize|attention|work\b/.test(normalized)
  ) {
    const result = await executeTool("github.listAssignedIssues", { user });
    return response(result.classification, formatItems("Assigned issues", result));
  }

  const [issues, prs] = await Promise.all([
    executeTool("github.listAssignedIssues", { user }),
    executeTool("github.listMyPullRequests", { user })
  ]);

  return response(
    mergeClassification(issues.classification, prs.classification),
    [
      "GitHub work that needs attention:",
      "",
      formatItems("Assigned issues", issues),
      "",
      formatItems("Your open PRs", prs)
    ].join("\n")
  );
}

async function runJiraRequest(
  request: RunRequest,
  executeTool: ToolExecutor
): Promise<RunResponse> {
  const text = request.input.text.trim();
  const jira = request.input.connections.jira;
  if (!jira?.connected || !jira.email) {
    return response("user_private", "Connect Jira first.");
  }

  const normalized = text.toLowerCase();
  const user = { email: jira.email };

  if (/\bwho\s+am\s+i\b/.test(normalized) || /\bjira\s+(me|identity|login)\b/.test(normalized)) {
    const result = await executeTool("jira.getAuthenticatedUser", { user });
    const displayName = readDisplayName(result);
    return response(
      result.classification,
      displayName
        ? `Authenticated to Jira as \`${displayName}\`.`
        : "I could not determine your Jira identity."
    );
  }

  if (/\bsearch\b/.test(normalized) && /\b(issue|issues|ticket|tickets)\b/.test(normalized)) {
    const result = await executeTool("jira.searchIssues", {
      user,
      input: { jql: buildJiraSearchQuery(text) }
    });
    return response(result.classification, formatItems("Jira issue matches", result));
  }

  const result = await executeTool("jira.listAssignedIssues", { user });
  return response(result.classification, formatItems("Assigned Jira issues", result));
}

export function isSupportedProviderRequest(text: string): boolean {
  return isSupportedGitHubRequest(text) || isSupportedJiraRequest(text);
}

export function isSupportedGitHubRequest(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    /\bgithub\b/.test(normalized) ||
    /\bwho\s+am\s+i\b/.test(normalized) ||
    /\b(issue|issues)\b/.test(normalized) ||
    /\b(pull request|pull requests|prs?|reviews?)\b/.test(normalized) ||
    /\b(summary|summarize|prioritize|attention|work)\b/.test(normalized)
  );
}

export function isSupportedJiraRequest(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    /\bjira\b/.test(normalized) ||
    /\b(ticket|tickets)\b/.test(normalized)
  );
}

function response(
  classification: RunResponse["response"]["classification"],
  text: string
): RunResponse {
  return {
    response: {
      classification,
      text
    }
  };
}

function readLogin(result: ToolResult): string | null {
  const content = result.content;
  if (
    typeof content === "object" &&
    content !== null &&
    "login" in content &&
    typeof content.login === "string"
  ) {
    return content.login;
  }

  return null;
}

function readDisplayName(result: ToolResult): string | null {
  const content = result.content;
  if (
    typeof content === "object" &&
    content !== null &&
    "displayName" in content &&
    typeof content.displayName === "string"
  ) {
    return content.displayName;
  }

  return null;
}

function formatItems(title: string, result: ToolResult): string {
  const items = readLinkedItems(result);
  if (items.length === 0) {
    return `${title}: none found.`;
  }

  return [
    `*${title}*`,
    ...items.map((item) => `- <${item.url}|${item.title}>`)
  ].join("\n");
}

function readLinkedItems(result: ToolResult): LinkedItem[] {
  if (!Array.isArray(result.content)) {
    return [];
  }

  return result.content.filter((item): item is LinkedItem => {
    return (
      typeof item === "object" &&
      item !== null &&
      "title" in item &&
      typeof item.title === "string" &&
      "url" in item &&
      typeof item.url === "string"
    );
  });
}

function buildIssueSearchQuery(text: string): string {
  const normalized = text
    .replace(/\b(search|github|issue|issues|for|about)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  return normalized ? `is:issue ${normalized}` : "is:issue";
}

function buildJiraSearchQuery(text: string): string {
  const normalized = text
    .replace(/\b(search|jira|issue|issues|ticket|tickets|for|about)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  return normalized
    ? `text ~ "${normalized.replace(/"/g, '\\"')}"`
    : "assignee = currentUser() AND statusCategory != Done";
}

function mergeClassification(
  left: RunResponse["response"]["classification"],
  right: RunResponse["response"]["classification"]
): RunResponse["response"]["classification"] {
  if (left === "restricted" || right === "restricted") {
    return "restricted";
  }

  if (left === "user_private" || right === "user_private") {
    return "user_private";
  }

  return "public";
}
