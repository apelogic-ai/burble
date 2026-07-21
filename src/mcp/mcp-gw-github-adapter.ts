import type { ToolResult } from "../tools/types";
import type { McpGwToolCallResult } from "./mcp-gw-client";
import type { UpstreamMcpToolResult } from "./upstream-http-client";

type McpGwGitHubCall = {
  name: string;
  arguments: Record<string, unknown>;
};

type McpGwGitHubAdaptedBase = {
  ok: true;
  burbleToolName: string;
};

export type McpGwGitHubToolPlan =
  | (McpGwGitHubAdaptedBase & {
      kind: "call";
      call: McpGwGitHubCall;
    })
  | (McpGwGitHubAdaptedBase & {
      kind: "labels";
      owner: string;
      repo: string;
      issueNumber: number;
      labels: string[];
      operation: "add" | "remove";
    })
  | (McpGwGitHubAdaptedBase & {
      kind: "file_write";
      owner: string;
      repo: string;
      path: string;
      content: string;
      message: string;
      branch: string | null;
      sha?: string;
    });

export type McpGwGitHubAdaptation =
  | McpGwGitHubToolPlan
  | { ok: false; burbleToolName: string; message: string };

export function adaptMcpGwGitHubToolCall(
  burbleToolName: string,
  input: unknown,
): McpGwGitHubAdaptation {
  const args = isRecord(input) ? input : {};
  try {
    switch (burbleToolName) {
      case "github_get_authenticated_user":
        return direct(burbleToolName, "github_get_me", {});
      case "github_list_assigned_issues":
        return direct(burbleToolName, "github_search_issues", {
          query: "assignee:@me is:open",
        });
      case "github_search_issues": {
        const query = requiredString(args, "query");
        return direct(
          burbleToolName,
          /(?:^|\s)is:pr(?:\s|$)/i.test(query)
            ? "github_search_pull_requests"
            : "github_search_issues",
          { query },
        );
      }
      case "github_list_my_pull_requests": {
        const state = optionalString(args, "state") ?? "open";
        const query = [`author:@me`, ...(state === "all" ? [] : [`is:${state}`])];
        const repository = optionalString(args, "repo");
        const ownerFilter = optionalString(args, "owner");
        const repositoryArgs = repository
          ? parseRepository(repository)
          : ownerFilter
            ? { queryQualifier: `org:${ownerFilter}` }
            : {};
        if ("queryQualifier" in repositoryArgs && repositoryArgs.queryQualifier) {
          query.push(repositoryArgs.queryQualifier);
        }
        return direct(burbleToolName, "github_search_pull_requests", {
          query: query.join(" "),
          ...("owner" in repositoryArgs
            ? { owner: repositoryArgs.owner, repo: repositoryArgs.repo }
            : {}),
          ...optionalField(args, "sort"),
          ...optionalField(args, "order"),
          ...(typeof args.limit === "number" ? { perPage: args.limit } : {}),
        });
      }
      case "github_create_issue": {
        const repository = parseRepository(requiredString(args, "repo"));
        return direct(burbleToolName, "github_issue_write", {
          method: "create",
          ...repository,
          title: requiredString(args, "title"),
          ...optionalField(args, "body"),
          ...optionalField(args, "labels"),
          ...optionalField(args, "assignees"),
        });
      }
      case "github_get_issue":
        return issueReadPlan(burbleToolName, args);
      case "github_get_pr": {
        const repository = parseRepository(requiredString(args, "repo"));
        return direct(burbleToolName, "github_pull_request_read", {
          method: "get",
          ...repository,
          pullNumber: requiredNumber(args, "number"),
        });
      }
      case "github_comment_on_issue_or_pr": {
        const repository = parseRepository(requiredString(args, "repo"));
        return direct(burbleToolName, "github_add_issue_comment", {
          ...repository,
          issue_number: requiredNumber(args, "number"),
          body: requiredString(args, "body"),
        });
      }
      case "github_update_issue": {
        const repository = parseRepository(requiredString(args, "repo"));
        return direct(burbleToolName, "github_issue_write", {
          method: "update",
          ...repository,
          issue_number: requiredNumber(args, "number"),
          ...optionalField(args, "title"),
          ...optionalField(args, "body"),
          ...optionalField(args, "state"),
          ...optionalField(args, "labels"),
          ...optionalField(args, "assignees"),
        });
      }
      case "github_close_issue":
      case "github_reopen_issue": {
        const repository = parseRepository(requiredString(args, "repo"));
        return direct(burbleToolName, "github_issue_write", {
          method: "update",
          ...repository,
          issue_number: requiredNumber(args, "number"),
          state:
            burbleToolName === "github_close_issue" ? "closed" : "open",
        });
      }
      case "github_create_pr": {
        const repository = parseRepository(requiredString(args, "repo"));
        return direct(burbleToolName, "github_create_pull_request", {
          ...repository,
          title: requiredString(args, "title"),
          head: requiredString(args, "head"),
          base: requiredString(args, "base"),
          ...optionalField(args, "body"),
          ...optionalField(args, "draft"),
        });
      }
      case "github_update_pr": {
        const repository = parseRepository(requiredString(args, "repo"));
        return direct(burbleToolName, "github_update_pull_request", {
          ...repository,
          pullNumber: requiredNumber(args, "number"),
          ...optionalField(args, "title"),
          ...optionalField(args, "body"),
          ...optionalField(args, "base"),
          ...optionalField(args, "draft"),
        });
      }
      case "github_add_labels":
      case "github_remove_labels": {
        const repository = parseRepository(requiredString(args, "repo"));
        return {
          ok: true,
          kind: "labels",
          burbleToolName,
          ...repository,
          issueNumber: requiredNumber(args, "number"),
          labels: requiredStringArray(args, "labels"),
          operation:
            burbleToolName === "github_add_labels" ? "add" : "remove",
        };
      }
      case "github_request_review": {
        const repository = parseRepository(requiredString(args, "repo"));
        const reviewers = optionalStringArray(args, "reviewers");
        const teamReviewers = optionalStringArray(args, "teamReviewers").map(
          (team) => `${repository.owner}/${team}`,
        );
        return direct(burbleToolName, "github_update_pull_request", {
          ...repository,
          pullNumber: requiredNumber(args, "number"),
          reviewers: [...reviewers, ...teamReviewers],
        });
      }
      case "github_get_file": {
        const repository = parseRepository(requiredString(args, "repo"));
        return direct(burbleToolName, "github_get_file_contents", {
          ...repository,
          path: requiredString(args, "path"),
          ...optionalField(args, "ref"),
        });
      }
      case "github_create_or_update_file": {
        const repository = parseRepository(requiredString(args, "repo"));
        return {
          ok: true,
          kind: "file_write",
          burbleToolName,
          ...repository,
          path: requiredString(args, "path"),
          content: requiredString(args, "content", true),
          message: requiredString(args, "message"),
          branch: optionalString(args, "branch"),
          ...(optionalString(args, "sha")
            ? { sha: optionalString(args, "sha") as string }
            : {}),
        };
      }
      case "github_create_branch": {
        const repository = parseRepository(requiredString(args, "repo"));
        return direct(burbleToolName, "github_create_branch", {
          ...repository,
          branch: requiredString(args, "branch"),
          ...(optionalString(args, "fromRef")
            ? { from_branch: optionalString(args, "fromRef") }
            : {}),
        });
      }
      default:
        return unsupported(burbleToolName);
    }
  } catch (error) {
    return {
      ok: false,
      burbleToolName,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function mcpGwGitHubToolResult(
  plan: McpGwGitHubToolPlan,
  result: McpGwToolCallResult,
): ToolResult<unknown> {
  if (result.status === "needs_connect") {
    const message = result.message.trim().replace(/[.\s]+$/, "");
    return {
      classification: "user_private",
      content: {
        error: "github_not_connected",
        message: `${message || "GitHub connection required"} Run \`/auth github\` to connect or reconnect GitHub.`,
        authCommand: "/auth github",
        ...(result.connectUrl ? { connectUrl: result.connectUrl } : {}),
      },
    };
  }
  if (result.result.isError) {
    return {
      classification: "user_private",
      content: {
        error: "github_tool_failed",
        message: readMcpToolResultText(result.result) || "GitHub tool failed.",
        toolName: resultToolName(plan),
        burbleToolName: plan.burbleToolName,
      },
    };
  }
  return {
    classification: "user_private",
    content: {
      mcpGw: true,
      toolName: resultToolName(plan),
      burbleToolName: plan.burbleToolName,
      result: compactGitHubSearchResult(plan, result.result),
    },
  };
}

export async function executeMcpGwGitHubToolPlan(
  plan: McpGwGitHubToolPlan,
  call: (input: McpGwGitHubCall) => Promise<McpGwToolCallResult>,
): Promise<McpGwToolCallResult> {
  if (plan.kind === "call") {
    return call(plan.call);
  }

  if (plan.kind === "labels") {
    const current = await call({
      name: "github_issue_read",
      arguments: {
        method: "get",
        owner: plan.owner,
        repo: plan.repo,
        issue_number: plan.issueNumber,
      },
    });
    if (current.status !== "ok" || current.result.isError) {
      return current;
    }
    const currentLabels = readIssueLabels(current.result);
    const requested = new Set(plan.labels.map((label) => label.toLowerCase()));
    const labels =
      plan.operation === "add"
        ? [...new Set([...currentLabels, ...plan.labels])]
        : currentLabels.filter((label) => !requested.has(label.toLowerCase()));
    return call({
      name: "github_issue_write",
      arguments: {
        method: "update",
        owner: plan.owner,
        repo: plan.repo,
        issue_number: plan.issueNumber,
        labels,
      },
    });
  }

  let branch = plan.branch;
  if (!branch) {
    const repositoryResult = await call({
      name: "github_search_repositories",
      arguments: {
        query: `repo:${plan.owner}/${plan.repo}`,
        perPage: 1,
      },
    });
    if (repositoryResult.status !== "ok" || repositoryResult.result.isError) {
      return repositoryResult;
    }
    branch = readDefaultBranch(repositoryResult.result, plan.owner, plan.repo);
    if (!branch) {
      return {
        status: "ok",
        result: {
          isError: true,
          content: [
            {
              type: "text",
              text: `Could not resolve the default branch for ${plan.owner}/${plan.repo}.`,
            },
          ],
        },
      };
    }
  }
  return call({
    name: "github_create_or_update_file",
    arguments: {
      owner: plan.owner,
      repo: plan.repo,
      path: plan.path,
      content: plan.content,
      message: plan.message,
      branch,
      ...(plan.sha ? { sha: plan.sha } : {}),
    },
  });
}

function issueReadPlan(
  burbleToolName: string,
  args: Record<string, unknown>,
): McpGwGitHubToolPlan {
  const repository = parseRepository(requiredString(args, "repo"));
  return direct(burbleToolName, "github_issue_read", {
    method: "get",
    ...repository,
    issue_number: requiredNumber(args, "number"),
  });
}

function direct(
  burbleToolName: string,
  name: string,
  args: Record<string, unknown>,
): McpGwGitHubToolPlan {
  return {
    ok: true,
    kind: "call",
    burbleToolName,
    call: { name, arguments: args },
  };
}

function unsupported(burbleToolName: string): McpGwGitHubAdaptation {
  return {
    ok: false,
    burbleToolName,
    message: `GitHub tool ${burbleToolName} is not adapted for MCP-GW.`,
  };
}

function parseRepository(value: string): { owner: string; repo: string } {
  const normalized = value
    .trim()
    .replace(/^https:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");
  const parts = normalized.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("GitHub repository must be in owner/name format.");
  }
  return { owner: parts[0], repo: parts[1] };
}

function requiredString(
  args: Record<string, unknown>,
  key: string,
  allowEmpty = false,
): string {
  const value = args[key];
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    throw new Error(`GitHub tool input requires ${key}.`);
  }
  return allowEmpty ? value : value.trim();
}

function optionalString(
  args: Record<string, unknown>,
  key: string,
): string | null {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requiredNumber(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`GitHub tool input requires ${key}.`);
  }
  return value;
}

function requiredStringArray(
  args: Record<string, unknown>,
  key: string,
): string[] {
  const values = optionalStringArray(args, key);
  if (values.length === 0) {
    throw new Error(`GitHub tool input requires ${key}.`);
  }
  return values;
}

function optionalStringArray(
  args: Record<string, unknown>,
  key: string,
): string[] {
  const value = args[key];
  return Array.isArray(value)
    ? value.filter(
        (item): item is string => typeof item === "string" && Boolean(item.trim()),
      )
    : [];
}

function optionalField(
  args: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  return args[key] === undefined ? {} : { [key]: args[key] };
}

function resultToolName(plan: McpGwGitHubToolPlan): string {
  if (plan.kind === "call") return plan.call.name;
  if (plan.kind === "labels") return "github_issue_write";
  return "github_create_or_update_file";
}

function compactGitHubSearchResult(
  plan: McpGwGitHubToolPlan,
  result: UpstreamMcpToolResult,
): typeof result {
  if (
    plan.kind !== "call" ||
    !isGitHubSearchToolName(plan.call.name)
  ) {
    return result;
  }

  return {
    ...result,
    content: (result.content ?? []).map((item) => compactSearchContentItem(item)),
  };
}

function isGitHubSearchToolName(name: string): boolean {
  return (
    name === "search_issues" ||
    name === "search_pull_requests" ||
    name === "github_search_issues" ||
    name === "github_search_pull_requests" ||
    name.endsWith("_github_search_issues") ||
    name.endsWith("_github_search_pull_requests")
  );
}

function compactSearchContentItem(item: unknown): unknown {
  if (!isRecord(item) || typeof item.text !== "string") return item;

  let parsed: unknown;
  try {
    parsed = JSON.parse(item.text) as unknown;
  } catch {
    return item;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.items)) return item;

  return {
    ...item,
    text: JSON.stringify({
      ...(typeof parsed.total_count === "number"
        ? { total_count: parsed.total_count }
        : {}),
      ...(typeof parsed.incomplete_results === "boolean"
        ? { incomplete_results: parsed.incomplete_results }
        : {}),
      items: parsed.items.flatMap((candidate) => {
        const compacted = compactSearchItem(candidate);
        return compacted ? [compacted] : [];
      }),
    }),
  };
}

