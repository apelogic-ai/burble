import { describe, expect, test } from "bun:test";
import { formatLogError, withUtcTimestamp } from "../src/logging";

describe("logging", () => {
  test("prefixes log messages with an ISO UTC timestamp", () => {
    expect(
      withUtcTimestamp(
        "Slack Socket Mode app is running.",
        new Date("2026-05-21T12:34:56.789Z")
      )
    ).toBe("2026-05-21T12:34:56.789Z Slack Socket Mode app is running.");
  });

  test("formats errors with an ISO UTC timestamp", () => {
    const error = new Error("boom");
    error.stack = "Error: boom";

    expect(formatLogError(error, new Date("2026-05-21T12:34:56.789Z"))).toBe(
      "2026-05-21T12:34:56.789Z Error: boom"
    );
  });
});
