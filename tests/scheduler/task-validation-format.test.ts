import { describe, expect, test } from "bun:test";
import { formatScheduledTaskValidationFailureReason } from "../../src/scheduler/task-validation-format";

describe("scheduled task validation failure formatting", () => {
  test("truncates safely with an ellipsis", () => {
    const reason = formatScheduledTaskValidationFailureReason({
      ok: false,
      expectedTools: [],
      grantedTools: [],
      warnings: [],
      errors: [
        {
          code: "missing_required_tool",
          message: `${"a".repeat(480)}🚀tail`,
          tool: "github_search_issues",
        },
      ],
    });

    expect(Array.from(reason).at(-1)).toBe("…");
    expect(reason).not.toContain("\ud83d");
    expect(reason).not.toContain("\ude80");
    expect(Array.from(reason).length).toBe(500);
  });
});