function compactSearchItem(
  candidate: unknown,
): Record<string, unknown> | null {
  if (!isRecord(candidate)) return null;

  const repository = readSearchRepository(candidate);
  const number = candidate.number;
  const title = candidate.title;
  const state = candidate.state;
  const htmlUrl = candidate.html_url;
  if (
    typeof number !== "number" ||
    !Number.isFinite(number) ||
    typeof title !== "string" ||
    typeof state !== "string" ||
    typeof htmlUrl !== "string" ||
    !repository
  ) {
    return null;
  }

  return {
    number,
    state,
    title,
    html_url: htmlUrl,
    repository,
    ...booleanField(candidate, "draft"),
    ...stringField(candidate, "created_at"),
    ...stringField(candidate, "updated_at"),
    ...(candidate.closed_at === null
      ? { closed_at: null }
      : stringField(candidate, "closed_at")),
    ...numberField(candidate, "comments"),
    ...(isRecord(candidate.user) && typeof candidate.user.login === "string"
      ? { author: candidate.user.login }
      : {}),
    labels: readSearchLabels(candidate.labels),
  };
}

function readSearchRepository(candidate: Record<string, unknown>): string | null {
  if (typeof candidate.repository_url === "string") {
    const match = candidate.repository_url.match(
      /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/?$/i,
    );
    if (match) return `${match[1]}/${match[2]}`;
  }
  if (typeof candidate.html_url === "string") {
    const match = candidate.html_url.match(
      /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/\d+\/?$/i,
    );
    if (match) return `${match[1]}/${match[2]}`;
  }
  return null;
}

function readSearchLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((label) => {
    if (typeof label === "string" && label.trim()) return [label.trim()];
    if (isRecord(label) && typeof label.name === "string" && label.name.trim()) {
      return [label.name.trim()];
    }
    return [];
  });
}

function stringField(
  value: Record<string, unknown>,
  key: string,
): Record<string, string> {
  return typeof value[key] === "string" ? { [key]: value[key] } : {};
}

function numberField(
  value: Record<string, unknown>,
  key: string,
): Record<string, number> {
  return typeof value[key] === "number" && Number.isFinite(value[key])
    ? { [key]: value[key] }
    : {};
}

function booleanField(
  value: Record<string, unknown>,
  key: string,
): Record<string, boolean> {
  return typeof value[key] === "boolean" ? { [key]: value[key] } : {};
}

function readMcpToolResultText(result: { content?: unknown[] }): string {
  for (const item of result.content ?? []) {
    if (isRecord(item) && typeof item.text === "string" && item.text.trim()) {
      return item.text.trim();
    }
  }
  return "";
}

function readMcpToolResultJson(
  result: { content?: unknown[] },
): Record<string, unknown> | null {
  const text = readMcpToolResultText(result);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readIssueLabels(result: { content?: unknown[] }): string[] {
  const parsed = readMcpToolResultJson(result);
  if (!parsed || !Array.isArray(parsed.labels)) return [];
  return parsed.labels.flatMap((label) => {
    if (typeof label === "string" && label.trim()) return [label.trim()];
    if (isRecord(label) && typeof label.name === "string" && label.name.trim()) {
      return [label.name.trim()];
    }
    return [];
  });
}

function readDefaultBranch(
  result: { content?: unknown[] },
  owner: string,
  repo: string,
): string | null {
  const parsed = readMcpToolResultJson(result);
  if (!parsed || !Array.isArray(parsed.items)) return null;
  const fullName = `${owner}/${repo}`.toLowerCase();
  for (const item of parsed.items) {
    if (!isRecord(item)) continue;
    const candidateName =
      typeof item.full_name === "string" ? item.full_name.toLowerCase() : null;
    if (candidateName && candidateName !== fullName) continue;
    if (typeof item.default_branch === "string" && item.default_branch.trim()) {
      return item.default_branch.trim();
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
