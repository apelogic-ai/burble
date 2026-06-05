import { describe, expect, test } from "bun:test";
import {
  applyAgentRuntimeControl,
  applyAgentUserConfigSet,
  buildAgentConfigRuntimeRestartFailureResponse,
  buildAgentConfigRuntimeRestartResponse,
  buildAgentConfigModalView,
  buildAgentConfigResponse,
  buildAgentCommandHelpResponse,
  applyAgentRuntimeEngineSelection,
  buildAgentUserConfigGetResponse,
  buildAgentExecLoadingResponse,
  buildAgentExecMissingTaskResponse,
  buildAgentExecToolGroups,
  buildAgentStatusResponse,
  buildAppHomeView,
  buildAgentHomeSettings,
  buildAgentRuntimeManageModalView,
  buildAuthResponse,
  buildHelpResponse,
  formatAgentProgressEvent,
  formatAgentProgressMessage,
  postConversationResponse,
  updateAgentProgressMessage,
  readAgentConfigFile,
  buildReplyThreadTs,
  failAgentProgressMessage,
  formatFinalProgressLine,
  formatConnectGitHubMessage,
  formatConversationFailureMessage,
  formatGitHubIdentityMessage,
  formatWorkingMessage,
  formatIssuesMessage,
  formatMentionWorkingMessage,
  isDirectMessageSlashCommand,
  parseAgentCommand,
  parseAuthCommand,
  restartAgentRuntimeIfConfigChanged,
  runtimeImageForEngine,
  resolveSlackProgressStreamingMode,
  shouldHandleDirectMessageEvent,
  summarizeSlackPayload,
  validateAgentRuntimeEngineSelection
} from "../src/slack";
import type { Config } from "../src/config";
import { createTokenStore } from "../src/db";
import { resolveRuntimeEngineForPrincipal } from "../src/agent/runtime-policy";

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
  hubspotClientId: "hubspot-client-id",
  hubspotClientSecret: "hubspot-client-secret",
  baseUrl: "https://example.test",
  port: 3000,
  databasePath: ":memory:",
  slackLogLevel: "info",
  agentMode: "llm",
  agentFastTrack: false,
  agentRuntime: "burble-runtime",
  agentRuntimeFactory: "docker",
  aiModel: "openai:gpt-5.4",
  managedRuntimeUrl: null,
  openClawNemoClawUrl: null,
  agentRuntimeEngine: "burble-direct",
  openClawNemoClawEngine: "burble-direct",
  agentRuntimeDataRoot: "/data/runtimes",
  agentRuntimeDockerNetwork: "compose_default",
  agentRuntimeImage: "burble-openclaw-nemoclaw:dev",
  agentRuntimeIdleTtlMs: 86400000,
  agentRuntimeReaperEnabled: true,
  agentRuntimeReaperIntervalMs: 60000,
  agentRuntimeJwtTtlSeconds: 604800,
  agentRuntimeTokenSecret: "runtime-secret",
  agentRuntimeToolGatewayUrl: "http://burble-app:3000/internal/tools",
  agentRuntimeMcpGatewayUrl: "http://burble-app:3000/mcp",
  agentRuntimeMcpAudience: "http://burble-app:3000/mcp",
  agentRuntimeStreaming: "native",
  atlassianMcpUrl: "https://mcp.atlassian.com/v1/mcp",
  runtimeJwtIssuer: "http://burble-app:3000",
  runtimeJwtPrivateKeyPath: "/data/runtime-jwt-private.pem",
  openClawConfigPatchHostPath: null,
  internalApiToken: "internal-token",
  observabilityJsonlPath: null,
  observabilityJsonlDir: null,
  observabilityIncludeContent: false
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

