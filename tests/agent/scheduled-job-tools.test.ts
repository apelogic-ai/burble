import { describe, expect, test } from "bun:test";
import { isScheduledJobToolAllowed } from "../../src/agent/scheduled-job-tools";

describe("scheduled job tool grants", () => {
  test("dynamic MCP bridge grants do not cover other provider tools", () => {
    expect(
      isScheduledJobToolAllowed({
        requiredTools: ["github_call_mcp_tool"],
        toolName: "github_get_pr"
      })
    ).toBe(false);
    expect(
      isScheduledJobToolAllowed({
        requiredTools: ["github_call_mcp_tool"],
        toolName: "google_get_drive_file"
      })
    ).toBe(false);
  });

  test("specific grants remain limited to the exact tool", () => {
    expect(
      isScheduledJobToolAllowed({
        requiredTools: ["github_search_issues"],
        toolName: "github_get_pr"
      })
    ).toBe(false);
  });
});
