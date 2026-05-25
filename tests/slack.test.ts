import { describe, expect, test } from "bun:test";
import {
  buildAuthResponse,
  formatAgentProgressEvent,
  buildReplyThreadTs,
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
    expect(formatMentionWorkingMessage()).toBe("Starting agent runtime...");
  });
});

describe("formatAgentProgressEvent", () => {
  test("formats status and tool lifecycle updates", () => {
    expect(
      formatAgentProgressEvent({
        type: "status",
        text: "Preparing your OpenClaw/NemoClaw runtime..."
      })
    ).toBe("Preparing your agent runtime...");

    expect(
      formatAgentProgressEvent(
        {
          type: "tool_call",
          toolName: "github.listAssignedIssues",
          callId: "call-1"
        },
        "Preparing your agent runtime..."
      )
    ).toBe("Preparing your agent runtime...\nAgent is calling GitHub assigned issues...");

    expect(
      formatAgentProgressEvent(
        {
          type: "tool_result",
          toolName: "jira.searchIssues",
          callId: "call-1",
          classification: "user_private"
        },
        "Agent is calling Jira search..."
      )
    ).toBe("Agent is calling Jira search...\nAgent called Jira search.");
  });

  test("renders streaming message deltas as response progress", () => {
    expect(
      formatAgentProgressEvent(
        {
          type: "message_delta",
          text: " world"
        },
        "hello"
      )
    ).toBe("hello\nAgent is responding...");
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

  test("routes Jira aliases", () => {
    expect(parseAuthCommand("jira")).toEqual({ kind: "jira" });
    expect(parseAuthCommand("atlassian")).toEqual({ kind: "jira" });
    expect(parseAuthCommand("connect jira")).toEqual({ kind: "jira" });
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
    const response = buildAuthResponse({
      githubUrl: "https://example.test/github",
      jiraUrl: "https://example.test/jira"
    });

    expect(response.text).toContain("Connections");
    expect(JSON.stringify(response.blocks)).toContain("GitHub");
    expect(JSON.stringify(response.blocks)).toContain("Atlassian");
    expect(JSON.stringify(response.blocks)).toContain("https://example.test/github");
    expect(JSON.stringify(response.blocks)).toContain("https://example.test/jira");
  });

  test("marks Jira unavailable when no Jira OAuth URL is configured", () => {
    const response = buildAuthResponse({
      githubUrl: "https://example.test/github",
      jiraUrl: null
    });

    expect(JSON.stringify(response.blocks)).toContain("Jira OAuth is not configured");
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

describe("buildReplyThreadTs", () => {
  test("threads channel replies under the triggering message", () => {
    expect(
      buildReplyThreadTs({
        isDirectMessage: false,
        messageTs: "1710000000.000100"
      })
    ).toBe("1710000000.000100");
  });

  test("does not thread fresh direct message replies", () => {
    expect(
      buildReplyThreadTs({
        isDirectMessage: true,
        messageTs: "1710000000.000100"
      })
    ).toBeUndefined();
  });

  test("keeps replies inside an existing direct message thread", () => {
    expect(
      buildReplyThreadTs({
        isDirectMessage: true,
        messageTs: "1710000001.000100",
        threadTs: "1710000000.000100"
      })
    ).toBe("1710000000.000100");
  });
});