describe("resolveSlackProgressStreamingMode", () => {
  test("uses the basic in-place renderer when native streaming has no thread target", () => {
    expect(
      resolveSlackProgressStreamingMode({
        streamingMode: "native"
      })
    ).toBe("basic");

    expect(
      resolveSlackProgressStreamingMode({
        streamingMode: "native",
        streamThreadTs: "111.222"
      })
    ).toBe("native");
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
    ).toBe("world");

    expect(
      formatAgentProgressEvent(
        {
          type: "message_delta",
          text: " world"
        },
        "Hello"
      )
    ).toBe("Hello world");

    expect(
      formatAgentProgressEvent(
        {
          type: "message_replace",
          text: "Rewritten answer"
        },
        "Hello world"
      )
    ).toBe("Rewritten answer");
  });

  test("accumulates runtime message deltas in Slack progress messages", () => {
    const progressMessage = {
      channel: "D123",
      ts: "123.456",
      text: "Starting agent runtime...",
      startedAtMs: 0,
      toolStartedAtMs: {},
      toolLinesByCallId: {},
      toolCallOrder: []
    };

    expect(
      formatAgentProgressMessage(
        {
          type: "message_delta",
          text: "Hello"
        },
        progressMessage
      )
    ).toBe("Hello");

    expect(
      formatAgentProgressMessage(
        {
          type: "message_delta",
          text: " world"
        },
        progressMessage
      )
    ).toBe("Hello world");

    expect(
      formatAgentProgressMessage(
        {
          type: "message_replace",
          text: "Rewritten answer"
        },
        progressMessage
      )
    ).toBe("Rewritten answer");

    expect(
      formatAgentProgressMessage(
        {
          type: "status",
          text: "Agent has thought for 8s"
        },
        progressMessage
      )
    ).toBe("Rewritten answer");
  });

  test("throttles Slack chat updates for high-frequency runtime deltas", async () => {
    const updates: string[] = [];
    const originalNow = Date.now;
    let now = 1_000;
    Date.now = () => now;
    try {
      const progressMessage = {
        channel: "D123",
        ts: "123.456",
        text: "Starting agent runtime...",
        startedAtMs: 0,
        toolStartedAtMs: {},
        toolLinesByCallId: {},
        toolCallOrder: []
      };
      const client = {
        chat: {
          update: async (input: { text: string }) => {
            updates.push(input.text);
            return {};
          }
        }
      };

      await updateAgentProgressMessage(client as never, progressMessage, {
        type: "message_delta",
        text: "Hello"
      });
      now += 100;
      await updateAgentProgressMessage(client as never, progressMessage, {
        type: "message_delta",
        text: " world"
      });
      now += 1_000;
      await updateAgentProgressMessage(client as never, progressMessage, {
        type: "message_delta",
        text: " again"
      });

      expect(updates).toEqual(["Hello", "Hello world again"]);
      expect((progressMessage as { streamedText?: string }).streamedText).toBe(
        "Hello world again"
      );
    } finally {
      Date.now = originalNow;
    }
  });

  test("finalizes streamed progress in place without a blank summary handoff", async () => {
    const updates: Array<{ text: string; blocks?: unknown[] }> = [];
    const posts: Array<{ text: string }> = [];
    const originalNow = Date.now;
    Date.now = () => 2_500;
    try {
      const progressMessage = {
        channel: "D123",
        ts: "123.456",
        text: "Hello wor",
        streamedText: "Hello world",
        startedAtMs: 1_000,
        toolStartedAtMs: {},
        toolLinesByCallId: {},
        toolCallOrder: []
      };
      const client = {
        chat: {
          update: async (input: { text: string; blocks?: unknown[] }) => {
            updates.push(input);
            return {};
          },
          postMessage: async (input: { text: string }) => {
            posts.push(input);
            return {};
          }
        }
      };

      await postConversationResponse(client as never, {
        response: {
          visibility: "dm",
          classification: "user_private",
          text: "Hello world",
          usage: {
            inputTokens: 2,
            outputTokens: 1,
            totalTokens: 3,
            usageSource: "provider-output"
          }
        },
        channel: "D123",
        user: "U123",
        progressMessage
      });

      expect(updates.map((update) => update.text)).toEqual([
        "Hello world\n\n_Final result in 1.5s (3 tokens)._"
      ]);
      expect(posts).toEqual([]);
      expect(progressMessage.text).toBe(
        "Hello world\n\n_Final result in 1.5s (3 tokens)._"
      );
    } finally {
      Date.now = originalNow;
    }
  });

  test("uses Slack native stream methods for native streaming progress", async () => {
    const calls: string[] = [];
    const originalNow = Date.now;
    let now = 1_000;
    Date.now = () => now;
    try {
      const progressMessage = {
        channel: "D123",
        ts: "123.456",
        text: "Starting agent runtime...",
        startedAtMs: 1_000,
        threadTs: "111.222",
        streamingMode: "native" as const,
        toolStartedAtMs: {},
        toolLinesByCallId: {},
        toolCallOrder: []
      };
      const client = {
        chat: {
          startStream: async (input: {
            channel: string;
            thread_ts: string;
            markdown_text?: string;
          }) => {
            calls.push(`start:${input.channel}:${input.thread_ts}:${input.markdown_text}`);
            return { ts: "stream.123" };
          },
          appendStream: async (input: { ts: string; markdown_text: string }) => {
            calls.push(`append:${input.ts}:${input.markdown_text}`);
            return {};
          },
          stopStream: async (input: {
            ts: string;
            markdown_text?: string;
            blocks?: unknown[];
          }) => {
            calls.push(`stop:${input.ts}:${input.markdown_text ?? ""}`);
            return {};
          },
          update: async (input: { text: string }) => {
            calls.push(`update:${input.text}`);
            return {};
          }
        }
      };

      await updateAgentProgressMessage(client as never, progressMessage, {
        type: "message_delta",
        text: "Hello"
      });
      now += 100;
      await updateAgentProgressMessage(client as never, progressMessage, {
        type: "message_delta",
        text: " world"
      });
      now += 600;
      await updateAgentProgressMessage(client as never, progressMessage, {
        type: "message_delta",
        text: " again"
      });
      await postConversationResponse(client as never, {
        response: {
          visibility: "dm",
          classification: "user_private",
          text: "Hello world again",
          usage: {
            inputTokens: 2,
            outputTokens: 1,
            totalTokens: 3,
            usageSource: "provider-output"
          }
        },
        channel: "D123",
        user: "U123",
        progressMessage
      });

      expect(calls).toEqual([
        "start:D123:111.222:Hello",
        "append:stream.123: world again",
        "stop:stream.123:\n\n_Final result in 700ms (3 tokens)._",
        "update:_Final result in 700ms (3 tokens)._"
      ]);
    } finally {
      Date.now = originalNow;
    }
  });

  test("falls back to chat.update when Slack native stream start fails", async () => {
    const updates: string[] = [];
    const originalNow = Date.now;
    let now = 1_000;
    Date.now = () => now;
    try {
      const progressMessage = {
        channel: "D123",
        ts: "123.456",
        text: "Starting agent runtime...",
        startedAtMs: 0,
        threadTs: "111.222",
        streamingMode: "native" as const,
        toolStartedAtMs: {},
        toolLinesByCallId: {},
        toolCallOrder: []
      };
      const client = {
        chat: {
          startStream: async () => {
            throw new Error("missing_scope");
          },
          update: async (input: { text: string }) => {
            updates.push(input.text);
            return {};
          }
        }
      };

      await updateAgentProgressMessage(client as never, progressMessage, {
        type: "message_delta",
        text: "Hello"
      });
      now += 1_000;
      await updateAgentProgressMessage(client as never, progressMessage, {
        type: "message_delta",
        text: " world"
      });

      expect(updates).toEqual(["Hello", "Hello world"]);
      expect((progressMessage as { streamingMode?: string }).streamingMode).toBe(
        "basic"
      );
      expect(
        (progressMessage as { nativeStreamFallbackReason?: string })
          .nativeStreamFallbackReason
      ).toBe("missing_scope");
    } finally {
      Date.now = originalNow;
    }
  });

  test("uses in-place chat.update for native mode when there is no existing Slack thread", async () => {
    const calls: string[] = [];
    const progressMessage = {
      channel: "D123",
      ts: "123.456",
      text: "Starting agent runtime...",
      startedAtMs: 0,
      streamingMode: "native" as const,
      toolStartedAtMs: {},
      toolLinesByCallId: {},
      toolCallOrder: []
    };
    const client = {
      chat: {
        startStream: async () => {
          calls.push("start");
          return { ts: "stream.123" };
        },
        update: async (input: { text: string }) => {
          calls.push(`update:${input.text}`);
          return {};
        }
      }
    };

    await updateAgentProgressMessage(client as never, progressMessage, {
      type: "message_delta",
      text: "Hello in the DM"
    });

    expect(calls).toEqual(["update:Hello in the DM"]);
    expect((progressMessage as { streamingMode?: string }).streamingMode).toBe(
      "basic"
    );
    expect(
      (progressMessage as { nativeStreamFallbackReason?: string })
        .nativeStreamFallbackReason
    ).toBe("slack_native_stream_unthreaded");
  });

  test("falls back to in-place updates when an active native stream receives replacement text", async () => {
    const calls: string[] = [];
    const progressMessage = {
      channel: "D123",
      ts: "123.456",
      text: "Starting agent runtime...",
      startedAtMs: 0,
      threadTs: "111.222",
      streamingMode: "native" as const,
      nativeStreamTs: "stream.123",
      streamedText: "Hello world",
      toolStartedAtMs: {},
      toolLinesByCallId: {},
      toolCallOrder: []
    };
    const client = {
      chat: {
        stopStream: async (input: { ts: string; markdown_text?: string }) => {
          calls.push(`stop:${input.ts}:${input.markdown_text ?? ""}`);
          return {};
        },
        update: async (input: { text: string }) => {
          calls.push(`update:${input.text}`);
          return {};
        }
      }
    };

    await updateAgentProgressMessage(client as never, progressMessage, {
      type: "message_replace",
      text: "Rewritten answer"
    });

    expect(calls).toEqual([
      "stop:stream.123:_Response continued in the main message._",
      "update:Rewritten answer"
    ]);
    expect((progressMessage as { streamingMode?: string }).streamingMode).toBe(
      "basic"
    );
    expect(
      (progressMessage as { nativeStreamFallbackReason?: string })
        .nativeStreamFallbackReason
    ).toBe("slack_native_stream_replace_unsupported");
  });

  test("finalizes native streams that fell back after replacement through the basic path", async () => {
    const calls: string[] = [];
    const originalNow = Date.now;
    Date.now = () => 2_500;
    try {
      const progressMessage = {
        channel: "D123",
        ts: "123.456",
        text: "Rewritten answer and tail",
        startedAtMs: 1_000,
        threadTs: "111.222",
        streamingMode: "basic" as const,
        nativeStreamTs: "stream.123",
        nativeStreamStopped: true,
        nativeStreamFallbackReason: "slack_native_stream_replace_unsupported",
        streamedText: "Rewritten answer and tail",
        toolStartedAtMs: {},
        toolLinesByCallId: {},
        toolCallOrder: []
      };
      const client = {
        chat: {
          stopStream: async (input: { ts: string; markdown_text?: string }) => {
            calls.push(`stop:${input.ts}:${input.markdown_text ?? ""}`);
            return {};
          },
          update: async (input: { text: string }) => {
            calls.push(`update:${input.text}`);
            return {};
          },
          postMessage: async (input: { text: string }) => {
            calls.push(`post:${input.text}`);
            return {};
          }
        }
      };

      await postConversationResponse(client as never, {
        response: {
          visibility: "dm",
          classification: "user_private",
          text: "Rewritten answer and tail",
          usage: {
            inputTokens: 2,
            outputTokens: 1,
            totalTokens: 3,
            usageSource: "provider-output"
          }
        },
        channel: "D123",
        user: "U123",
        progressMessage
      });

      expect(calls).toEqual([
        "update:Rewritten answer and tail\n\n_Final result in 1.5s (3 tokens)._"
      ]);
    } finally {
      Date.now = originalNow;
    }
  });

  test("stops an active Slack native stream when a conversation fails", async () => {
    const calls: string[] = [];
    const progressMessage = {
      channel: "D123",
      ts: "123.456",
      text: "Starting agent runtime...",
      startedAtMs: 0,
      threadTs: "111.222",
      streamingMode: "native" as const,
      nativeStreamTs: "stream.123",
      streamedText: "Partial answer",
      toolStartedAtMs: {},
      toolLinesByCallId: {},
      toolCallOrder: []
    };
    const client = {
      chat: {
        stopStream: async (input: { ts: string; markdown_text?: string }) => {
          calls.push(`stop:${input.ts}:${input.markdown_text ?? ""}`);
          return {};
        },
        update: async (input: { text: string }) => {
          calls.push(`update:${input.text}`);
          return {};
        }
      }
    };

    await failAgentProgressMessage(
      client as never,
      progressMessage,
      "I could not handle that message."
    );

    expect(calls).toEqual([
      "stop:stream.123:\n\nI could not handle that message.",
      "update:I could not handle that message."
    ]);
  });
});

