import { describe, expect, test } from "bun:test";
import { parseRuntimeCapabilityManifest } from "../../../src/agent/runtime-contract";
import { handleRuntimeRequest } from "../../../runtimes/burble-native/src/server";
import { createBurbleNativeToolExecutor } from "../../../runtimes/burble-native/src/tools";
import type { ToolExecutor } from "../../../runtimes/burble-native/src/types";

describe("Burble Native runtime server", () => {
  test("serves a runtime capability manifest", async () => {
    const response = await handleRuntimeRequest(new Request("http://runtime/capabilities"));

    expect(response.status).toBe(200);
    expect(parseRuntimeCapabilityManifest(await response.json())).toEqual({
      runtimeType: "burble-native",
      version: expect.any(String),
      transports: ["http", "sse", "ndjson", "websocket"],
      streaming: true,
      cancellation: false,
      nativeScheduler: true,
      scheduledProviderCalls: true,
      toolCalls: true,
      toolBridgeModes: ["tool_gateway"],
      usageReporting: "exact",
      multimodalInput: true,
      multimodalOutput: false,
      memory: true,
      durableWorkflowState: true,
      attachments: true,
      conversationSend: true,
      jobScopedAuth: true
    });
  });

  test("runs a native no-tool turn through the SDK contract server", async () => {
    const response = await handleRuntimeRequest(
      new Request("http://runtime/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(nativeRunRequest("hello native runtime"))
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      response: {
        classification: "user_private",
        text: "Burble Native is ready.",
        usage: nativeUsage()
      }
    });
  });

  test("streams native provider-backed turns as runtime events", async () => {
    const toolCalls: Array<{ toolName: string; body: unknown }> = [];
    const executeTool: ToolExecutor = async (toolName, body) => {
      toolCalls.push({ toolName, body });
      return {
        classification: "user_private",
        content: { login: "octocat" }
      };
    };
    const response = await handleRuntimeRequest(
      new Request("http://runtime/runs", {
        method: "POST",
        headers: {
          accept: "application/x-ndjson",
          "content-type": "application/json"
        },
        body: JSON.stringify(
          nativeRunRequest("who am I on GitHub?", {
            github: {
              connected: true,
              email: "person@example.com"
            }
          })
        )
      }),
      { executeTool }
    );

    expect(response.status).toBe(200);
    expect(
      (await response.text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    ).toEqual([
      { type: "status", text: "Burble Native accepted the turn." },
      { type: "message_delta", text: "Authenticated to GitHub as `octocat`." },
      {
        type: "final",
        response: {
          classification: "user_private",
          text: "Authenticated to GitHub as `octocat`.",
          usage: nativeUsage()
        }
      }
    ]);
    expect(toolCalls).toEqual([
      {
        toolName: "github.getAuthenticatedUser",
        body: {
          user: { email: "person@example.com" }
        }
      }
    ]);
  });

  test("executes tools through the Burble tool gateway with runtime auth", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const executeTool = createBurbleNativeToolExecutor({
      toolGatewayUrl: "http://burble-app:3000/internal/tools/",
      runtimeToken: "runtime-token",
      fetch: async (url, init) => {
        calls.push({ url, init });
        return Response.json({
          classification: "user_private",
          content: { login: "octocat" }
        });
      }
    });

    await expect(
      executeTool("github.getAuthenticatedUser", {
        user: { email: "person@example.com" }
      })
    ).resolves.toEqual({
      classification: "user_private",
      content: { login: "octocat" }
    });
    expect(calls[0].url).toBe(
      "http://burble-app:3000/internal/tools/github.getAuthenticatedUser/execute"
    );
    expect(calls[0].init?.headers).toMatchObject({
      authorization: "Bearer runtime-token",
      "content-type": "application/json"
    });
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      user: { email: "person@example.com" }
    });
  });
});

function nativeRunRequest(
  text: string,
  connections: Record<string, unknown> = { github: { connected: false } }
) {
  return {
    runId: `run-native-test-${crypto.randomUUID()}`,
    principal: {
      workspaceId: "T123",
      slackUserId: "U123"
    },
    runtime: {
      id: "rt_native",
      engine: "burble-native"
    },
    input: {
      text,
      conversation: {
        routeId: "convrt_native_test",
        source: "slack",
        workspaceId: "T123",
        channelId: "D123",
        rootId: "dm:D123",
        isDirectMessage: true
      },
      connections
    }
  };
}

function nativeUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    usageSource: "burble-native"
  };
}
