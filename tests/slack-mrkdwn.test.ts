import { describe, expect, test } from "bun:test";
import { markdownToSlackMrkdwn } from "../src/slack-mrkdwn";

describe("markdownToSlackMrkdwn", () => {
  test("converts common Markdown formatting to Slack mrkdwn", () => {
    expect(
      markdownToSlackMrkdwn(
        [
          "## Summary",
          "",
          "- **New SDK** - [PR #2122](https://github.com/NVIDIA/OpenShell/pull/2122)",
          "- ~~Withdrawn~~"
        ].join("\n")
      )
    ).toBe(
      [
        "*Summary*",
        "",
        "- *New SDK* - <https://github.com/NVIDIA/OpenShell/pull/2122|PR #2122>",
        "- ~Withdrawn~"
      ].join("\n")
    );
  });

  test("preserves inline and fenced code while leaving Slack mrkdwn intact", () => {
    expect(
      markdownToSlackMrkdwn(
        [
          "*Already Slack bold* and `**literal**`.",
          "```json",
          '{"markdown":"**literal**"}',
          "```",
          "**Converted outside code**"
        ].join("\n")
      )
    ).toBe(
      [
        "*Already Slack bold* and `**literal**`.",
        "```json",
        '{"markdown":"**literal**"}',
        "```",
        "*Converted outside code*"
      ].join("\n")
    );
  });
});