describe("buildAgentExecToolGroups", () => {
  test("selects provider tool groups for explicit agent exec tasks", () => {
    expect(
      buildAgentExecToolGroups(
        "create a cron job to list my latest GitHub PRs"
      )
    ).toEqual({
      groups: ["conversation", "github", "scheduler"],
      reasons: [
        "default:conversation",
        "keyword:github:github",
        "keyword:github:pr",
        "keyword:scheduler:cron"
      ]
    });
  });
});

describe("formatFinalProgressLine", () => {
  test("labels estimate-only usage so it is not confused with exact provider usage", () => {
    expect(
      formatFinalProgressLine(12_300, {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        usageSource: "estimate-only"
      })
    ).toBe("Final result in 12s (15 tokens, estimated).");
  });

  test("keeps provider-reported usage concise", () => {
    expect(
      formatFinalProgressLine(1200, {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        cachedInputTokens: 50,
        reasoningTokens: 10,
        usageSource: "provider-output"
      })
    ).toBe("Final result in 1.2s (120 tokens, 50 cached, 10 reasoning).");
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
    expect(parseAgentCommand("config get model")).toEqual({
      kind: "config_get",
      key: "model"
    });
    expect(parseAgentCommand("config get")).toEqual({ kind: "config_get" });
    expect(parseAgentCommand("get memory")).toEqual({
      kind: "config_get",
      key: "memory"
    });
    expect(parseAgentCommand("config set model gpt-5.4-mini")).toEqual({
      kind: "config_set",
      key: "model",
      value: "gpt-5.4-mini"
    });
    expect(parseAgentCommand("set memory off")).toEqual({
      kind: "config_set",
      key: "memory",
      value: "off"
    });
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
      hubspotUrl: "https://example.test/hubspot",
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
        hubspot: {
          provider: "hubspot",
          email: "person@example.com",
          slackUserId: "U123",
          providerLogin: "hubspot-user@example.com",
          accessToken: "hubspot-token",
          connectedAt: "2026-05-26T00:00:00.000Z"
        },
        jira: {
          provider: "jira",
          email: "person@example.com",
          slackUserId: "U123",
          providerLogin: "person@example.com",
          accessToken: "jira-token",
          connectedAt: "2026-05-26T00:00:00.000Z"
        },
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
    expect(JSON.stringify(response.blocks)).toContain("HubSpot");
    expect(JSON.stringify(response.blocks)).toContain("Atlassian");
    expect(JSON.stringify(response.blocks)).toContain("Slack search");
    expect(JSON.stringify(response.blocks)).toContain("Connected as `octocat`");
    expect(JSON.stringify(response.blocks)).toContain("Connected as `hubspot-user@example.com`");
    expect(JSON.stringify(response.blocks)).toContain("Connected as `person@example.com`");
    expect(JSON.stringify(response.blocks)).toContain("Connected as <@U123>");
    expect(JSON.stringify(response.blocks)).toContain("Not connected");
    expect(JSON.stringify(response.blocks)).toContain("provider_disconnect");
    expect(JSON.stringify(response.blocks)).toContain("\"style\":\"danger\"");
    expect(JSON.stringify(response.blocks)).toContain("\"value\":\"github\"");
    expect(JSON.stringify(response.blocks)).toContain("\"value\":\"hubspot\"");
    expect(JSON.stringify(response.blocks)).toContain("\"value\":\"jira\"");
    expect(JSON.stringify(response.blocks)).toContain("\"value\":\"slack\"");
    expect(JSON.stringify(response.blocks)).toContain("https://example.test/github");
    expect(JSON.stringify(response.blocks)).toContain("https://example.test/google");
    expect(JSON.stringify(response.blocks)).toContain("https://example.test/hubspot");
    expect(JSON.stringify(response.blocks)).toContain("https://example.test/jira");
    expect(JSON.stringify(response.blocks)).toContain("https://example.test/slack");
  });

  test("marks Jira unavailable when no Jira OAuth URL is configured", () => {
    const response = buildAuthResponse({
      githubUrl: "https://example.test/github",
      googleUrl: null,
      hubspotUrl: null,
      jiraUrl: null,
      slackUrl: null
    });

    expect(JSON.stringify(response.blocks)).toContain("Google OAuth is not configured");
    expect(JSON.stringify(response.blocks)).toContain("HubSpot OAuth is not configured");
    expect(JSON.stringify(response.blocks)).toContain("Jira OAuth is not configured");
    expect(JSON.stringify(response.blocks)).toContain("Slack OAuth is not configured");
  });
});

