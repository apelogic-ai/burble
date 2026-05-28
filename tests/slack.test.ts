import { describe, expect, test } from "bun:test";
import {
  buildAgentConfigResponse,
  buildAgentCommandHelpResponse,
  buildAgentExecLoadingResponse,
  buildAgentExecMissingTaskResponse,
  buildAgentStatusResponse,
  buildAuthResponse,
  buildHelpResponse,
  formatAgentProgressEvent,
  readAgentConfigFile,
  buildReplyThreadTs,
  formatConnectGitHubMessage,
  formatConversationFailureMessage,
  formatGitHubIdentityMessage,
  formatWorkingMessage,
  formatIssuesMessage,
  formatMentionWorkingMessage,
  parseAgentCommand,
  parseAuthCommand,
  shouldHandleDirectMessageEvent,
  summarizeSlackPayload
} from "../src/slack";
import type { Config } from "../src/config";

const agentConfig: Config = {
  slackBotToken: "xoxb-test",
  slackAppToken: "xapp-test",
  slackClientId: "slack-client-id",
  slackClientSecret: "slack-client-secret",
  slackRedirectUri: "https://example.test/oauth/slack/callback",
  githubClientId: "github-client-id",
  githubClientSecret: "github-client-secret",
  jiraClientId: "jira-client-id",
  jiraClientSecret: "jira-client-secret",
  googleClientId: "google-client-id",
  googleClientSecret: "google-client-secret",
  baseUrl: "https://example.test",
  port: 3000,
  databasePath: ":memory:",
  slackLogLevel: "info",
  agentMode: "llm",
  agentRuntime: "openclaw-nemoclaw",
  agentRuntimeFactory: "docker",
  aiModel: "openai:gpt-5.4",
  openClawNemoClawUrl: null,
  openClawNemoClawEngine: "burble-direct",
  agentRuntimeDataRoot: "/data/runtimes",
  agentRuntimeDockerNetwork: "compose_default",
  agentRuntimeImage: "burble-openclaw-nemoclaw:dev",
  agentRuntimeIdleTtlMs: 1800000,
  agentRuntimeReaperIntervalMs: 60000,
  agentRuntimeJwtTtlSeconds: 604800,
  agentRuntimeTokenSecret: "runtime-secret",
  agentRuntimeToolGatewayUrl: "http://burble-app:3000/internal/tools",
  agentRuntimeMcpGatewayUrl: "http://burble-app:3000/mcp",
  agentRuntimeMcpAudience: "http://burble-app:3000/mcp",
  atlassianMcpUrl: "https://mcp.atlassian.com/v1/mcp",
  runtimeJwtIssuer: "http://burble-app:3000",
  runtimeJwtPrivateKeyPath: "/data/runtime-jwt-private.pem",
  openClawConfigPatchHostPath: null,
  internalApiToken: "internal-token"
};

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
    expect(formatWorkingMessage("/auth")).toBe("Working on `/auth`...");
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
          type: "status",
          text: "Agent has thought for 24s"
        },
        "Sending task to your private agent runtime..."
      )
    ).toBe("Agent has thought for 24s...");

    expect(
      formatAgentProgressEvent(
        {
          type: "tool_call",
          toolName: "github.listAssignedIssues",
          callId: "call-1"
        },
        "Preparing your agent runtime..."
      )
    ).toBe("Preparing your agent runtime...\nCalling GitHub assigned issues...");

    expect(
      formatAgentProgressEvent(
        {
          type: "tool_result",
          toolName: "jira.searchIssues",
          callId: "call-1",
          classification: "user_private"
        },
        "Calling Jira search..."
      )
    ).toBe("Calling Jira search...\nJira search completed (user-private result).");
  });

  test("renders streaming message deltas as response progress", () => {
    expect(
      formatAgentProgressEvent(
        {
          type: "message_delta",
          text: " world"
        },
        ""
      )
    ).toBe("Agent is responding...");
  });
});

describe("buildAgentExecLoadingResponse", () => {
  test("can render agent exec progress as a visible DM response", () => {
    expect(
      buildAgentExecLoadingResponse("run a long task", "in_channel")
    ).toMatchObject({
      response_type: "in_channel",
      text: "Agent task: Preparing agent runtime..."
    });
  });
});

