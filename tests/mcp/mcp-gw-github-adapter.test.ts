import { describe, expect, test } from "bun:test";
import {
  adaptMcpGwGitHubToolCall,
  executeMcpGwGitHubToolPlan,
  mcpGwGitHubToolResult,
} from "../../src/mcp/mcp-gw-github-adapter";

describe("MCP-GW GitHub adapter", () => {
  test("maps existing read contracts to official federated GitHub tools", () => {
    expect(adaptMcpGwGitHubToolCall("github_get_authenticated_user", {})).toEqual({
      ok: true,
      kind: "call",
      burbleToolName: "github_get_authenticated_user",
      call: { name: "github_get_me", arguments: {} },
    });
    expect(adaptMcpGwGitHubToolCall("github_list_assigned_issues", {})).toEqual({
      ok: true,
      kind: "call",
      burbleToolName: "github_list_assigned_issues",
      call: {
        name: "github_search_issues",
        arguments: { query: "assignee:@me is:open" },
      },
    });
    expect(
      adaptMcpGwGitHubToolCall("github_search_issues", {
        query: "org:apelogic-ai is:pr is:open",
      }),
    ).toEqual({
      ok: true,
      kind: "call",
      burbleToolName: "github_search_issues",
      call: {
        name: "github_search_pull_requests",
        arguments: { query: "org:apelogic-ai is:pr is:open" },
      },
    });
    expect(
      adaptMcpGwGitHubToolCall("github_list_my_pull_requests", {
        repo: "apelogic-ai/burble",
        state: "closed",
        sort: "created",
        order: "asc",
        limit: 5,
      }),
    ).toEqual({
      ok: true,
      kind: "call",
      burbleToolName: "github_list_my_pull_requests",
      call: {
        name: "github_search_pull_requests",
        arguments: {
          query: "author:@me is:closed",
          owner: "apelogic-ai",
          repo: "burble",
          sort: "created",
          order: "asc",
          perPage: 5,
        },
      },
    });
    expect(
      adaptMcpGwGitHubToolCall("github_get_issue", {
        repo: "apelogic-ai/burble",
        number: 12,
      }),
    ).toMatchObject({
      call: {
        name: "github_issue_read",
        arguments: {
          method: "get",
          owner: "apelogic-ai",
          repo: "burble",
          issue_number: 12,
        },
      },
    });
    expect(
      adaptMcpGwGitHubToolCall("github_get_pr", {
        repo: "apelogic-ai/burble",
        number: 96,
      }),
    ).toMatchObject({
      call: {
        name: "github_pull_request_read",
        arguments: {
          method: "get",
          owner: "apelogic-ai",
          repo: "burble",
          pullNumber: 96,
        },
      },
    });
    expect(
      adaptMcpGwGitHubToolCall("github_get_file", {
        repo: "apelogic-ai/burble",
        path: "README.md",
        ref: "main",
      }),
    ).toMatchObject({
      call: {
        name: "github_get_file_contents",
        arguments: {
          owner: "apelogic-ai",
          repo: "burble",
          path: "README.md",
          ref: "main",
        },
      },
    });
  });

  test("maps existing write contracts without forwarding Burble-only fields", () => {
    expect(
      adaptMcpGwGitHubToolCall("github_create_issue", {
        repo: "apelogic-ai/burble",
        title: "Issue",
        body: "Body",
        labels: ["bug"],
      }),
    ).toMatchObject({
      call: {
        name: "github_issue_write",
        arguments: {
          method: "create",
          owner: "apelogic-ai",
          repo: "burble",
          title: "Issue",
          body: "Body",
          labels: ["bug"],
        },
      },
    });
    expect(
      adaptMcpGwGitHubToolCall("github_close_issue", {
        repo: "apelogic-ai/burble",
        number: 9,
      }),
    ).toMatchObject({
      call: {
        name: "github_issue_write",
        arguments: {
          method: "update",
          owner: "apelogic-ai",
          repo: "burble",
          issue_number: 9,
          state: "closed",
        },
      },
    });
    expect(
      adaptMcpGwGitHubToolCall("github_create_pr", {
        repo: "apelogic-ai/burble",
        title: "PR",
        head: "feature",
        base: "main",
        draft: true,
      }),
    ).toMatchObject({
      call: {
        name: "github_create_pull_request",
        arguments: {
          owner: "apelogic-ai",
          repo: "burble",
          title: "PR",
          head: "feature",
          base: "main",
          draft: true,
        },
      },
    });
    expect(
      adaptMcpGwGitHubToolCall("github_request_review", {
        repo: "apelogic-ai/burble",
        number: 96,
        reviewers: ["octocat"],
        teamReviewers: ["platform"],
      }),
    ).toMatchObject({
      call: {
        name: "github_update_pull_request",
        arguments: {
          owner: "apelogic-ai",
          repo: "burble",
          pullNumber: 96,
          reviewers: ["octocat", "apelogic-ai/platform"],
        },
      },
    });
    expect(
      adaptMcpGwGitHubToolCall("github_create_branch", {
        repo: "apelogic-ai/burble",
        branch: "feature",
        fromRef: "main",
      }),
    ).toMatchObject({
      call: {
        name: "github_create_branch",
        arguments: {
          owner: "apelogic-ai",
          repo: "burble",
          branch: "feature",
          from_branch: "main",
        },
      },
    });
  });

  test("builds semantic plans for incremental labels and default-branch file writes", () => {
    expect(
      adaptMcpGwGitHubToolCall("github_add_labels", {
        repo: "apelogic-ai/burble",
        number: 4,
        labels: ["bug"],
      }),
    ).toEqual({
      ok: true,
      kind: "labels",
      burbleToolName: "github_add_labels",
      owner: "apelogic-ai",
      repo: "burble",
      issueNumber: 4,
      labels: ["bug"],
      operation: "add",
    });
    expect(
      adaptMcpGwGitHubToolCall("github_create_or_update_file", {
        repo: "apelogic-ai/burble",
        path: "README.md",
        content: "hello",
        message: "Update README",
      }),
    ).toMatchObject({
      ok: true,
      kind: "file_write",
      owner: "apelogic-ai",
      repo: "burble",
      branch: null,
    });
  });

  test("preserves incremental label semantics with read-before-write", async () => {
    const plan = adaptMcpGwGitHubToolCall("github_add_labels", {
      repo: "apelogic-ai/burble",
      number: 4,
      labels: ["priority"],
    });
    if (!plan.ok) throw new Error("expected adapted plan");
    const calls: unknown[] = [];

    await executeMcpGwGitHubToolPlan(plan, async (call) => {
      calls.push(call);
      if (calls.length === 1) {
        return {
          status: "ok",
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({ labels: [{ name: "bug" }, "triage"] }),
              },
            ],
          },
        };
      }
      return { status: "ok", result: { content: [] } };
    });

    expect(calls).toEqual([
      {
        name: "github_issue_read",
        arguments: {
          method: "get",
          owner: "apelogic-ai",
          repo: "burble",
          issue_number: 4,
        },
      },
      {
        name: "github_issue_write",
        arguments: {
          method: "update",
          owner: "apelogic-ai",
          repo: "burble",
          issue_number: 4,
          labels: ["bug", "triage", "priority"],
        },
      },
    ]);
  });

  test("resolves the default branch before a branchless file write", async () => {
    const plan = adaptMcpGwGitHubToolCall("github_create_or_update_file", {
      repo: "apelogic-ai/burble",
      path: "README.md",
      content: "hello",
      message: "Update README",
    });
    if (!plan.ok) throw new Error("expected adapted plan");
    const calls: unknown[] = [];

    await executeMcpGwGitHubToolPlan(plan, async (call) => {
      calls.push(call);
      if (calls.length === 1) {
        return {
          status: "ok",
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  items: [{ full_name: "apelogic-ai/burble", default_branch: "trunk" }],
                }),
              },
            ],
          },
        };
      }
      return { status: "ok", result: { content: [] } };
    });

    expect(calls).toEqual([
      {
        name: "github_search_repositories",
        arguments: { query: "repo:apelogic-ai/burble", perPage: 1 },
      },
      {
        name: "github_create_or_update_file",
        arguments: {
          owner: "apelogic-ai",
          repo: "burble",
          path: "README.md",
          content: "hello",
          message: "Update README",
          branch: "trunk",
        },
      },
    ]);
  });

  test("rejects malformed repositories and unsupported tools", () => {
    expect(
      adaptMcpGwGitHubToolCall("github_get_issue", {
        repo: "missing-owner",
        number: 1,
      }),
    ).toMatchObject({ ok: false });
    expect(adaptMcpGwGitHubToolCall("github_unknown", {})).toMatchObject({
      ok: false,
      burbleToolName: "github_unknown",
    });
  });

  test("normalizes successful and reconnect results for Burble agents", () => {
    const plan = adaptMcpGwGitHubToolCall("github_get_authenticated_user", {});
    if (!plan.ok) throw new Error("expected adapted plan");

    expect(
      mcpGwGitHubToolResult(plan, {
        status: "ok",
        result: { content: [{ type: "text", text: '{"login":"octocat"}' }] },
      }),
    ).toMatchObject({
      classification: "user_private",
      content: {
        mcpGw: true,
        toolName: "github_get_me",
        burbleToolName: "github_get_authenticated_user",
      },
    });
    expect(
      mcpGwGitHubToolResult(plan, {
        status: "needs_connect",
        message: "GitHub connection required",
        provider: "github",
      }),
    ).toEqual({
      classification: "user_private",
      content: {
        error: "github_not_connected",
        message: "GitHub connection required Run `/auth github` to connect or reconnect GitHub.",
        authCommand: "/auth github",
      },
    });
  });
});
