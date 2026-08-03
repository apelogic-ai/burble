import { describe, expect, test } from "bun:test";
import {
  SCHEDULED_JOB_OUTPUT_CONTRACT_PROMPT,
  readDeclaredNoChangeOutput,
  scheduledTaskRuntimePrompt,
  validateScheduledJobOutput,
} from "../../src/scheduler/output-contract";

describe("scheduled job output contract", () => {
  test("wraps normal scheduled tasks with output contract instructions", () => {
    const prompt = scheduledTaskRuntimePrompt(
      "Find new PRs in apelogic-ai and summarize them.",
    );

    expect(prompt).toContain(SCHEDULED_JOB_OUTPUT_CONTRACT_PROMPT);
    expect(prompt).toContain("Task:");
    expect(prompt).toContain("Find new PRs in apelogic-ai");
    expect(prompt).toContain("Do not call tools for delivery");
    expect(prompt).toContain("Do not describe setup");
  });

  test("wraps literal scheduled messages as exact final output tasks", () => {
    const prompt = scheduledTaskRuntimePrompt(
      "Post exactly this message: :heart::heart:",
    );

    expect(prompt).toContain(SCHEDULED_JOB_OUTPUT_CONTRACT_PROMPT);
    expect(prompt).toContain("literal delivery");
    expect(prompt.endsWith(":heart::heart:")).toBe(true);
  });

  test("reads generic inline and multiline no-change outputs", () => {
    expect(
      readDeclaredNoChangeOutput(
        "If there are no new records, say exactly: no new records",
      ),
    ).toBe("no new records");
    expect(
      readDeclaredNoChangeOutput(
        "If no net-new topics remain, say exactly:\n\nno new topics",
      ),
    ).toBe("no new topics");
    expect(
      readDeclaredNoChangeOutput(
        "If the state cannot be read, report the failure instead.",
      ),
    ).toBeNull();
  });

  test("accepts and trims normal final output", () => {
    expect(
      validateScheduledJobOutput({
        classification: "public",
        text: "\nNew PRs:\n- burble #75\n",
      }),
    ).toEqual({
      ok: true,
      classification: "public",
      text: "New PRs:\n- burble #75",
    });
  });

  test("rejects empty final output", () => {
    expect(
      validateScheduledJobOutput({
        classification: "public",
        text: "  \n\t",
      }),
    ).toEqual({
      ok: false,
      reason: "Managed runtime final response was empty",
    });
  });

  test("rejects runtime-control progress as final output", () => {
    expect(
      validateScheduledJobOutput({
        classification: "user_private",
        text: "Calling github search issues...\n\nFinal result in 2.0s.",
      }),
    ).toEqual({
      ok: false,
      reason:
        "Managed runtime final response contained only runtime-control/progress text",
    });
  });

  test("rejects leaked tool protocol as final output", () => {
    expect(
      validateScheduledJobOutput({
        classification: "user_private",
        text: ':gear: github_search_issues: "org:apelogic-ai is:pr"',
      }),
    ).toEqual({
      ok: false,
      reason: "Managed runtime final response leaked tool-call protocol text",
    });
  });
});
