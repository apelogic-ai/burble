import { describe, expect, test } from "bun:test";
import { normalizeMentionText } from "../../src/conversation/normalize";

describe("normalizeMentionText", () => {
  test("removes the bot mention and trims whitespace", () => {
    expect(normalizeMentionText("<@U123>   what issues are assigned to me?")).toBe(
      "what issues are assigned to me?"
    );
  });

  test("removes repeated bot mentions", () => {
    expect(normalizeMentionText("<@U123> <@U123> connect github")).toBe(
      "connect github"
    );
  });

  test("normalizes Slack rich text whitespace", () => {
    expect(normalizeMentionText(" <@U123>\n\nwho   am I on GitHub? ")).toBe(
      "who am I on GitHub?"
    );
  });
});