describe("formatConversationFailureMessage", () => {
  test("explains runtime MCP auth failures as runtime JWT issues", () => {
    expect(
      formatConversationFailureMessage(
        new Error(
          'Runtime run failed: Burble MCP initialize returned HTTP 401: {"error":"unauthorized","error_description":"JWT token required"}'
        ),
        "message"
      )
    ).toContain("not an expired GitHub/Jira token");
  });

  test("keeps the generic fallback for unknown failures", () => {
    expect(formatConversationFailureMessage(new Error("boom"), "mention")).toBe(
      "I could not handle that mention."
    );
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
    expect(parseAuthCommand("slack")).toEqual({ kind: "slack" });
    expect(parseAuthCommand("connect slack")).toEqual({ kind: "slack" });
  });

  test("reports unknown auth targets", () => {
    expect(parseAuthCommand("salesforce")).toEqual({
      kind: "unknown",
      value: "salesforce"
    });
  });
});

describe("parseAgentCommand", () => {
  test("defaults to help", () => {
    expect(parseAgentCommand("")).toEqual({ kind: "help" });
    expect(parseAgentCommand("help")).toEqual({ kind: "help" });
    expect(parseAgentCommand("unknown")).toEqual({ kind: "help" });
  });

  test("routes status aliases", () => {
    expect(parseAgentCommand("status")).toEqual({ kind: "status" });
    expect(parseAgentCommand("runtime status")).toEqual({ kind: "status" });
  });

  test("routes config aliases", () => {
    expect(parseAgentCommand("config")).toEqual({ kind: "config" });
    expect(parseAgentCommand("configuration")).toEqual({ kind: "config" });
    expect(parseAgentCommand("runtime config")).toEqual({ kind: "config" });
  });

  test("routes exec tasks", () => {
    expect(parseAgentCommand("exec summarize my calendar")).toEqual({
      kind: "exec",
      task: "summarize my calendar"
    });
    expect(parseAgentCommand("execute   run a code task")).toEqual({
      kind: "exec",
      task: "run a code task"
    });
    expect(parseAgentCommand("exec")).toEqual({ kind: "exec_list" });
    expect(parseAgentCommand("exec inspect abc123")).toEqual({
      kind: "exec_inspect",
      taskId: "abc123"
    });
    expect(parseAgentCommand("exec abc123 inspect")).toEqual({
      kind: "exec_inspect",
      taskId: "abc123"
    });
    expect(parseAgentCommand("exec stop abc123")).toEqual({
      kind: "exec_stop",
      taskId: "abc123"
    });
    expect(parseAgentCommand("exec abc123 stop")).toEqual({
      kind: "exec_stop",
      taskId: "abc123"
    });
  });
});

describe("buildAuthResponse", () => {
  test("builds a connections menu with GitHub and future providers", () => {
    const response = buildAuthResponse({
      githubUrl: "https://example.test/github",
      googleUrl: "https://example.test/google",
      jiraUrl: "https://example.test/jira",
      slackUrl: "https://example.test/slack",
      connections: {
        github: {
          provider: "github",
          email: "person@example.com",
          slackUserId: "U123",
          providerLogin: "octocat",
          accessToken: "github-token",
          connectedAt: "2026-05-26T00:00:00.000Z"
        },
        google: null,
        jira: null,
        slack: {
          provider: "slack",
          email: "person@example.com",
          slackUserId: "U123",
          providerLogin: "U123",
          accessToken: "slack-token",
          connectedAt: "2026-05-26T00:00:00.000Z"
        }
      }
    });

    expect(response.text).toContain("connections");
    expect(JSON.stringify(response.blocks)).toContain("GitHub");
    expect(JSON.stringify(response.blocks)).toContain("Google Workspace");
    expect(JSON.stringify(response.blocks)).toContain("Atlassian");
    expect(JSON.stringify(response.blocks)).toContain("Slack search");
    expect(JSON.stringify(response.blocks)).toContain("Connected as `octocat`");
    expect(JSON.stringify(response.blocks)).toContain("Connected as <@U123>");
    expect(JSON.stringify(response.blocks)).toContain("Not connected");
    expect(JSON.stringify(response.blocks)).toContain("https://example.test/github");
    expect(JSON.stringify(response.blocks)).toContain("https://example.test/google");
    expect(JSON.stringify(response.blocks)).toContain("https://example.test/jira");
    expect(JSON.stringify(response.blocks)).toContain("https://example.test/slack");
  });

  test("marks Jira unavailable when no Jira OAuth URL is configured", () => {
    const response = buildAuthResponse({
      githubUrl: "https://example.test/github",
      googleUrl: null,
      jiraUrl: null,
      slackUrl: null
    });

    expect(JSON.stringify(response.blocks)).toContain("Google OAuth is not configured");
    expect(JSON.stringify(response.blocks)).toContain("Jira OAuth is not configured");
    expect(JSON.stringify(response.blocks)).toContain("Slack OAuth is not configured");
  });
});

