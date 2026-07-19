import { describe, expect, test } from "bun:test";
import type { ScheduledJobRecord } from "../../src/db";
import { validateScheduledTask } from "../../src/scheduler/task-validation";

function scheduledJob(prompt: string): ScheduledJobRecord {
  return {
    jobId: "job-open-prs",
    workspaceId: "T123",
    slackUserId: "U123",
    title: "Check for new PRs in an organization",
    prompt,
    schedule: {
      kind: "cron",
      expression: "0 * * * *",
      timezone: "UTC",
    },
    routeId: "convrt_123",
    state: "scheduled",
    runtimeType: "burble-native",
    createdAt: "2026-07-18T19:59:13.635Z",
    updatedAt: "2026-07-18T19:59:13.635Z",
  };
}

describe("scheduled task validation", () => {
  test("uses resolved task operations instead of re-inferring discovery from prompt wording", () => {
    const validation = validateScheduledTask(
      scheduledJob(
        [
          "1. Find open pull requests in repositories under the apelogic-ai GitHub organization.",
          "2. Use the configured Google Drive document for deduplication so previously reported pull requests are not reported again, and record newly reported pull requests there.",
          "3. Report only net-new open pull requests.",
        ].join("\n"),
      ),
      {
        expectedTools: [
          "github_search_issues",
          "google_get_drive_file",
          "google_append_to_drive_text_file",
        ],
        requiredTools: [
          "github_call_mcp_tool",
          "google_append_to_drive_text_file",
          "google_get_drive_file",
        ],
        stateRefs: [
          {
            provider: "google",
            kind: "document",
            id: "dedupe-state",
          },
        ],
      },
    );

    expect(validation.expectedTools).toEqual([
      "github_search_issues",
      "google_append_to_drive_text_file",
      "google_get_drive_file",
    ]);
    expect(validation.grantedTools).toEqual([
      "github_call_mcp_tool",
      "google_append_to_drive_text_file",
      "google_get_drive_file",
    ]);
    expect(validation).toMatchObject({ ok: true, errors: [], warnings: [] });
  });

  test("rejects a resolved operation that is not included in the grant", () => {
    const validation = validateScheduledTask(
      scheduledJob("Process the configured external state."),
      {
        expectedTools: ["google_get_drive_file"],
        requiredTools: ["google_append_to_drive_text_file"],
        stateRefs: [
          {
            provider: "google",
            kind: "document",
            id: "dedupe-state",
          },
        ],
      },
    );

    expect(validation).toMatchObject({
      ok: false,
      errors: [
        {
          code: "missing_required_tool",
          tool: "google_get_drive_file",
        },
      ],
    });
  });

  test("rejects state-consuming operations without a bound provider reference", () => {
    const validation = validateScheduledTask(
      scheduledJob("Read and update the configured checkpoint."),
      {
        expectedTools: [
          "google_get_drive_file",
          "google_append_to_drive_text_file",
        ],
        requiredTools: [
          "google_get_drive_file",
          "google_append_to_drive_text_file",
        ],
        stateRefs: [],
      },
    );

    expect(validation).toMatchObject({
      ok: false,
      errors: [
        {
          code: "missing_state_ref",
          tool: "google_append_to_drive_text_file",
          stateInput: "fileId",
        },
      ],
    });
  });

  test("allows state-addressable reads when the task has no durable binding", () => {
    const validation = validateScheduledTask(
      scheduledJob("Read files discovered during this run."),
      {
        expectedTools: ["google_get_drive_file"],
        requiredTools: ["google_get_drive_file"],
        stateRefs: [],
      },
    );

    expect(validation).toMatchObject({ ok: true, errors: [] });
  });

  test("accepts state-consuming operations with a bound provider reference", () => {
    const validation = validateScheduledTask(
      scheduledJob("Read and update the configured checkpoint."),
      {
        expectedTools: [
          "google_get_drive_file",
          "google_append_to_drive_text_file",
        ],
        requiredTools: [
          "google_get_drive_file",
          "google_append_to_drive_text_file",
        ],
        stateRefs: [
          {
            provider: "google",
            kind: "document",
            id: "state-123",
          },
        ],
      },
    );

    expect(validation).toMatchObject({ ok: true, errors: [] });
  });

  test("accepts the generic MCP-GW GitHub tool as explicit GitHub coverage", () => {
    const validation = validateScheduledTask(
      scheduledJob(
        "Find open pull requests in repositories under the apelogic-ai GitHub organization.",
      ),
      {
        requiredTools: ["github_call_mcp_tool"],
      },
    );

    expect(validation).toMatchObject({
      ok: true,
      errors: [],
      warnings: [],
    });
  });

  test("uses catalog-declared provider dispatch coverage generically", () => {
    const validation = validateScheduledTask(
      scheduledJob("Inspect the connected provider's available operations."),
      {
        expectedTools: ["atlassian_list_mcp_tools"],
        requiredTools: ["atlassian_call_mcp_tool"],
      },
    );

    expect(validation).toMatchObject({
      ok: true,
      errors: [],
      warnings: [],
    });
  });

  test("does not let GitHub write grants cover organization PR search", () => {
    const createOnly = validateScheduledTask(
      scheduledJob(
        "Find open pull requests in repositories under the apelogic-ai GitHub organization.",
      ),
      {
        requiredTools: ["github_create_issue"],
      },
    );
    const mixedNarrowGrants = validateScheduledTask(
      scheduledJob(
        "Find open pull requests in repositories under the apelogic-ai GitHub organization.",
      ),
      {
        requiredTools: [
          "github_create_issue",
          "github_list_my_pull_requests",
        ],
      },
    );

    for (const validation of [createOnly, mixedNarrowGrants]) {
      expect(validation).toMatchObject({
        ok: false,
        errors: [
          {
            code: "missing_required_tool",
            tool: "github_search_issues",
          },
        ],
      });
    }
  });

  test("does not let a provider grant satisfy a non-provider capability", () => {
    const validation = validateScheduledTask(
      scheduledJob("Find the latest AI news on the web."),
      {
        requiredTools: ["github_call_mcp_tool"],
      },
    );

    expect(validation).toMatchObject({
      ok: false,
      errors: [
        {
          code: "missing_required_tool",
          tool: "web_search",
        },
      ],
    });
  });
});
