import { describe, expect, test } from "bun:test";
import { parseRuntimeCapabilityManifest } from "../../../src/agent/runtime-contract";
import { handleRuntimeRequest } from "../../../runtimes/burble-native/src/server";
import { createBurbleNativeToolExecutor } from "../../../runtimes/burble-native/src/tools";

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
      nativeScheduler: false,
      scheduledProviderCalls: false,
      toolCalls: false,
      toolBridgeModes: ["tool_gateway"],
      usageReporting: "exact",
      multimodalInput: false,
      multimodalOutput: false,
      memory: false,
      durableWorkflowState: false,
      attachments: false,
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
      }),
      {
        env: {
          BURBLE_RUNTIME_CONTRACT_PROBE: "1"
        }
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      response: {
        classification: "user_private",
        text: "Runtime contract probe response.",
        usage: nativeUsage()
      }
    });
  });

  test("streams OpenAI response deltas and exact usage for no-tool turns", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const response = await handleRuntimeRequest(
      new Request("http://runtime/runs", {
        method: "POST",
        headers: {
          accept: "application/x-ndjson",
          "content-type": "application/json"
        },
        body: JSON.stringify(nativeRunRequest("describe Burble"))
      }),
      {
        env: {
          AI_MODEL: "openai:gpt-5.4",
          OPENAI_API_KEY: "test-openai-key"
        },
        fetch: async (url: string, init?: RequestInit) => {
          requests.push({ url, init });
          return new Response(
            [
              sseEvent({
                type: "response.output_text.delta",
                delta: "Burble "
              }),
              sseEvent({
                type: "response.output_text.delta",
                delta: "executes."
              }),
              sseEvent({
                type: "response.completed",
                response: {
                  output_text: "Burble executes.",
                  usage: {
                    input_tokens: 120,
                    output_tokens: 8,
                    total_tokens: 512,
                    input_tokens_details: {
                      cached_tokens: 384
                    },
                    output_tokens_details: {
                      reasoning_tokens: 0
                    }
                  }
                }
              })
            ].join(""),
            {
              headers: { "content-type": "text/event-stream" }
            }
          );
        }
      }
    );

    expect(response.status).toBe(200);
    expect(
      (await response.text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    ).toEqual([
      { type: "status", text: "Burble Native accepted the turn." },
      { type: "message_delta", text: "Burble " },
      { type: "message_delta", text: "executes." },
      {
        type: "final",
        response: {
          classification: "user_private",
          text: "Burble executes.",
          usage: {
            inputTokens: 120,
            outputTokens: 8,
            totalTokens: 512,
            cachedInputTokens: 384,
            reasoningTokens: 0,
            usageSource: "provider-output"
          }
        }
      }
    ]);
    expect(requests[0].url).toBe("https://api.openai.com/v1/responses");
    expect(requests[0].init?.headers).toMatchObject({
      authorization: "Bearer test-openai-key",
      "content-type": "application/json"
    });
    expect(JSON.parse(String(requests[0].init?.body))).toMatchObject({
      model: "gpt-5.4",
      stream: true,
      input: expect.stringContaining("describe Burble")
    });
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

function sseEvent(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}