describe("buildAppHomeView", () => {
  test("builds a Block Kit Home tab with provider statuses and connect buttons", () => {
    const store = createTokenStore(":memory:");
    store.getOrCreateAgentRuntime({
      workspaceId: "T123",
      slackUserId: "U123",
      engine: "burble-direct",
      endpointUrl: "http://runtime:8080",
      authTokenHash: "hash",
      statePath: "/data/state",
      configPath: "/data/config/runtime.json",
      workspacePath: "/data/workspace",
      policyHash: "policy-home"
    });
    const agentSettings = buildAgentHomeSettings({
      config: agentConfig,
      store,
      workspaceId: "T123",
      slackUserId: "U123"
    });
    const view = buildAppHomeView({
      githubUrl: "https://example.test/github",
      googleUrl: "https://example.test/google",
      hubspotUrl: "https://example.test/hubspot",
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
        hubspot: {
          provider: "hubspot",
          email: "person@example.com",
          slackUserId: "U123",
          providerLogin: "hubspot-user@example.com",
          accessToken: "hubspot-token",
          connectedAt: "2026-05-26T00:00:00.000Z"
        },
        jira: {
          provider: "jira",
          email: "person@example.com",
          slackUserId: "U123",
          providerLogin: "person@example.com",
          accessToken: "jira-token",
          connectedAt: "2026-05-26T00:00:00.000Z"
        },
        slack: null
      },
      agentSettings
    });
    const serialized = JSON.stringify(view);

    expect(view.type).toBe("home");
    expect(serialized).toContain("GitHub");
    expect(serialized).toContain("Google Workspace");
    expect(serialized).toContain("HubSpot");
    expect(serialized).toContain("Atlassian Jira");
    expect(serialized).toContain("Slack search");
    expect(serialized).toContain("Connected as `octocat`");
    expect(serialized).toContain("Connected as `person@example.com`");
    expect(serialized).toContain("Connected as `hubspot-user@example.com`");
    expect(serialized).toContain("Not connected");
    expect(serialized).toContain("https://example.test/google");
    expect(serialized).toContain("Agent runtime");
    expect(serialized).toContain("User auth");
    expect(serialized).toContain("Details");
    expect(serialized).toContain("agent_runtime_manage");
    expect(serialized).toContain("Refresh");
    expect(serialized).toContain("agent_runtime_refresh");
    expect(serialized).toContain("agent_runtime_pause");
    expect(serialized).toContain("agent_runtime_restart");
    expect(serialized).toContain("provider_disconnect");
    expect(serialized).toContain("\"style\":\"danger\"");
    expect(serialized).toContain("Runtime settings");
    expect(serialized).toContain("Edit settings");
    expect(serialized).toContain("agent_config_edit");
    expect(serialized).toContain("openai:gpt-5.4");
  });

  test("shows a runtime selector when multiple engines are selectable", () => {
    const store = createTokenStore(":memory:");
    store.upsertWorkspacePolicy({
      workspaceId: "T123",
      key: "runtime.allowedEngines",
      value: ["burble-direct", "hermes"],
      updatedBySlackUserId: "UADMIN"
    });
    const agentSettings = buildAgentHomeSettings({
      config: agentConfig,
      store,
      workspaceId: "T123",
      slackUserId: "U123"
    });
    const view = buildAppHomeView({
      githubUrl: "https://example.test/github",
      googleUrl: "https://example.test/google",
      hubspotUrl: "https://example.test/hubspot",
      jiraUrl: "https://example.test/jira",
      slackUrl: "https://example.test/slack",
      connections: {
        github: null,
        google: null,
        hubspot: null,
        jira: null,
        slack: null
      },
      agentSettings
    });
    const serialized = JSON.stringify(view);

    expect(serialized).toContain("agent_runtime_engine_select");
    expect(serialized).toContain("Choose runtime");
    expect(serialized).toContain("\"value\":\"burble-direct\"");
    expect(serialized).toContain("\"value\":\"hermes\"");
    store.close();
  });

  test("shows first-time guidance before connections and runtime provisioning", () => {
    const store = createTokenStore(":memory:");
    const agentSettings = buildAgentHomeSettings({
      config: agentConfig,
      store,
      workspaceId: "T123",
      slackUserId: "U123"
    });
    const view = buildAppHomeView({
      githubUrl: "https://example.test/github",
      googleUrl: "https://example.test/google",
      hubspotUrl: "https://example.test/hubspot",
      jiraUrl: "https://example.test/jira",
      slackUrl: "https://example.test/slack",
      connections: {
        github: null,
        google: null,
        hubspot: null,
        jira: null,
        slack: null
      },
      agentSettings
    });
    const serialized = JSON.stringify(view);

    expect(serialized).toContain("Start by connecting");
    expect(serialized).toContain("message Burble directly");
    expect(serialized).toContain("User auth");
    store.close();
  });

  test("builds an agent settings modal from effective config", () => {
    const store = createTokenStore(":memory:");
    store.upsertUserPreference({
      workspaceId: "T123",
      slackUserId: "U123",
      key: "memory.user",
      value: { enabled: true }
    });
    const view = buildAgentConfigModalView({
      config: agentConfig,
      store,
      workspaceId: "T123",
      slackUserId: "U123"
    });
    const serialized = JSON.stringify(view);

    expect(view.type).toBe("modal");
    expect(serialized).toContain("agent_config_submit");
    expect(serialized).toContain("agent_config_model");
    expect(serialized).toContain("openai:gpt-5.4");
    expect(serialized).toContain("agent_config_memory");
    expect(serialized).toContain("agent_config_streaming");
    expect(serialized).toContain("\"value\":\"native\"");
    expect(serialized).toContain("\"value\":\"basic\"");
    expect(serialized).toContain("\"value\":\"off\"");
  });

  test("omits allowed but incompatible runtime engines from the settings modal", () => {
    const store = createTokenStore(":memory:");
    store.upsertWorkspacePolicy({
      workspaceId: "T123",
      key: "runtime.allowedEngines",
      value: ["burble-direct", "deterministic"],
      updatedBySlackUserId: "UADMIN"
    });
    const view = buildAgentConfigModalView({
      config: agentConfig,
      store,
      workspaceId: "T123",
      slackUserId: "U123"
    });
    const serialized = JSON.stringify(view);

    expect(serialized).toContain("\"value\":\"burble-direct\"");
    expect(serialized).not.toContain("\"value\":\"deterministic\"");
    store.close();
  });

  test("builds an agent runtime management modal", () => {
    const store = createTokenStore(":memory:");
    const runtime = store.getOrCreateAgentRuntime({
      workspaceId: "T123",
      slackUserId: "U123",
      engine: "burble-direct",
      endpointUrl: "http://runtime:8080",
      authTokenHash: "hash",
      statePath: "/data/state",
      configPath: "/data/config/runtime.json",
      workspacePath: "/data/workspace",
      policyHash: "policy-modal"
    });
    const view = buildAgentRuntimeManageModalView({
      config: agentConfig,
      store,
      workspaceId: "T123",
      slackUserId: "U123"
    });
    const serialized = JSON.stringify(view);

    expect(view.type).toBe("modal");
    expect(serialized).toContain("Agent runtime");
    expect(serialized).toContain(runtime.id);
    expect(serialized).toContain("http://runtime:8080");
    expect(serialized).toContain("openai:gpt-5.4");
    expect(serialized).toContain("Policy hash");
  });

  test("starts, pauses, and restarts the current agent runtime", async () => {
    const store = createTokenStore(":memory:");
    const stopped: string[] = [];
    const started: string[] = [];
    let nextRuntimeId = 1;
    const runtimeFactory = {
      async getOrCreateRuntime(principal: {
        workspaceId: string;
        slackUserId: string;
      }) {
        started.push(`${principal.workspaceId}:${principal.slackUserId}`);
        return {
          id: `rt_${nextRuntimeId++}`,
          engine: "burble-direct" as const,
          endpointUrl: "http://runtime:8080",
          authToken: "token",
          status: "ready" as const,
          statePath: "/data/state",
          configPath: "/data/config/runtime.json",
          workspacePath: "/data/workspace"
        };
      },
      async stopRuntime(runtimeId: string) {
        stopped.push(runtimeId);
        store.updateAgentRuntimeStatus(runtimeId, { status: "stopped" });
      },
      async reapIdleRuntimes() {}
    };

    const startedResult = await applyAgentRuntimeControl({
      config: agentConfig,
      store,
      runtimeFactory,
      workspaceId: "T123",
      slackUserId: "U123",
      action: "start"
    });
    expect(startedResult).toMatchObject({
      action: "start",
      runtimeId: "rt_1",
      status: "ready"
    });

    const runtime = store.getOrCreateAgentRuntime({
      workspaceId: "T123",
      slackUserId: "U123",
      engine: "burble-direct",
      endpointUrl: "http://runtime:8080",
      authTokenHash: "hash",
      statePath: "/data/state",
      configPath: "/data/config/runtime.json",
      workspacePath: "/data/workspace",
      policyHash: "policy"
    });

    const pausedResult = await applyAgentRuntimeControl({
      config: agentConfig,
      store,
      runtimeFactory,
      workspaceId: "T123",
      slackUserId: "U123",
      action: "pause"
    });
    expect(pausedResult).toMatchObject({
      action: "pause",
      runtimeId: runtime.id,
      status: "stopped"
    });

    const restartedResult = await applyAgentRuntimeControl({
      config: agentConfig,
      store,
      runtimeFactory,
      workspaceId: "T123",
      slackUserId: "U123",
      action: "restart"
    });
    expect(restartedResult).toMatchObject({
      action: "restart",
      runtimeId: "rt_2",
      status: "ready"
    });
    expect(started).toEqual(["T123:U123", "T123:U123"]);
    expect(stopped).toEqual([runtime.id]);
  });

  test("pauses the effective preferred runtime engine", async () => {
    const store = createTokenStore(":memory:");
    store.upsertWorkspacePolicy({
      workspaceId: "T123",
      key: "runtime.allowedEngines",
      value: ["burble-direct", "hermes"],
      updatedBySlackUserId: "UADMIN"
    });
    store.upsertUserPreference({
      workspaceId: "T123",
      slackUserId: "U123",
      key: "runtime.engine",
      value: "hermes"
    });
    const runtime = store.getOrCreateAgentRuntime({
      workspaceId: "T123",
      slackUserId: "U123",
      engine: "hermes",
      endpointUrl: "http://hermes-runtime:8080",
      authTokenHash: "hash",
      statePath: "/data/state",
      configPath: "/data/config/hermes.json",
      workspacePath: "/data/workspace",
      policyHash: "policy"
    });
    const stopped: string[] = [];

    const result = await applyAgentRuntimeControl({
      config: agentConfig,
      store,
      runtimeFactory: {
        async getOrCreateRuntime() {
          throw new Error("unexpected start");
        },
        async stopRuntime(runtimeId) {
          stopped.push(runtimeId);
          store.updateAgentRuntimeStatus(runtimeId, { status: "stopped" });
        },
        async reapIdleRuntimes() {}
      },
      workspaceId: "T123",
      slackUserId: "U123",
      action: "pause"
    });

    expect(result).toMatchObject({
      action: "pause",
      runtimeId: runtime.id,
      status: "stopped"
    });
    expect(stopped).toEqual([runtime.id]);
    store.close();
  });

  test("selects one active runtime engine from App Home", async () => {
    const store = createTokenStore(":memory:");
    store.upsertWorkspacePolicy({
      workspaceId: "T123",
      key: "runtime.allowedEngines",
      value: ["burble-direct", "hermes"],
      updatedBySlackUserId: "UADMIN"
    });
    const previousRuntime = store.getOrCreateAgentRuntime({
      workspaceId: "T123",
      slackUserId: "U123",
      engine: "burble-direct",
      endpointUrl: "http://direct-runtime:8080",
      authTokenHash: "hash",
      statePath: "/data/state",
      configPath: "/data/config/openclaw.json",
      workspacePath: "/data/workspace",
      policyHash: "policy-old"
    });
    const stopped: string[] = [];
    const started: string[] = [];
    const events: string[] = [];
    const result = await applyAgentRuntimeEngineSelection({
      config: agentConfig,
      store,
      runtimeFactory: {
        async getOrCreateRuntime(principal) {
          events.push(`start:${principal.workspaceId}:${principal.slackUserId}`);
          started.push(`${principal.workspaceId}:${principal.slackUserId}`);
          const runtime = store.getOrCreateAgentRuntime({
            workspaceId: principal.workspaceId,
            slackUserId: principal.slackUserId,
            engine: "hermes",
            endpointUrl: "http://hermes-runtime:8080",
            authTokenHash: "hash",
            statePath: "/data/state",
            configPath: "/data/config/hermes.json",
            workspacePath: "/data/workspace",
            policyHash: "policy-new"
          });
          return {
            id: runtime.id,
            engine: runtime.engine,
            endpointUrl: runtime.endpointUrl,
            authToken: "runtime-token",
            status: "ready",
            statePath: runtime.statePath,
            configPath: runtime.configPath,
            workspacePath: runtime.workspacePath
          };
        },
        async stopRuntime(runtimeId) {
          events.push(`stop:${runtimeId}`);
          stopped.push(runtimeId);
          store.updateAgentRuntimeStatus(runtimeId, { status: "stopped" });
        },
        async reapIdleRuntimes() {}
      },
      principal: {
        workspaceId: "T123",
        slackUserId: "U123"
      },
      engine: "hermes",
      afterPreferenceSaved: () => {
        events.push(
          `saved:${store.getUserPreference("T123", "U123", "runtime.engine")?.value}`
        );
        const settings = buildAgentHomeSettings({
          config: agentConfig,
          store,
          workspaceId: "T123",
          slackUserId: "U123"
        });
        expect(settings.runtime.engine).toBe("hermes");
        expect(settings.runtime.status).toBe("not provisioned");
      }
    });

    expect(result.policyChanged).toBe(true);
    expect(result.restart?.stoppedRuntimeId).toBe(previousRuntime.id);
    expect(stopped).toEqual([previousRuntime.id]);
    expect(started).toEqual(["T123:U123"]);
    expect(events).toEqual([
      "saved:hermes",
      `stop:${previousRuntime.id}`,
      "start:T123:U123"
    ]);
    expect(
      store.getUserPreference("T123", "U123", "runtime.engine")?.value
    ).toBe("hermes");
    store.close();
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
    expect(blocks).toContain("burble-runtime");
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
        policyHash: "policy-hash",
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

  test("shows the effective preferred runtime engine when allowed", () => {
    const store = createTokenStore(":memory:");
    store.upsertWorkspacePolicy({
      workspaceId: "T123",
      key: "runtime.allowedEngines",
      value: ["burble-direct", "hermes"],
      updatedBySlackUserId: "UADMIN"
    });
    store.upsertUserPreference({
      workspaceId: "T123",
      slackUserId: "U123",
      key: "runtime.engine",
      value: "hermes"
    });
    store.getOrCreateAgentRuntime({
      workspaceId: "T123",
      slackUserId: "U123",
      engine: "hermes",
      endpointUrl: "http://hermes-runtime:8080",
      authTokenHash: "hash",
      statePath: "/data/state",
      configPath: "/data/config/hermes.json",
      workspacePath: "/data/workspace",
      policyHash: "policy"
    });

    const settings = buildAgentHomeSettings({
      config: agentConfig,
      store,
      workspaceId: "T123",
      slackUserId: "U123"
    });
    const blocks = JSON.stringify(
      buildAgentRuntimeManageModalView({
        config: agentConfig,
        store,
        workspaceId: "T123",
        slackUserId: "U123"
      }).blocks
    );

    expect(settings.runtime.engine).toBe("hermes");
    expect(settings.runtime.preferredEngine).toBe("hermes");
    expect(settings.runtime.allowedEngines).toEqual(["burble-direct", "hermes"]);
    expect(settings.runtime.selectableEngines).toEqual([
      "burble-direct",
      "hermes"
    ]);
    expect(blocks).toContain("http://hermes-runtime:8080");
    expect(blocks).toContain("Preferred engine");
    expect(blocks).toContain("Selectable engines");
    store.close();
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
      policyHash: "policy-hash",
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
      policyHash: "policy-hash",
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

describe("agent user config commands", () => {
  test("sets and reads user model and memory preferences", () => {
    const store = createTokenStore(":memory:");

    const modelResponse = applyAgentUserConfigSet({
      config: agentConfig,
      store,
      workspaceId: "T123",
      slackUserId: "U123",
      key: "model",
      value: "gpt-5.4-mini"
    });
    expect(modelResponse.text).toContain("Updated `model`");
    expect(
      store.getUserPreference("T123", "U123", "runtime.model")?.value
    ).toBe("openai:gpt-5.4-mini");

    const memoryResponse = applyAgentUserConfigSet({
      config: agentConfig,
      store,
      workspaceId: "T123",
      slackUserId: "U123",
      key: "memory",
      value: "on"
    });
    expect(memoryResponse.text).toContain("Updated `memory`");
    expect(
      store.getUserPreference("T123", "U123", "memory.user")?.value
    ).toEqual({ enabled: true });

    const streamingResponse = applyAgentUserConfigSet({
      config: agentConfig,
      store,
      workspaceId: "T123",
      slackUserId: "U123",
      key: "streaming",
      value: "basic"
    });
    expect(streamingResponse.text).toContain("Updated `streaming`");
    expect(
      store.getUserPreference("T123", "U123", "runtime.streaming")?.value
    ).toBe("basic");

    const getResponse = buildAgentUserConfigGetResponse({
      config: agentConfig,
      store,
      workspaceId: "T123",
      slackUserId: "U123"
    });
    expect(getResponse.text).toContain("openai:gpt-5.4-mini");
    expect(getResponse.text).toContain("User memory: `on`");
    expect(getResponse.text).toContain("Streaming: `basic`");
  });

  test("sets and reads the user runtime engine preference", () => {
    const store = createTokenStore(":memory:");
    store.upsertWorkspacePolicy({
      workspaceId: "T123",
      key: "runtime.allowedEngines",
      value: ["burble-direct", "hermes"],
      updatedBySlackUserId: "UADMIN"
    });

    const response = applyAgentUserConfigSet({
      config: agentConfig,
      store,
      workspaceId: "T123",
      slackUserId: "U123",
      key: "runtime.engine",
      value: "hermes"
    });
    expect(response.text).toContain("Updated `runtime.engine`");
    expect(
      store.getUserPreference("T123", "U123", "runtime.engine")?.value
    ).toBe("hermes");

    const getResponse = buildAgentUserConfigGetResponse({
      config: agentConfig,
      store,
      workspaceId: "T123",
      slackUserId: "U123",
      key: "runtime.engine"
    });
    expect(getResponse.text).toContain("Effective: `hermes`");
    expect(getResponse.text).toContain("Stored preference: `hermes`");
    store.close();
  });

  test("selects runtime images without dropping pinned custom images", () => {
    const customConfig = {
      ...agentConfig,
      agentRuntimeImage: "ghcr.io/acme/burble-runtime:prod"
    };
    const openClawCliDefaultConfig = {
      ...agentConfig,
      agentRuntimeImage: "burble-openclaw-nemoclaw-openclaw-cli:dev"
    };

    expect(runtimeImageForEngine(customConfig, "burble-direct")).toBe(
      "ghcr.io/acme/burble-runtime:prod"
    );
    expect(runtimeImageForEngine(customConfig, "hermes")).toBe(
      "ghcr.io/acme/burble-runtime:prod"
    );
    expect(runtimeImageForEngine(openClawCliDefaultConfig, "hermes")).toBe(
      "burble-nemo-hermes:dev"
    );
    expect(runtimeImageForEngine(agentConfig, "hermes")).toBe(
      "burble-nemo-hermes:dev"
    );
  });

  test("rejects runtime engine preferences outside workspace policy", () => {
    const store = createTokenStore(":memory:");

    const response = applyAgentUserConfigSet({
      config: agentConfig,
      store,
      workspaceId: "T123",
      slackUserId: "U123",
      key: "runtime.engine",
      value: "hermes"
    });

    expect(response.text).toContain("not allowed in this workspace");
    expect(
      store.getUserPreference("T123", "U123", "runtime.engine")
    ).toBeNull();
    store.close();
  });

  test("rejects allowed runtime engine preferences that fail compatibility", () => {
    const store = createTokenStore(":memory:");
    store.upsertWorkspacePolicy({
      workspaceId: "T123",
      key: "runtime.allowedEngines",
      value: ["burble-direct", "deterministic"],
      updatedBySlackUserId: "UADMIN"
    });

    const response = applyAgentUserConfigSet({
      config: agentConfig,
      store,
      workspaceId: "T123",
      slackUserId: "U123",
      key: "runtime.engine",
      value: "deterministic"
    });

    expect(response.text).toContain("is not selectable yet");
    expect(response.text).toContain("missing usage reporting");
    expect(
      store.getUserPreference("T123", "U123", "runtime.engine")
    ).toBeNull();
    store.close();
  });

  test("validates modal runtime engine selections against current policy", () => {
    const store = createTokenStore(":memory:");
    store.upsertWorkspacePolicy({
      workspaceId: "T123",
      key: "runtime.allowedEngines",
      value: ["burble-direct", "deterministic"],
      updatedBySlackUserId: "UADMIN"
    });
    const selection = resolveRuntimeEngineForPrincipal({
      config: agentConfig,
      store,
      principal: {
        workspaceId: "T123",
        slackUserId: "U123"
      }
    });

    expect(validateAgentRuntimeEngineSelection(selection, "hermes")).toMatchObject({
      modalError:
        "Runtime engine hermes is no longer allowed in this workspace."
    });
    expect(
      validateAgentRuntimeEngineSelection(selection, "deterministic")
    ).toMatchObject({
      modalError: "Runtime engine deterministic is not selectable: missing usage reporting."
    });
    expect(
      validateAgentRuntimeEngineSelection(selection, "burble-direct")
    ).toBeNull();
    store.close();
  });

  test("supports disabling and enabling a user-scoped tool", () => {
    const store = createTokenStore(":memory:");

    const disableResponse = applyAgentUserConfigSet({
      config: agentConfig,
      store,
      workspaceId: "T123",
      slackUserId: "U123",
      key: "disable-tool",
      value: "github_create_pr"
    });
    expect(disableResponse.text).toContain("Disabled tool `github_create_pr`");
    expect(
      store.getUserPreference("T123", "U123", "tools.disabled")?.value
    ).toEqual(["github_create_pr"]);

    const enableResponse = applyAgentUserConfigSet({
      config: agentConfig,
      store,
      workspaceId: "T123",
      slackUserId: "U123",
      key: "enable-tool",
      value: "github_create_pr"
    });
    expect(enableResponse.text).toContain("Enabled tool `github_create_pr`");
    expect(
      store.getUserPreference("T123", "U123", "tools.disabled")?.value
    ).toEqual([]);
  });

  test("rejects unsupported user config keys", () => {
    const store = createTokenStore(":memory:");
    const response = applyAgentUserConfigSet({
      config: agentConfig,
      store,
      workspaceId: "T123",
      slackUserId: "U123",
      key: "workspace.policy",
      value: "anything"
    });

    expect(response.text).toContain("Unknown user config key");
  });

  test("restarts the current runtime when user config changes the manifest hash", async () => {
    const store = createTokenStore(":memory:");
    const runtime = store.getOrCreateAgentRuntime({
      workspaceId: "T123",
      slackUserId: "U123",
      engine: "burble-direct",
      endpointUrl: "http://runtime:8080",
      authTokenHash: "hash",
      statePath: "/data/state",
      configPath: "/data/config/runtime.json",
      workspacePath: "/data/workspace",
      policyHash: "policy-old"
    });
    const stopped: string[] = [];
    const started: string[] = [];

    const restart = await restartAgentRuntimeIfConfigChanged({
      config: agentConfig,
      store,
      runtimeFactory: {
        async getOrCreateRuntime(principal) {
          started.push(`${principal.workspaceId}:${principal.slackUserId}`);
          return {
            id: "rt_fresh",
            engine: "burble-direct",
            endpointUrl: "http://runtime:8080",
            authToken: "token",
            status: "ready",
            statePath: "/data/state",
            configPath: "/data/config/runtime.json",
            workspacePath: "/data/workspace"
          };
        },
        async stopRuntime(runtimeId) {
          stopped.push(runtimeId);
        },
        async reapIdleRuntimes() {}
      },
      principal: { workspaceId: "T123", slackUserId: "U123" },
      previousPolicyHash: "policy-old",
      nextPolicyHash: "policy-new"
    });

    expect(restart).toEqual({
      stoppedRuntimeId: runtime.id,
      startedRuntimeId: "rt_fresh"
    });
    expect(stopped).toEqual([runtime.id]);
    expect(started).toEqual(["T123:U123"]);
  });

  test("stops the previous engine runtime when runtime preference changes", async () => {
    const store = createTokenStore(":memory:");
    store.upsertWorkspacePolicy({
      workspaceId: "T123",
      key: "runtime.allowedEngines",
      value: ["burble-direct", "hermes"],
      updatedBySlackUserId: "UADMIN"
    });
    const runtime = store.getOrCreateAgentRuntime({
      workspaceId: "T123",
      slackUserId: "U123",
      engine: "burble-direct",
      endpointUrl: "http://runtime:8080",
      authTokenHash: "hash",
      statePath: "/data/state",
      configPath: "/data/config/runtime.json",
      workspacePath: "/data/workspace",
      policyHash: "policy-old"
    });
    store.upsertUserPreference({
      workspaceId: "T123",
      slackUserId: "U123",
      key: "runtime.engine",
      value: "hermes"
    });
    const stopped: string[] = [];

    const restart = await restartAgentRuntimeIfConfigChanged({
      config: agentConfig,
      store,
      runtimeFactory: {
        async getOrCreateRuntime() {
          return {
            id: "rt_hermes",
            engine: "hermes",
            endpointUrl: "http://hermes-runtime:8080",
            authToken: "token",
            status: "ready",
            statePath: "/data/hermes-state",
            configPath: "/data/config/hermes.json",
            workspacePath: "/data/hermes-workspace"
          };
        },
        async stopRuntime(runtimeId) {
          stopped.push(runtimeId);
        },
        async reapIdleRuntimes() {}
      },
      principal: { workspaceId: "T123", slackUserId: "U123" },
      previousPolicyHash: "policy-old",
      nextPolicyHash: "policy-new",
      previousEngine: "burble-direct"
    });

    expect(restart).toEqual({
      stoppedRuntimeId: runtime.id,
      startedRuntimeId: "rt_hermes"
    });
    expect(stopped).toEqual([runtime.id]);
    store.close();
  });

  test("does not stop runtime when user config keeps the same manifest hash", async () => {
    const store = createTokenStore(":memory:");
    store.getOrCreateAgentRuntime({
      workspaceId: "T123",
      slackUserId: "U123",
      engine: "burble-direct",
      endpointUrl: "http://runtime:8080",
      authTokenHash: "hash",
      statePath: "/data/state",
      configPath: "/data/config/runtime.json",
      workspacePath: "/data/workspace",
      policyHash: "policy-old"
    });
    const stopped: string[] = [];

    const restart = await restartAgentRuntimeIfConfigChanged({
      config: agentConfig,
      store,
      runtimeFactory: {
        async getOrCreateRuntime() {
          throw new Error("not used");
        },
        async stopRuntime(runtimeId) {
          stopped.push(runtimeId);
        },
        async reapIdleRuntimes() {}
      },
      principal: { workspaceId: "T123", slackUserId: "U123" },
      previousPolicyHash: "policy-old",
      nextPolicyHash: "policy-old"
    });

    expect(restart).toBeNull();
    expect(stopped).toEqual([]);
  });

  test("formats runtime restart status after config changes", () => {
    expect(
      buildAgentConfigRuntimeRestartResponse({
        stoppedRuntimeId: "rt_old",
        startedRuntimeId: "rt_123"
      }).text
    ).toContain(
      "Agent runtime restarted"
    );
    expect(buildAgentConfigRuntimeRestartResponse(null).text).toContain(
      "No live agent runtime"
    );

    const failure = buildAgentConfigRuntimeRestartFailureResponse(
      new Error("docker unavailable")
    );
    expect(failure.text).toContain("Config saved");
    expect(failure.text).toContain("docker unavailable");
  });

  test("detects direct-message slash commands for visible config replies", () => {
    expect(
      isDirectMessageSlashCommand({
        channel_id: "D123",
        channel_name: "directmessage"
      })
    ).toBe(true);
    expect(
      isDirectMessageSlashCommand({
        channel_id: "C123",
        channel_name: "general"
      })
    ).toBe(false);
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
