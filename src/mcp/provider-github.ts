import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { AgentRuntimeRecord, TokenStore } from "../db";
import type { GitHubToolDeps } from "../tools/github";
import { createGitHubTools } from "../tools/github";
import { mcpToolResult, type ProviderMcpDeps, withConnection } from "./provider-context";

export function registerGitHubMcpTools(input: {
  server: McpServer;
  store: TokenStore;
  runtime: AgentRuntimeRecord;
  deps: GitHubToolDeps & ProviderMcpDeps;
}): void {
  const githubTools = createGitHubTools(input.deps);

  input.server.registerTool(
    "github_get_authenticated_user",
    {
      title: "GitHub authenticated user",
      description: "Return the GitHub identity connected to this Slack user.",
      inputSchema: {}
    },
    async () =>
      mcpToolResult(
        await withConnection(input.store, input.runtime, "github", (connection) =>
          githubTools.getAuthenticatedUser.execute({ connection })
        )
      )
  );

  input.server.registerTool(
    "github_list_assigned_issues",
    {
      title: "GitHub assigned issues",
      description: "List GitHub issues assigned to this Slack user.",
      inputSchema: {}
    },
    async () =>
      mcpToolResult(
        await withConnection(input.store, input.runtime, "github", (connection) =>
          githubTools.listAssignedIssues.execute({ connection })
        )
      )
  );

  input.server.registerTool(
    "github_search_issues",
    {
      title: "GitHub issue search",
      description:
        "Search GitHub issues and pull requests visible to this Slack user's connected GitHub account.",
      inputSchema: {
        query: z.string().min(1).describe("GitHub search query")
      }
    },
    async ({ query }) =>
      mcpToolResult(
        await withConnection(input.store, input.runtime, "github", (connection) =>
          githubTools.searchIssues.execute({
            connection,
            input: { query }
          })
        )
      )
  );

  input.server.registerTool(
    "github_list_my_pull_requests",
    {
      title: "GitHub pull requests authored by me",
      description:
        "List GitHub pull requests authored by this Slack user's connected GitHub account. Defaults to open PRs sorted by most recently updated.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Maximum number of pull requests to return. Defaults to 10."),
        state: z
          .enum(["open", "closed", "all"])
          .optional()
          .describe("Pull request state to include. Defaults to open."),
        sort: z
          .enum(["updated", "created", "comments"])
          .optional()
          .describe("Sort field. Defaults to updated."),
        order: z
          .enum(["desc", "asc"])
          .optional()
          .describe("Sort order. Defaults to desc."),
        owner: z
          .string()
          .min(1)
          .optional()
          .describe("Optional GitHub owner or organization login, for example apelogic-ai."),
        repo: z
          .string()
          .min(1)
          .optional()
          .describe("Optional repository in owner/name format. Takes precedence over owner.")
      }
    },
    async ({ limit, state, sort, order, owner, repo }) =>
      mcpToolResult(
        await withConnection(input.store, input.runtime, "github", (connection) =>
          githubTools.listMyPullRequests.execute({
            connection,
            input: {
              ...(limit !== undefined ? { limit } : {}),
              ...(state ? { state } : {}),
              ...(sort ? { sort } : {}),
              ...(order ? { order } : {}),
              ...(owner ? { owner } : {}),
              ...(repo ? { repo } : {})
            }
          })
        )
      )
  );

  input.server.registerTool(
    "github_create_issue",
    {
      title: "GitHub create issue",
      description:
        "Create a GitHub issue visible to this Slack user's connected GitHub account.",
      inputSchema: {
        repo: z.string().min(1).describe("Repository in owner/name format"),
        title: z.string().min(1).max(256).describe("Issue title"),
        body: z.string().max(65_536).optional().describe("Issue body"),
        labels: z.array(z.string().min(1)).max(20).optional(),
        assignees: z.array(z.string().min(1)).max(20).optional()
      }
    },
    async ({ repo, title, body, labels, assignees }) =>
      mcpToolResult(
        await withConnection(input.store, input.runtime, "github", (connection) =>
          githubTools.createIssue.execute({
            connection,
            input: {
              repo,
              title,
              ...(body !== undefined ? { body } : {}),
              ...(labels ? { labels } : {}),
              ...(assignees ? { assignees } : {})
            }
          })
        )
      )
  );

  input.server.registerTool(
    "github_get_issue",
    {
      title: "GitHub get issue",
      description:
        "Get a GitHub issue by repository and issue number. Use before editing issue metadata.",
      inputSchema: {
        repo: z.string().min(1).describe("Repository in owner/name format"),
        number: z.number().int().positive().describe("Issue number")
      }
    },
    async ({ repo, number }) =>
      mcpToolResult(
        await withConnection(input.store, input.runtime, "github", (connection) =>
          githubTools.getIssue.execute({
            connection,
            input: { repo, number }
          })
        )
      )
  );

  input.server.registerTool(
    "github_get_pr",
    {
      title: "GitHub get pull request",
      description:
        "Get a GitHub pull request by repository and PR number. Use before editing PR metadata.",
      inputSchema: {
        repo: z.string().min(1).describe("Repository in owner/name format"),
        number: z.number().int().positive().describe("Pull request number")
      }
    },
    async ({ repo, number }) =>
      mcpToolResult(
        await withConnection(input.store, input.runtime, "github", (connection) =>
          githubTools.getPullRequest.execute({
            connection,
            input: { repo, number }
          })
        )
      )
  );

  input.server.registerTool(
    "github_comment_on_issue_or_pr",
    {
      title: "GitHub comment on issue or pull request",
      description:
        "Add a comment to a GitHub issue or pull request using this Slack user's connected GitHub account.",
      inputSchema: {
        repo: z.string().min(1).describe("Repository in owner/name format"),
        number: z.number().int().positive().describe("Issue or pull request number"),
        body: z.string().min(1).max(65_536).describe("Comment body")
      }
    },
    async ({ repo, number, body }) =>
      mcpToolResult(
        await withConnection(input.store, input.runtime, "github", (connection) =>
          githubTools.commentOnIssueOrPullRequest.execute({
            connection,
            input: { repo, number, body }
          })
        )
      )
  );

  input.server.registerTool(
    "github_update_issue",
    {
      title: "GitHub update issue",
      description:
        "Update GitHub issue metadata only: title, body, state, labels, or assignees.",
      inputSchema: {
        repo: z.string().min(1).describe("Repository in owner/name format"),
        number: z.number().int().positive().describe("Issue number"),
        title: z.string().min(1).max(256).optional(),
        body: z.string().max(65_536).optional(),
        state: z.enum(["open", "closed"]).optional(),
        labels: z.array(z.string().min(1)).max(20).optional(),
        assignees: z.array(z.string().min(1)).max(20).optional()
      }
    },
    async ({ repo, number, title, body, state, labels, assignees }) =>
      mcpToolResult(
        await withConnection(input.store, input.runtime, "github", (connection) =>
          githubTools.updateIssue.execute({
            connection,
            input: {
              repo,
              number,
              ...(title !== undefined ? { title } : {}),
              ...(body !== undefined ? { body } : {}),
              ...(state !== undefined ? { state } : {}),
              ...(labels !== undefined ? { labels } : {}),
              ...(assignees !== undefined ? { assignees } : {})
            }
          })
        )
      )
  );

  input.server.registerTool(
    "github_close_issue",
    {
      title: "GitHub close issue",
      description: "Close a GitHub issue. Use only when explicitly requested.",
      inputSchema: {
        repo: z.string().min(1).describe("Repository in owner/name format"),
        number: z.number().int().positive().describe("Issue number")
      }
    },
    async ({ repo, number }) =>
      mcpToolResult(
        await withConnection(input.store, input.runtime, "github", (connection) =>
          githubTools.closeIssue.execute({
            connection,
            input: { repo, number }
          })
        )
      )
  );

  input.server.registerTool(
    "github_reopen_issue",
    {
      title: "GitHub reopen issue",
      description: "Reopen a GitHub issue. Use only when explicitly requested.",
      inputSchema: {
        repo: z.string().min(1).describe("Repository in owner/name format"),
        number: z.number().int().positive().describe("Issue number")
      }
    },
    async ({ repo, number }) =>
      mcpToolResult(
        await withConnection(input.store, input.runtime, "github", (connection) =>
          githubTools.reopenIssue.execute({
            connection,
            input: { repo, number }
          })
        )
      )
  );

  input.server.registerTool(
    "github_create_pr",
    {
      title: "GitHub create pull request",
      description:
        "Open a pull request from an existing branch using this Slack user's connected GitHub account.",
      inputSchema: {
        repo: z.string().min(1).describe("Repository in owner/name format"),
        title: z.string().min(1).max(256).describe("Pull request title"),
        head: z.string().min(1).describe("Head branch or owner:branch"),
        base: z.string().min(1).describe("Base branch"),
        body: z.string().max(65_536).optional().describe("Pull request body"),
        draft: z.boolean().optional().describe("Whether to create a draft PR")
      }
    },
    async ({ repo, title, head, base, body, draft }) =>
      mcpToolResult(
        await withConnection(input.store, input.runtime, "github", (connection) =>
          githubTools.createPullRequest.execute({
            connection,
            input: {
              repo,
              title,
              head,
              base,
              ...(body !== undefined ? { body } : {}),
              ...(draft !== undefined ? { draft } : {})
            }
          })
        )
      )
  );

  input.server.registerTool(
    "github_update_pr",
    {
      title: "GitHub update pull request",
      description:
        "Update pull request metadata only: title, body, base branch, or draft state.",
      inputSchema: {
        repo: z.string().min(1).describe("Repository in owner/name format"),
        number: z.number().int().positive().describe("Pull request number"),
        title: z.string().min(1).max(256).optional(),
        body: z.string().max(65_536).optional(),
        base: z.string().min(1).optional(),
        draft: z.boolean().optional()
      }
    },
    async ({ repo, number, title, body, base, draft }) =>
      mcpToolResult(
        await withConnection(input.store, input.runtime, "github", (connection) =>
          githubTools.updatePullRequest.execute({
            connection,
            input: {
              repo,
              number,
              ...(title !== undefined ? { title } : {}),
              ...(body !== undefined ? { body } : {}),
              ...(base !== undefined ? { base } : {}),
              ...(draft !== undefined ? { draft } : {})
            }
          })
        )
      )
  );

  input.server.registerTool(
    "github_add_labels",
    {
      title: "GitHub add labels",
      description: "Add labels to a GitHub issue or pull request.",
      inputSchema: {
        repo: z.string().min(1).describe("Repository in owner/name format"),
        number: z.number().int().positive().describe("Issue or pull request number"),
        labels: z.array(z.string().min(1)).min(1).max(20)
      }
    },
    async ({ repo, number, labels }) =>
      mcpToolResult(
        await withConnection(input.store, input.runtime, "github", (connection) =>
          githubTools.addLabels.execute({
            connection,
            input: { repo, number, labels }
          })
        )
      )
  );

  input.server.registerTool(
    "github_remove_labels",
    {
      title: "GitHub remove labels",
      description: "Remove labels from a GitHub issue or pull request.",
      inputSchema: {
        repo: z.string().min(1).describe("Repository in owner/name format"),
        number: z.number().int().positive().describe("Issue or pull request number"),
        labels: z.array(z.string().min(1)).min(1).max(20)
      }
    },
    async ({ repo, number, labels }) =>
      mcpToolResult(
        await withConnection(input.store, input.runtime, "github", (connection) =>
          githubTools.removeLabels.execute({
            connection,
            input: { repo, number, labels }
          })
        )
      )
  );

  input.server.registerTool(
    "github_request_review",
    {
      title: "GitHub request pull request review",
      description: "Request users or teams to review a GitHub pull request.",
      inputSchema: {
        repo: z.string().min(1).describe("Repository in owner/name format"),
        number: z.number().int().positive().describe("Pull request number"),
        reviewers: z.array(z.string().min(1)).max(20).optional(),
        teamReviewers: z.array(z.string().min(1)).max(20).optional()
      }
    },
    async ({ repo, number, reviewers, teamReviewers }) =>
      mcpToolResult(
        await withConnection(input.store, input.runtime, "github", (connection) =>
          githubTools.requestReview.execute({
            connection,
            input: {
              repo,
              number,
              ...(reviewers ? { reviewers } : {}),
              ...(teamReviewers ? { teamReviewers } : {})
            }
          })
        )
      )
  );

  input.server.registerTool(
    "github_get_file",
    {
      title: "GitHub get file",
      description:
        "Read a text file from a GitHub repository. Use before updating an existing file.",
      inputSchema: {
        repo: z.string().min(1).describe("Repository in owner/name format"),
        path: z.string().min(1).describe("Repository file path"),
        ref: z.string().min(1).optional().describe("Optional branch, tag, or commit SHA")
      }
    },
    async ({ repo, path, ref }) =>
      mcpToolResult(
        await withConnection(input.store, input.runtime, "github", (connection) =>
          githubTools.getFile.execute({
            connection,
            input: {
              repo,
              path,
              ...(ref ? { ref } : {})
            }
          })
        )
      )
  );

  input.server.registerTool(
    "github_create_or_update_file",
    {
      title: "GitHub create or update file",
      description:
        "Create or update a single GitHub repository file. For updates, pass the file SHA from github_get_file.",
      inputSchema: {
        repo: z.string().min(1).describe("Repository in owner/name format"),
        path: z.string().min(1).describe("Repository file path"),
        content: z.string().max(1_000_000).describe("New full file content"),
        message: z.string().min(1).max(256).describe("Commit message"),
        branch: z.string().min(1).optional().describe("Optional target branch"),
        sha: z.string().min(1).optional().describe("Current file SHA when updating")
      }
    },
    async ({ repo, path, content, message, branch, sha }) =>
      mcpToolResult(
        await withConnection(input.store, input.runtime, "github", (connection) =>
          githubTools.createOrUpdateFile.execute({
            connection,
            input: {
              repo,
              path,
              content,
              message,
              ...(branch ? { branch } : {}),
              ...(sha ? { sha } : {})
            }
          })
        )
      )
  );

  input.server.registerTool(
    "github_create_branch",
    {
      title: "GitHub create branch",
      description:
        "Create a GitHub branch from another branch or the repository default branch.",
      inputSchema: {
        repo: z.string().min(1).describe("Repository in owner/name format"),
        branch: z.string().min(1).describe("New branch name"),
        fromRef: z
          .string()
          .min(1)
          .optional()
          .describe("Optional source branch. Defaults to repository default branch.")
      }
    },
    async ({ repo, branch, fromRef }) =>
      mcpToolResult(
        await withConnection(input.store, input.runtime, "github", (connection) =>
          githubTools.createBranch.execute({
            connection,
            input: {
              repo,
              branch,
              ...(fromRef ? { fromRef } : {})
            }
          })
        )
      )
  );
}
