import { describe, expect, test } from "bun:test";
import { enforceVisibility } from "../../src/conversation/visibility";

describe("enforceVisibility", () => {
  test("keeps public responses public in channels", () => {
    expect(
      enforceVisibility(
        { visibility: "public", classification: "public", text: "Hello" },
        { isDirectMessage: false }
      ).visibility
    ).toBe("public");
  });

  test("downgrades user-private channel responses to ephemeral", () => {
    expect(
      enforceVisibility(
        {
          visibility: "public",
          classification: "user_private",
          text: "Private GitHub result"
        },
        { isDirectMessage: false }
      ).visibility
    ).toBe("ephemeral");
  });

  test("allows user-private responses in direct messages", () => {
    expect(
      enforceVisibility(
        {
          visibility: "public",
          classification: "user_private",
          text: "Private GitHub result"
        },
        { isDirectMessage: true }
      ).visibility
    ).toBe("public");
  });
});