describe("buildHelpResponse", () => {
  test("builds a concise command and example panel", () => {
    const response = buildHelpResponse();

    expect(response.text).toBe("Burble help");
    expect(JSON.stringify(response.blocks)).toContain("/auth");
    expect(JSON.stringify(response.blocks)).toContain("/help");
    expect(JSON.stringify(response.blocks)).toContain("/agent config");
    expect(JSON.stringify(response.blocks)).toContain("/agent exec");
    expect(JSON.stringify(response.blocks)).toContain("/agent status");
    expect(JSON.stringify(response.blocks)).toContain("/agent-config");
    expect(JSON.stringify(response.blocks)).toContain("/agent-status");
    expect(JSON.stringify(response.blocks)).toContain("assign DM-12 to me");
  });
});

describe("buildAgentCommandHelpResponse", () => {
  test("shows the agent fallback slash command", () => {
    const response = buildAgentCommandHelpResponse();

    expect(response.text).toBe("Agent controls");
    expect(JSON.stringify(response.blocks)).toContain("/agent status");
    expect(JSON.stringify(response.blocks)).toContain("/agent config");
    expect(JSON.stringify(response.blocks)).toContain("/agent exec");
  });

  test("builds exec response states", () => {
    expect(buildAgentExecMissingTaskResponse().text).toContain(
      "/agent exec <task>"
    );
    expect(buildAgentExecLoadingResponse("summarize calendar").response_type).toBe(
      "in_channel"
    );
    expect(buildAgentExecLoadingResponse("summarize calendar").text).toBe(
      "Agent task: Preparing agent runtime..."
    );
  });
});

describe("buildAgentStatusResponse", () => {
  test("shows configured runtime values without a runtime record", () => {
    const response = buildAgentStatusResponse({
      config: agentConfig,
      runtime: null
    });

    const blocks = JSON.stringify(response.blocks);
    expect(response.text).toBe("Agent status");
    expect(blocks).toContain("openclaw-nemoclaw");
    expect(blocks).toContain("burble-direct");
    expect(blocks).toContain("openai:gpt-5.4");
    expect(blocks).toContain("No runtime record exists yet");
  });

  test("shows the current user runtime record when present", () => {
    const response = buildAgentStatusResponse({
      config: agentConfig,
      runtime: {
        id: "rt_123",
        workspaceId: "T123",
        slackUserId: "U123",
        engine: "burble-direct",
        status: "ready",
        endpointUrl: "http://runtime:8080",
        authTokenHash: "hash",
        statePath: "/data/state",
        configPath: "/data/config/runtime.json",
        workspacePath: "/data/workspace",
        createdAt: "2026-05-26T00:00:00.000Z",
        lastSeenAt: "2026-05-26T00:01:00.000Z",
        lastUsedAt: "2026-05-26T00:02:00.000Z",
        stoppedAt: null,
        failureReason: null
      }
    });

    const blocks = JSON.stringify(response.blocks);
    expect(blocks).toContain("rt_123");
    expect(blocks).toContain("ready");
    expect(blocks).toContain("http://runtime:8080");
    expect(blocks).not.toContain("hash");
  });
});

