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
  test("accepts planned MCP-GW provider tools for provider capabilities", () => {
    const validation = validateScheduledTask(
      scheduledJob(
        [
          "1. Find open pull requests in repositories under the apelogic-ai GitHub organization.",
          "2. Use the configured Google Drive document for deduplication so previously reported pull requests are not reported again, and record newly reported pull requests there.",
          "3. Report only net-new open pull requests.",
        ].join("\n"),
      ),
      {
        requiredTools: [
          "github_call_mcp_tool",
          "google_append_to_drive_text_file",
          "google_get_drive_file",
        ],
      },
    );

    expect(validation.expectedTools).toEqual([
      "github_search_issues",
      "google_search_drive_files",
    ]);
    expect(validation.grantedTools).toEqual([
      "github_call_mcp_tool",
      "google_append_to_drive_text_file",
      "google_get_drive_file",
    ]);
    expect(validation).toMatchObject({
      ok: true,
      errors: [],
      warnings: [],
    });
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
