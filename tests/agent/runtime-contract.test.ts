import { describe, expect, test } from "bun:test";
import {
  parseRuntimeCapabilityManifest,
  parseRuntimeRunEvent,
  parseRuntimeRunRequest,
  runtimeRunEventSchema
} from "../../src/agent/runtime-contract";

const baseRunRequest = {
  runId: "run-123",
  executionMode: "default",
  principal: {
    workspaceId: "T123",
    slackUserId: "U123"
  },
  runtime: {
    id: "rt_123",
    engine: "hermes",
    policyHash: "abc123",
    manifest: {
      version: "1",
      policyHash: "abc123",
      skills: [{ id: "core", version: "1", enabled: true }],
      memory: {
        userMemoryEnabled: true,
        workspaceMemoryEnabled: false,
        jobMemoryEnabled: true
      }
    }
  },
  input: {
    text: "summarize my last PR",
    toolGroups: {
      groups: ["github", "conversation"],
      reasons: ["GitHub lookup", "reply delivery"]
    },
    scheduledJob: {
      jobId: "job-123",
      capabilityProfile: "scheduled_job",
      allowedTools: ["github_list_my_pull_requests"],
      routeId: "convrt_123",
      runtimeType: "hermes",
      stateRefs: [
        {
          provider: "google",
          kind: "drive_file",
          id: "drive-file-1",
          purpose: "dedupe"
        }
      ],
      visibilityPolicy: {
        maxOutputVisibility: "user_private",
        allowPrivateToolDeclassification: false
      }
    },
    attachments: [
      {
        id: "att-1",
        kind: "file",
        mimeType: "text/plain",
        source: "slack",
        name: "note.txt"
      }
    ],
    conversation: {
      routeId: "convrt_123",
      source: "slack",
      workspaceId: "T123",
      channelId: "D123",
      rootId: "1780000000.000001",
      isDirectMessage: true
    },
    context: {
      currentChannel: {
        id: "D123",
        isDirectMessage: true,
        historyAvailable: true
      },
      recentMessages: [
        {
          author: "user",
          speaker: "Leo",
          text: "what was my last PR?"
        }
      ]
    },
    connections: {
      github: {
        connected: true,
        email: "leo@example.com",
        providerLogin: "lbelyaev"
      },
      google: { connected: false },
      jira: { connected: true, providerLogin: "Leo" },
      slack: { connected: true, providerLogin: "@leo" }
    }
  }
};

describe("runtime contract schemas", () => {
  test("parses a portable runtime run request", () => {
    const request = parseRuntimeRunRequest(baseRunRequest);

    expect(request.runtime.engine).toBe("hermes");
    expect(request.input.toolGroups?.groups).toEqual(["github", "conversation"]);
    expect(request.input.scheduledJob?.allowedTools).toEqual([
      "github_list_my_pull_requests"
    ]);
  });

  test("rejects runtime run requests without a non-empty user request", () => {
    expect(() =>
      parseRuntimeRunRequest({
        ...baseRunRequest,
        input: { ...baseRunRequest.input, text: "" }
      })
    ).toThrow("Invalid runtime run request");
  });

  test("parses every supported runtime event shape", () => {
    const events = [
      { type: "status", text: "Agent is thinking..." },
      { type: "message_delta", text: "Hello" },
      {
        type: "tool_call",
        toolName: "github_list_my_pull_requests",
        callId: "call-1",
        input: { limit: 3 }
      },
      {
        type: "tool_result",
        toolName: "github_list_my_pull_requests",
        callId: "call-1",
        classification: "user_private",
        content: [{ title: "Runtime contract" }]
      },
      {
        type: "usage",
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cachedInputTokens: 50,
          reasoningTokens: 5,
          totalTokens: 175,
          usageSource: "provider-output"
        }
      },
      { type: "heartbeat", status: "ready" },
      {
        type: "final",
        response: {
          classification: "user_private",
          text: "Done.",
          usage: { totalTokens: 175 }
        }
      },
      { type: "error", message: "Provider failed." }
    ];

    expect(events.map(parseRuntimeRunEvent).map((event) => event.type)).toEqual([
      "status",
      "message_delta",
      "tool_call",
      "tool_result",
      "usage",
      "heartbeat",
      "final",
      "error"
    ]);
  });

  test("rejects unknown runtime event types", () => {
    expect(runtimeRunEventSchema.safeParse({ type: "debug", text: "x" }).success).toBe(
      false
    );
  });

  test("parses runtime capability manifests for selectable runtimes", () => {
    const manifest = parseRuntimeCapabilityManifest({
      runtimeType: "openclaw-gateway",
      version: "2026.6.1",
      transports: ["http", "sse", "websocket"],
      streaming: true,
      cancellation: true,
      nativeScheduler: true,
      scheduledProviderCalls: true,
      toolCalls: true,
      toolBridgeModes: ["mcp", "tool_gateway"],
      usageReporting: "exact",
      multimodalInput: true,
      multimodalOutput: false,
      memory: true,
      durableWorkflowState: false,
      attachments: true,
      conversationSend: true,
      jobScopedAuth: true
    });

    expect(manifest.runtimeType).toBe("openclaw-gateway");
    expect(manifest.toolBridgeModes).toEqual(["mcp", "tool_gateway"]);
  });
});