describe("buildAgentConfigResponse", () => {
  test("shows a redacted runtime JSON config preview", async () => {
    const runtime = {
      id: "rt_123",
      workspaceId: "T123",
      slackUserId: "U123",
      engine: "burble-direct" as const,
      status: "ready" as const,
      endpointUrl: "http://runtime:8080",
      authTokenHash: "hash",
      statePath: "/data/state",
      configPath: "/data/config/runtime.json",
      workspacePath: "/data/workspace",
      createdAt: "2026-05-26T00:00:00.000Z",
      lastSeenAt: "2026-05-26T00:01:00.000Z",
      lastUsedAt: "2026-05-26T00:02:00.000Z",
      stoppedAt: null,
      failureReason: null
    };
    const configFile = await readAgentConfigFile(runtime, async () =>
      JSON.stringify({
        agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
        auth: { profiles: { openai: { apiKey: "sk-super-secret-token" } } }
      })
    );
    const response = buildAgentConfigResponse({ runtime, configFile });

    const blocks = JSON.stringify(response.blocks);
    expect(response.text).toBe("Agent configuration");
    expect(blocks).toContain("/data/config/runtime.json");
    expect(blocks).toContain("agents");
    expect(blocks).toContain("[redacted]");
    expect(blocks).not.toContain("sk-super-secret-token");
  });

  test("shows config read errors without throwing", async () => {
    const configFile = await readAgentConfigFile(null);
    const response = buildAgentConfigResponse({
      runtime: null,
      configFile
    });

    const blocks = JSON.stringify(response.blocks);
    expect(blocks).toContain("not ready");
    expect(blocks).toContain("No runtime record exists yet");
  });

  test("reads config through the runtime factory when available", async () => {
    const runtime = {
      id: "rt_123",
      workspaceId: "T123",
      slackUserId: "U123",
      engine: "burble-direct" as const,
      status: "ready" as const,
      endpointUrl: "http://runtime:8080",
      authTokenHash: "hash",
      statePath: "/data/state",
      configPath: "/host/runtime.json",
      workspacePath: "/data/workspace",
      createdAt: "2026-05-26T00:00:00.000Z",
      lastSeenAt: "2026-05-26T00:01:00.000Z",
      lastUsedAt: "2026-05-26T00:02:00.000Z",
      stoppedAt: null,
      failureReason: null
    };
    const configFile = await readAgentConfigFile(runtime, {
      runtimeFactory: {
        async getOrCreateRuntime() {
          throw new Error("not used");
        },
        async readRuntimeConfig(runtimeId) {
          expect(runtimeId).toBe("rt_123");
          return {
            path: "/host/runtime.json",
            text: "{\"via\":\"factory\"}"
          };
        },
        async stopRuntime() {},
        async reapIdleRuntimes() {}
      }
    });

    expect(configFile.path).toBe("/host/runtime.json");
    expect(configFile.redactedText).toContain("factory");
  });
});

describe("summarizeSlackPayload", () => {
  test("uses top-level fields for slash command payloads", () => {
    expect(
      summarizeSlackPayload({
        type: "slash_command",
        command: "/help",
        user_id: "U123",
        channel_id: "C123",
        team_id: "T123"
      })
    ).toBe(
      "type=slash_command command=/help event=none user=U123 channel=C123 team=T123"
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

  test("handles Slack file-share IM messages", () => {
    expect(
      shouldHandleDirectMessageEvent({
        channel_type: "im",
        channel: "D123",
        user: "U123",
        subtype: "file_share",
        text: "summarize the doc",
        ts: "1710000000.000100",
        files: [
          {
            id: "F123",
            name: "SECURITY_AUDIT_2026-05-21.md",
            mimetype: "text/markdown"
          }
        ]
      })
    ).toBe(true);
  });

  test("ignores slash-command text echoed in app DMs", () => {
    expect(
      shouldHandleDirectMessageEvent({
        channel_type: "im",
        channel: "D123",
        user: "U123",
        text: "/agent exec run a code task",
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
