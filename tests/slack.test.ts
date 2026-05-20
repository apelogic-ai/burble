import { describe, expect, test } from "bun:test";
import {
  buildAuthResponse,
  formatConnectGitHubMessage,
  formatGitHubIdentityMessage,
  formatWorkingMessage,
  formatIssuesMessage,
  formatMentionWorkingMessage,
  parseAuthCommand,
  shouldHandleDirectMessageEvent,
  summarizeSlackPayload
} from "../src/slack";

describe("formatIssuesMessage", () => {
  test("returns a helpful empty state", () => {
    expect(formatIssuesMessage([])).toBe("No open issues assigned to you.");
  });

  test("formats assigned issues as Slack links", () => {
    expect(
      formatIssuesMessage([
        {
          html_url: "https://github.com/acme/app/issues/1",
          title: "Fix billing export"
        },
        {
          html_url: "https://github.com/acme/app/issues/2",
          title: "Handle SSO email mismatch"
        }
      ])
    ).toBe(
      [
        "- <https://github.com/acme/app/issues/1|Fix billing export>",
        "- <https://github.com/acme/app/issues/2|Handle SSO email mismatch>"
      ].join("\n")
    );
  });
});

describe("formatGitHubIdentityMessage", () => {
  test("formats the connected GitHub identity", () => {
    expect(formatGitHubIdentityMessage("octocat", "person@example.com")).toBe(
      "Authenticated to GitHub as `octocat` for Slack email person@example.com."
    );
  });
});

describe("formatConnectGitHubMessage", () => {
  test("formats the GitHub OAuth link", () => {
    expect(formatConnectGitHubMessage("https://example.test/connect")).toBe(
      "<https://example.test/connect|Connect your GitHub account>"
    );
  });
});

describe("formatWorkingMessage", () => {
  test("names the command being processed", () => {
    expect(formatWorkingMessage("/github-me")).toBe("Working on `/github-me`...");
  });
});

describe("formatMentionWorkingMessage", () => {
  test("formats the LLM mention progress state", () => {
    expect(formatMentionWorkingMessage()).toBe("Working on that...");
  });
});

describe("parseAuthCommand", () => {
  test("defaults to the connections menu", () => {
    expect(parseAuthCommand("")).toEqual({ kind: "connections" });
    expect(parseAuthCommand("connections")).toEqual({ kind: "connections" });
  });

  test("routes GitHub aliases", () => {
    expect(parseAuthCommand("github")).toEqual({ kind: "github" });
    expect(parseAuthCommand("connect github")).toEqual({ kind: "github" });
  });

  test("reports unknown auth targets", () => {
    expect(parseAuthCommand("salesforce")).toEqual({
      kind: "unknown",
      value: "salesforce"
    });
  });
});

describe("buildAuthResponse", () => {
  test("builds a connections menu with GitHub and future providers", () => {
    const response = buildAuthResponse("https://example.test/github");

    expect(response.text).toContain("Connections");
    expect(JSON.stringify(response.blocks)).toContain("GitHub");
    expect(JSON.stringify(response.blocks)).toContain("Atlassian");
    expect(JSON.stringify(response.blocks)).toContain("https://example.test/github");
  });
});

describe("summarizeSlackPayload", () => {
  test("uses top-level fields for slash command payloads", () => {
    expect(
      summarizeSlackPayload({
        type: "slash_command",
        command: "/issues",
        user_id: "U123",
        channel_id: "C123",
        team_id: "T123"
      })
    ).toBe(
      "type=slash_command command=/issues event=none user=U123 channel=C123 team=T123"
    );
  });

  test("uses nested event fields for event callbacks", () => {
    expect(
      summarizeSlackPayload({
        type: "event_callback",
        team_id: "T123",
        event: {
          type: "app_mention",
          user: "U123",
          channel: "C123"
        }
      })
    ).toBe(
      "type=event_callback command=none event=app_mention user=U123 channel=C123 team=T123"
    );
  });
});

describe("shouldHandleDirectMessageEvent", () => {
  test("handles user-authored IM messages", () => {
    expect(
      shouldHandleDirectMessageEvent({
        channel_type: "im",
        channel: "D123",
        user: "U123",
        text: "summarize my work",
        ts: "1710000000.000100"
      })
    ).toBe(true);
  });

  test("ignores bot and subtype IM messages", () => {
    expect(
      shouldHandleDirectMessageEvent({
        channel_type: "im",
        channel: "D123",
        user: "U123",
        bot_id: "B123",
        text: "Working on that...",
        ts: "1710000000.000100"
      })
    ).toBe(false);
    expect(
      shouldHandleDirectMessageEvent({
        channel_type: "im",
        channel: "D123",
        user: "U123",
        subtype: "message_changed",
        text: "edited",
        ts: "1710000000.000100"
      })
    ).toBe(false);
  });

  test("ignores malformed or non-IM messages", () => {
    expect(
      shouldHandleDirectMessageEvent({
        channel_type: "channel",
        channel: "C123",
        user: "U123",
        text: "hello",
        ts: "1710000000.000100"
      })
    ).toBe(false);
    expect(
      shouldHandleDirectMessageEvent({
        channel_type: "im",
        channel: "D123",
        user: "U123",
        text: "hello"
      })
    ).toBe(false);
  });
});
