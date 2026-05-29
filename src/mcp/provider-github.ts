import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentRuntimeRecord, ProviderConnection, TokenStore } from "../db";
import { githubProviderToolSpecs } from "../providers/github/tool-specs";
import { providerToolInputSchema } from "../providers/tool-specs";
import {
  createGitHubTools,
  type GitHubPullRequestListInput
} from "../tools/github";
import type { ToolResult } from "../tools/types";
import { mcpToolResult, type ProviderMcpDeps, withConnection } from "./provider-context";
import {
  isProviderMcpToolEnabled,
  type ProviderMcpToolPolicy
} from "./provider-policy";

type GitHubTools = ReturnType<typeof createGitHubTools>;
type GitHubToolArgs = Record<string, unknown>;
type GitHubMcpHandler = (
  connection: ProviderConnection,
  args: GitHubToolArgs
) => Promise<ToolResult<unknown>>;

export function registerGitHubMcpTools(input: {
  server: McpServer;
  store: TokenStore;
  runtime: AgentRuntimeRecord;
  deps: Parameters<typeof createGitHubTools>[0] & ProviderMcpDeps;
  policy?: ProviderMcpToolPolicy;
}): void {
  const githubTools = createGitHubTools(input.deps);
  const handlers = createGitHubMcpHandlers(githubTools);

  for (const spec of githubProviderToolSpecs) {
    if (!isProviderMcpToolEnabled(input.policy, spec.name)) {
      continue;
    }
    const handler = handlers[spec.implementation];
    if (!handler) {
      throw new Error(`Missing GitHub MCP handler for ${spec.implementation}`);
    }

    input.server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: providerToolInputSchema(spec)
      },
      async (args) =>
        mcpToolResult(
          await withConnection(input.store, input.runtime, "github", (connection) =>
            handler(connection, args as GitHubToolArgs)
          )
        )
    );
  }
}

