import { describe, expect, test } from "bun:test";
import { renderTaskOutputSpec } from "../../src/scheduler/output-spec";

describe("task output spec renderer", () => {
  test("renders literal output exactly", () => {
    expect(
      renderTaskOutputSpec({
        kind: "literal",
        text: ":heart::heart:",
      }),
    ).toEqual({
      ok: true,
      text: ":heart::heart:",
    });
  });

  test("rejects literal runtime progress text", () => {
    expect(
      renderTaskOutputSpec({
        kind: "literal",
        text: "Calling github search issues...",
      }),
    ).toEqual({
      ok: false,
      reason:
        "Output contains runtime-control/progress text instead of user-visible content.",
    });
  });

  test("rejects literal tool-call protocol text", () => {
    expect(
      renderTaskOutputSpec({
        kind: "literal",
        text: ':gear: github_search_issues: "org:apelogic-ai is:pr"',
      }),
    ).toEqual({
      ok: false,
      reason: "Output contains tool-call protocol text.",
    });
  });

  test("renders a stable report with item templates", () => {
    expect(
      renderTaskOutputSpec({
        kind: "report",
        title: "New PRs in apelogic-ai",
        items: [
          {
            repo: "burble",
            number: 75,
            title: "[codex] Add scheduler task inspection and validation",
            url: "https://github.com/apelogic-ai/burble/pull/75",
          },
          {
            repo: "observer",
            number: 44,
            title: "feat(api): server-side disclosure floor at the ingestor",
            url: "https://github.com/apelogic-ai/observer/pull/44",
          },
        ],
        itemTemplate: "• {repo} #{number} — {title}\n  {url}",
        emptyState: "No new PRs in apelogic-ai.",
      }),
    ).toEqual({
      ok: true,
      text: [
        "New PRs in apelogic-ai",
        "",
        "• burble #75 — [codex] Add scheduler task inspection and validation",
        "  https://github.com/apelogic-ai/burble/pull/75",
        "• observer #44 — feat(api): server-side disclosure floor at the ingestor",
        "  https://github.com/apelogic-ai/observer/pull/44",
      ].join("\n"),
    });
  });

  test("renders report empty state without headings or filler", () => {
    expect(
      renderTaskOutputSpec({
        kind: "report",
        title: "New PRs in apelogic-ai",
        items: [],
        itemTemplate: "• {repo} — {title}",
        emptyState: "No new PRs in apelogic-ai.",
      }),
    ).toEqual({
      ok: true,
      text: "No new PRs in apelogic-ai.",
    });
  });

  test("renders report overflow with stable wording", () => {
    expect(
      renderTaskOutputSpec({
        kind: "report",
        title: "New PRs",
        items: [
          { repo: "one", title: "PR 1" },
          { repo: "two", title: "PR 2" },
          { repo: "three", title: "PR 3" },
        ],
        itemTemplate: "• {repo} — {title}",
        emptyState: "No PRs.",
        maxItems: 2,
      }),
    ).toEqual({
      ok: true,
      text: [
        "New PRs",
        "",
        "• one — PR 1",
        "• two — PR 2",
        "",
        "And 1 more.",
      ].join("\n"),
    });
  });

  test("fails when a template references a missing item field", () => {
    expect(
      renderTaskOutputSpec({
        kind: "report",
        title: "New PRs",
        items: [{ repo: "burble" }],
        itemTemplate: "• {repo} — {title}",
        emptyState: "No PRs.",
      }),
    ).toEqual({
      ok: false,
      reason: "Output item is missing required field title.",
    });
  });

  test("fails when a template interpolates an object into text", () => {
    expect(
      renderTaskOutputSpec({
        kind: "report",
        title: "New PRs",
        items: [{ repo: "burble", metadata: { number: 75 } }],
        itemTemplate: "• {repo} — {metadata}",
        emptyState: "No PRs.",
      }),
    ).toEqual({
      ok: false,
      reason: "Workflow value metadata cannot be interpolated as text.",
    });
  });

  test("fails when report output would include forbidden content", () => {
    expect(
      renderTaskOutputSpec({
        kind: "report",
        title: "New PRs",
        items: [{ repo: "burble", title: "Tool call: github_search_issues" }],
        itemTemplate: "• {repo} — {title}",
        emptyState: "No PRs.",
        forbiddenContent: ["github_search_issues"],
      }),
    ).toEqual({
      ok: false,
      reason: "Output contains forbidden content: github_search_issues.",
    });
  });
});