function createGitHubMcpHandlers(
  githubTools: GitHubTools
): Record<string, GitHubMcpHandler> {
  return {
    getAuthenticatedUser: (connection) =>
      githubTools.getAuthenticatedUser.execute({ connection }),

    listAssignedIssues: (connection) =>
      githubTools.listAssignedIssues.execute({ connection }),

    searchIssues: (connection, args) =>
      githubTools.searchIssues.execute({
        connection,
        input: { query: stringArg(args, "query") }
      }),

    listMyPullRequests: (connection, args) =>
      githubTools.listMyPullRequests.execute({
        connection,
        input: {
          ...optionalNumberField(args, "limit"),
          ...optionalStringField<NonNullable<GitHubPullRequestListInput["state"]>>(
            args,
            "state"
          ),
          ...optionalStringField<NonNullable<GitHubPullRequestListInput["sort"]>>(
            args,
            "sort"
          ),
          ...optionalStringField<NonNullable<GitHubPullRequestListInput["order"]>>(
            args,
            "order"
          ),
          ...optionalStringField(args, "owner"),
          ...optionalStringField(args, "repo")
        }
      }),

    createIssue: (connection, args) =>
      githubTools.createIssue.execute({
        connection,
        input: {
          repo: stringArg(args, "repo"),
          title: stringArg(args, "title"),
          ...optionalStringField(args, "body"),
          ...optionalStringArrayField(args, "labels"),
          ...optionalStringArrayField(args, "assignees")
        }
      }),

    getIssue: (connection, args) =>
      githubTools.getIssue.execute({
        connection,
        input: {
          repo: stringArg(args, "repo"),
          number: numberArg(args, "number")
        }
      }),

    getPullRequest: (connection, args) =>
      githubTools.getPullRequest.execute({
        connection,
        input: {
          repo: stringArg(args, "repo"),
          number: numberArg(args, "number")
        }
      }),

    commentOnIssueOrPullRequest: (connection, args) =>
      githubTools.commentOnIssueOrPullRequest.execute({
        connection,
        input: {
          repo: stringArg(args, "repo"),
          number: numberArg(args, "number"),
          body: stringArg(args, "body")
        }
      }),

    updateIssue: (connection, args) =>
      githubTools.updateIssue.execute({
        connection,
        input: {
          repo: stringArg(args, "repo"),
          number: numberArg(args, "number"),
          ...optionalStringField(args, "title"),
          ...optionalStringField(args, "body"),
          ...optionalStringField<"open" | "closed">(args, "state"),
          ...optionalStringArrayField(args, "labels"),
          ...optionalStringArrayField(args, "assignees")
        }
      }),

    closeIssue: (connection, args) =>
      githubTools.closeIssue.execute({
        connection,
        input: {
          repo: stringArg(args, "repo"),
          number: numberArg(args, "number")
        }
      }),

    reopenIssue: (connection, args) =>
      githubTools.reopenIssue.execute({
        connection,
        input: {
          repo: stringArg(args, "repo"),
          number: numberArg(args, "number")
        }
      }),

    createPullRequest: (connection, args) =>
      githubTools.createPullRequest.execute({
        connection,
        input: {
          repo: stringArg(args, "repo"),
          title: stringArg(args, "title"),
          head: stringArg(args, "head"),
          base: stringArg(args, "base"),
          ...optionalStringField(args, "body"),
          ...optionalBooleanField(args, "draft")
        }
      }),

    updatePullRequest: (connection, args) =>
      githubTools.updatePullRequest.execute({
        connection,
        input: {
          repo: stringArg(args, "repo"),
          number: numberArg(args, "number"),
          ...optionalStringField(args, "title"),
          ...optionalStringField(args, "body"),
          ...optionalStringField(args, "base"),
          ...optionalBooleanField(args, "draft")
        }
      }),

    addLabels: (connection, args) =>
      githubTools.addLabels.execute({
        connection,
        input: {
          repo: stringArg(args, "repo"),
          number: numberArg(args, "number"),
          labels: stringArrayArg(args, "labels")
        }
      }),

    removeLabels: (connection, args) =>
      githubTools.removeLabels.execute({
        connection,
        input: {
          repo: stringArg(args, "repo"),
          number: numberArg(args, "number"),
          labels: stringArrayArg(args, "labels")
        }
      }),

    requestReview: (connection, args) =>
      githubTools.requestReview.execute({
        connection,
        input: {
          repo: stringArg(args, "repo"),
          number: numberArg(args, "number"),
          ...optionalStringArrayField(args, "reviewers"),
          ...optionalStringArrayField(args, "teamReviewers")
        }
      }),

    getFile: (connection, args) =>
      githubTools.getFile.execute({
        connection,
        input: {
          repo: stringArg(args, "repo"),
          path: stringArg(args, "path"),
          ...optionalStringField(args, "ref")
        }
      }),

    createOrUpdateFile: (connection, args) =>
      githubTools.createOrUpdateFile.execute({
        connection,
        input: {
          repo: stringArg(args, "repo"),
          path: stringArg(args, "path"),
          content: stringArg(args, "content"),
          message: stringArg(args, "message"),
          ...optionalStringField(args, "branch"),
          ...optionalStringField(args, "sha")
        }
      }),

    createBranch: (connection, args) =>
      githubTools.createBranch.execute({
        connection,
        input: {
          repo: stringArg(args, "repo"),
          branch: stringArg(args, "branch"),
          ...optionalStringField(args, "fromRef")
        }
      })
  };
}

function stringArg(args: GitHubToolArgs, key: string): string {
  return args[key] as string;
}

function numberArg(args: GitHubToolArgs, key: string): number {
  return args[key] as number;
}

function stringArrayArg(args: GitHubToolArgs, key: string): string[] {
  return args[key] as string[];
}

function optionalStringField<T extends string = string>(
  args: GitHubToolArgs,
  key: string
): Partial<Record<string, T>> {
  return args[key] !== undefined ? { [key]: args[key] as T } : {};
}

function optionalNumberField(
  args: GitHubToolArgs,
  key: string
): Partial<Record<string, number>> {
  return args[key] !== undefined ? { [key]: args[key] as number } : {};
}

function optionalBooleanField(
  args: GitHubToolArgs,
  key: string
): Partial<Record<string, boolean>> {
  return args[key] !== undefined ? { [key]: args[key] as boolean } : {};
}

function optionalStringArrayField(
  args: GitHubToolArgs,
  key: string
): Partial<Record<string, string[]>> {
  return args[key] !== undefined ? { [key]: args[key] as string[] } : {};
}
