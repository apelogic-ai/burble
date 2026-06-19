import { describe, expect, test } from "bun:test";
import { parseRuntimeCapabilityManifest } from "@burble/runtime-sdk/runtime-contract";
import { handleRuntimeRequest as handleRuntimeRequestRaw } from "../../../runtimes/burble-native/src/server";
import { createBurbleNativeToolExecutor } from "../../../runtimes/burble-native/src/tools";

const runtimeToken = "runtime-token";

function handleRuntimeRequest(
  request: Request,
  context: Parameters<typeof handleRuntimeRequestRaw>[1] = {},
  options: Parameters<typeof handleRuntimeRequestRaw>[2] = {}
): ReturnType<typeof handleRuntimeRequestRaw> {
  const token = context.env?.BURBLE_INTERNAL_TOKEN ?? runtimeToken;
  return handleRuntimeRequestRaw(
    withRuntimeAuthorization(request, token),
    {
      ...context,
      env: {
        ...context.env,
        BURBLE_INTERNAL_TOKEN: token
      }
    },
    options
  );
}

function withRuntimeAuthorization(request: Request, token: string): Request {
  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${token}`);
  return new Request(request, { headers });
}

describe("Burble Native runtime server", () => {
  test("requires runtime bearer auth for contract endpoints", async () => {
    const response = await handleRuntimeRequestRaw(
      new Request("http://runtime/capabilities"),
      {
        env: {
          BURBLE_INTERNAL_TOKEN: runtimeToken
        }
      }
    );

    expect(response.status).toBe(401);
  });

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
      toolCalls: true,
      toolBridgeModes: ["tool_gateway"],
      usageReporting: "exact",
      multimodalInput: false,
      multimodalOutput: false,
      memory: false,
      durableWorkflowState: false,
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

  test("streams deterministic attachment capability probe events", async () => {
    const baseRequest = nativeRunRequest(
      "runtime contract attachment capability probe"
    );
    const response = await handleRuntimeRequest(
      new Request("http://runtime/runs", {
        method: "POST",
        headers: {
          accept: "application/x-ndjson",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          ...baseRequest,
          input: {
            ...baseRequest.input,
            attachments: [
              {
                id: "attcap_contract_probe",
                source: "slack",
                kind: "file",
                name: "contract.txt",
                mimeType: "text/plain"
              }
            ]
          }
        })
      }),
      {
        env: {
          BURBLE_RUNTIME_CONTRACT_PROBE: "1"
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
      {
        type: "tool_call",
        toolName: "conversation.getAttachment",
        callId: "contract-attachment-probe",
        input: { attachmentId: "attcap_contract_probe" }
      },
      {
        type: "tool_result",
        toolName: "conversation.getAttachment",
        callId: "contract-attachment-probe",
        classification: "user_private",
        content: { text: "contract attachment content" }
      },
      {
        type: "message_delta",
        text: "Runtime contract attachment capability response."
      },
      {
        type: "final",
        response: {
          classification: "user_private",
          text: "Runtime contract attachment capability response.",
          usage: nativeUsage()
        }
      }
    ]);
  });

  test("streams deterministic tool reachability probe events", async () => {
    const response = await handleRuntimeRequest(
      new Request("http://runtime/runs", {
        method: "POST",
        headers: {
          accept: "application/x-ndjson",
          "content-type": "application/json"
        },
        body: JSON.stringify(
          withRuntimeManifestTools(
            nativeRunRequest("runtime contract tool reachability probe"),
            [
              {
                name: "github_get_authenticated_user",
                alias: "github.getAuthenticatedUser",
                provider: "github",
                title: "GitHub authenticated user",
                description: "Return the connected GitHub identity.",
                enabled: true,
                risk: "read",
                routeRequired: true,
                confirmation: "none",
                retrySafe: true,
                input: []
              },
              {
                name: "github_create_issue",
                alias: "github.createIssue",
                provider: "github",
                title: "GitHub create issue",
                description: "Create a GitHub issue.",
                enabled: false,
                risk: "low_write",
                routeRequired: true,
                confirmation: "none",
                retrySafe: false,
                input: []
              }
            ]
          )
        )
      }),
      {
        env: {
          BURBLE_RUNTIME_CONTRACT_PROBE: "1"
        }
      }
    );

    expect(response.status).toBe(200);
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events).toContainEqual({
      type: "tool_call",
      toolName: "github.getAuthenticatedUser",
      callId: "contract-tool-reachability-0",
      input: {}
    });
    expect(events).toContainEqual({
      type: "tool_result",
      toolName: "github.getAuthenticatedUser",
      callId: "contract-tool-reachability-0",
      classification: "user_private",
      content: {
        ok: true,
        toolName: "github.getAuthenticatedUser",
        input: {}
      }
    });
    expect(JSON.stringify(events)).not.toContain("github.createIssue");
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
          OPENAI_API_KEY: "test-openai-key",
          OPENAI_BASE_URL: "https://openai-compatible.example/v1"
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
    expect(requests[0].url).toBe(
      "https://openai-compatible.example/v1/responses"
    );
    expect(requests[0].init?.headers).toMatchObject({
      authorization: "Bearer test-openai-key",
      "content-type": "application/json"
    });
    expect(JSON.parse(String(requests[0].init?.body))).toMatchObject({
      model: "gpt-5.4",
      stream: true,
      tools: [],
      input: [
        {
          role: "user",
          content: expect.stringContaining("describe Burble")
        }
      ]
    });
  });

  test("retries transient OpenAI response failures", async () => {
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
          OPENAI_API_KEY: "test-openai-key",
          OPENAI_BASE_URL: "https://openai-compatible.example/v1",
          BURBLE_NATIVE_PROVIDER_RETRY_BASE_MS: "0"
        },
        fetch: async (url: string, init?: RequestInit) => {
          requests.push({ url, init });
          if (requests.length === 1) {
            return new Response("server error", { status: 500 });
          }
          return new Response(
            [
              sseEvent({
                type: "response.output_text.delta",
                delta: "Recovered."
              }),
              sseEvent({
                type: "response.completed",
                response: {
                  output_text: "Recovered.",
                  usage: {
                    input_tokens: 20,
                    output_tokens: 3,
                    total_tokens: 23
                  }
                }
              })
            ].join(""),
            { headers: { "content-type": "text/event-stream" } }
          );
        }
      }
    );

    expect(response.status).toBe(200);
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(requests).toHaveLength(2);
    expect(events).toContainEqual({
      type: "message_delta",
      text: "Recovered."
    });
  });

  test("executes model-requested Burble tools and feeds results back to the model", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const response = await handleRuntimeRequest(
      new Request("http://runtime/runs", {
        method: "POST",
        headers: {
          accept: "application/x-ndjson",
          "content-type": "application/json"
        },
        body: JSON.stringify(
          withRuntimeManifestTools(
            withToolGroups(
              nativeRunRequest("who am I on GitHub?", {
                github: { connected: true, email: "person@example.com" }
              }),
              ["github"]
            ),
            [
              {
                name: "github_get_authenticated_user",
                alias: "github.getAuthenticatedUser",
                provider: "github",
                title: "GitHub authenticated user",
                description: "Return the GitHub identity connected to this Slack user.",
                enabled: true,
                risk: "read",
                routeRequired: true,
                confirmation: "none",
                retrySafe: true,
                input: []
              },
              {
                name: "github_list_my_pull_requests",
                alias: "github.listMyPullRequests",
                provider: "github",
                title: "GitHub pull requests authored by me",
                description:
                  "List GitHub pull requests authored by this Slack user's connected GitHub account.",
                enabled: true,
                risk: "read",
                routeRequired: true,
                confirmation: "none",
                retrySafe: true,
                input: [
                  {
                    name: "state",
                    type: "enum",
                    required: false,
                    description: "Pull request state to include.",
                    values: ["open", "closed", "all"]
                  },
                  {
                    name: "limit",
                    type: "number",
                    required: false,
                    description: "Maximum number of pull requests to return."
                  }
                ]
              },
              {
                name: "jira_search_issues",
                alias: "jira.searchIssues",
                provider: "jira",
                title: "Jira issue search",
                description: "Search Jira issues visible to the user.",
                enabled: true,
                risk: "read",
                routeRequired: true,
                confirmation: "none",
                retrySafe: true,
                input: [
                  {
                    name: "query",
                    type: "string",
                    required: true,
                    description: "Jira search query"
                  }
                ]
              },
              {
                name: "github_create_issue",
                alias: "github.createIssue",
                provider: "github",
                title: "GitHub create issue",
                description: "Create a GitHub issue.",
                enabled: false,
                risk: "low_write",
                routeRequired: true,
                confirmation: "none",
                retrySafe: false,
                input: [
                  {
                    name: "repo",
                    type: "string",
                    required: true
                  }
                ]
              }
            ]
          )
        )
      }),
      {
        env: {
          AI_MODEL: "openai:gpt-5.4",
          OPENAI_API_KEY: "test-openai-key",
          OPENAI_BASE_URL: "https://openai-compatible.example/v1",
          BURBLE_TOOL_GATEWAY_URL: "http://burble-app:3000/internal/tools",
          BURBLE_INTERNAL_TOKEN: "runtime-token",
          BURBLE_NATIVE_TOOL_GATEWAY_RETRY_BASE_MS: "0"
        },
        fetch: async (url: string, init?: RequestInit) => {
          requests.push({ url, init });
          if (url.includes("/github.getAuthenticatedUser/execute")) {
            return Response.json({
              classification: "user_private",
              content: { login: "octocat" }
            });
          }
          const providerRequestCount = requests.filter((request) =>
            request.url.endsWith("/responses")
          ).length;
          if (providerRequestCount === 1) {
            return new Response(
              sseEvent({
                type: "response.completed",
                response: {
                  output: [
                    {
                      type: "function_call",
                      call_id: "call_123",
                      name: "burble_provider_call",
                      arguments: JSON.stringify({
                        toolName: "github.getAuthenticatedUser",
                        input: {
                          user: { email: "person@example.com" }
                        }
                      })
                    }
                  ],
                  usage: {
                    input_tokens: 100,
                    output_tokens: 5,
                    total_tokens: 105
                  }
                }
              }),
              { headers: { "content-type": "text/event-stream" } }
            );
          }
          return new Response(
            [
              sseEvent({
                type: "response.output_text.delta",
                delta: "Authenticated as octocat."
              }),
              sseEvent({
                type: "response.completed",
                response: {
                  output_text: "Authenticated as octocat.",
                  usage: {
                    input_tokens: 80,
                    output_tokens: 7,
                    total_tokens: 87
                  }
                }
              })
            ].join(""),
            { headers: { "content-type": "text/event-stream" } }
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
      {
        type: "tool_call",
        toolName: "github.getAuthenticatedUser",
        callId: "call_123"
      },
      {
        type: "tool_result",
        toolName: "github.getAuthenticatedUser",
        callId: "call_123",
        classification: "user_private"
      },
      { type: "message_delta", text: "Authenticated as octocat." },
      {
        type: "final",
        response: {
          classification: "user_private",
          text: "Authenticated as octocat.",
          usage: {
            inputTokens: 180,
            outputTokens: 12,
            totalTokens: 192,
            usageSource: "provider-output"
          }
        }
      }
    ]);

    const providerRequests = requests.filter((request) =>
      request.url.endsWith("/responses")
    );
    expect(providerRequests).toHaveLength(2);
    const firstProviderBody = JSON.parse(String(providerRequests[0].init?.body));
    expect(firstProviderBody).toMatchObject({
      tools: [
        {
          type: "function",
          name: "burble_provider_call"
        }
      ]
    });
    expect(firstProviderBody.input[0].content).toContain(
      "Available Burble tools for this turn"
    );
    expect(firstProviderBody.input[0].content).toContain(
      "github.getAuthenticatedUser"
    );
    expect(firstProviderBody.input[0].content).toContain(
      "github.listMyPullRequests"
    );
    expect(firstProviderBody.input[0].content).toContain(
      "state: enum(open|closed|all), optional"
    );
    expect(firstProviderBody.input[0].content).not.toContain("jira.searchIssues");
    expect(firstProviderBody.input[0].content).not.toContain("github.createIssue");
    expect(JSON.parse(String(providerRequests[1].init?.body))).toMatchObject({
      input: [
        { role: "user", content: expect.stringContaining("who am I on GitHub?") },
        {
          type: "function_call",
          call_id: "call_123",
          name: "burble_provider_call"
        },
        {
          type: "function_call_output",
          call_id: "call_123",
          output: expect.stringContaining("octocat")
        }
      ]
    });
    const toolRequest = requests.find((request) =>
      request.url.includes("/github.getAuthenticatedUser/execute")
    );
    expect(toolRequest?.init?.headers).toMatchObject({
      authorization: "Bearer runtime-token",
      "content-type": "application/json",
      "x-burble-runtime-id": "rt_native"
    });
  });

  test("exposes current-turn attachments to the native tool loop", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const baseRequest = nativeRunRequest("summarize the attached file");
    const response = await handleRuntimeRequest(
      new Request("http://runtime/runs", {
        method: "POST",
        headers: {
          accept: "application/x-ndjson",
          "content-type": "application/json"
        },
        body: JSON.stringify(
          withToolGroups(
            {
              ...baseRequest,
              input: {
                ...baseRequest.input,
                attachments: [
                  {
                    id: "attcap_native_123",
                    source: "slack",
                    kind: "file",
                    name: "notes.md",
                    mimeType: "text/markdown",
                    sizeBytes: 42
                  }
                ]
              }
            },
            ["attachments", "conversation"]
          )
        )
      }),
      {
        env: {
          AI_MODEL: "openai:gpt-5.4",
          OPENAI_API_KEY: "test-openai-key",
          OPENAI_BASE_URL: "https://openai-compatible.example/v1",
          BURBLE_TOOL_GATEWAY_URL: "http://burble-app:3000/internal/tools",
          BURBLE_INTERNAL_TOKEN: "runtime-token",
          BURBLE_NATIVE_TOOL_GATEWAY_RETRY_BASE_MS: "0"
        },
        fetch: async (url: string, init?: RequestInit) => {
          requests.push({ url, init });
          if (url.includes("/conversation.getAttachment/execute")) {
            return Response.json({
              classification: "user_private",
              content: { text: "# Notes\\nAttachment body." }
            });
          }
          const providerRequestCount = requests.filter((request) =>
            request.url.endsWith("/responses")
          ).length;
          if (providerRequestCount === 1) {
            return new Response(
              sseEvent({
                type: "response.completed",
                response: {
                  output: [
                    {
                      type: "function_call",
                      call_id: "call_attachment",
                      name: "burble_provider_call",
                      arguments: JSON.stringify({
                        toolName: "conversation.getAttachment",
                        input: {
                          attachmentId: "attcap_native_123"
                        }
                      })
                    }
                  ],
                  usage: {
                    input_tokens: 100,
                    output_tokens: 5,
                    total_tokens: 105
                  }
                }
              }),
              { headers: { "content-type": "text/event-stream" } }
            );
          }
          return new Response(
            [
              sseEvent({
                type: "response.output_text.delta",
                delta: "The file says Attachment body."
              }),
              sseEvent({
                type: "response.completed",
                response: {
                  output_text: "The file says Attachment body.",
                  usage: {
                    input_tokens: 80,
                    output_tokens: 7,
                    total_tokens: 87
                  }
                }
              })
            ].join(""),
            { headers: { "content-type": "text/event-stream" } }
          );
        }
      }
    );

    expect(response.status).toBe(200);
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events).toContainEqual({
      type: "tool_call",
      toolName: "conversation.getAttachment",
      callId: "call_attachment"
    });
    expect(events).toContainEqual({
      type: "tool_result",
      toolName: "conversation.getAttachment",
      callId: "call_attachment",
      classification: "user_private"
    });
    expect(events.at(-1)).toMatchObject({
      type: "final",
      response: {
        text: "The file says Attachment body."
      }
    });
    const providerRequests = requests.filter((request) =>
      request.url.endsWith("/responses")
    );
    const firstProviderBody = JSON.parse(String(providerRequests[0].init?.body));
    expect(firstProviderBody.input[0].content).toContain(
      "Current request attachments"
    );
    expect(firstProviderBody.input[0].content).toContain("attcap_native_123");
    expect(firstProviderBody.input[0].content).toContain(
      "conversation.getAttachment"
    );
    const toolRequest = requests.find((request) =>
      request.url.includes("/conversation.getAttachment/execute")
    );
    expect(toolRequest).toBeDefined();
    expect(JSON.parse(String(toolRequest?.init?.body))).toEqual({
      attachmentId: "attcap_native_123"
    });
  });

  test("feeds tool gateway failures back to the model", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const response = await handleRuntimeRequest(
      new Request("http://runtime/runs", {
        method: "POST",
        headers: {
          accept: "application/x-ndjson",
          "content-type": "application/json"
        },
        body: JSON.stringify(
          withRuntimeManifestTools(
            withToolGroups(
              nativeRunRequest("list my latest GitHub pull requests", {
                github: { connected: true, email: "person@example.com" }
              }),
              ["github"]
            ),
            [
              {
                name: "github_list_my_pull_requests",
                alias: "github.listMyPullRequests",
                provider: "github",
                title: "GitHub pull requests authored by me",
                description:
                  "List GitHub pull requests authored by this Slack user's connected GitHub account.",
                enabled: true,
                risk: "read",
                routeRequired: true,
                confirmation: "none",
                retrySafe: true,
                input: []
              }
            ]
          )
        )
      }),
      {
        env: {
          AI_MODEL: "openai:gpt-5.4",
          OPENAI_API_KEY: "test-openai-key",
          OPENAI_BASE_URL: "https://openai-compatible.example/v1",
          BURBLE_TOOL_GATEWAY_URL: "http://burble-app:3000/internal/tools",
          BURBLE_INTERNAL_TOKEN: "runtime-token",
          BURBLE_NATIVE_TOOL_GATEWAY_RETRY_BASE_MS: "0"
        },
        fetch: async (url: string, init?: RequestInit) => {
          requests.push({ url, init });
          if (url.includes("/github.listMyPullRequests/execute")) {
            return new Response("Bearer runtime-token backend unavailable", {
              status: 503
            });
          }
          const providerRequestCount = requests.filter((request) =>
            request.url.endsWith("/responses")
          ).length;
          if (providerRequestCount === 1) {
            return new Response(
              sseEvent({
                type: "response.completed",
                response: {
                  output: [
                    {
                      type: "function_call",
                      call_id: "call_123",
                      name: "burble_provider_call",
                      arguments: JSON.stringify({
                        toolName: "github.listMyPullRequests",
                        input: {}
                      })
                    }
                  ],
                  usage: {
                    input_tokens: 100,
                    output_tokens: 5,
                    total_tokens: 105
                  }
                }
              }),
              { headers: { "content-type": "text/event-stream" } }
            );
          }
          return new Response(
            [
              sseEvent({
                type: "response.output_text.delta",
                delta: "I could not reach GitHub right now."
              }),
              sseEvent({
                type: "response.completed",
                response: {
                  output_text: "I could not reach GitHub right now.",
                  usage: {
                    input_tokens: 80,
                    output_tokens: 8,
                    total_tokens: 88
                  }
                }
              })
            ].join(""),
            { headers: { "content-type": "text/event-stream" } }
          );
        }
      }
    );

    expect(response.status).toBe(200);
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.map((event) => event.type)).toEqual([
      "status",
      "tool_call",
      "tool_result",
      "message_delta",
      "final"
    ]);
    expect(events[2]).toMatchObject({
      type: "tool_result",
      toolName: "github.listMyPullRequests",
      callId: "call_123",
      classification: "user_private"
    });
    const secondProviderBody = JSON.parse(
      String(
        requests.filter((request) => request.url.endsWith("/responses"))[1].init
          ?.body
      )
    );
    const toolOutput = secondProviderBody.input.find(
      (item: { type?: string }) => item.type === "function_call_output"
    );
    expect(toolOutput.output).toContain("tool_execution_failed");
    expect(toolOutput.output).toContain("HTTP 503");
    expect(toolOutput.output).not.toContain("runtime-token");
  });

  test("bounds large tool results before feeding them back to the model", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const response = await handleRuntimeRequest(
      new Request("http://runtime/runs", {
        method: "POST",
        headers: {
          accept: "application/x-ndjson",
          "content-type": "application/json"
        },
        body: JSON.stringify(
          withRuntimeManifestTools(
            withToolGroups(
              nativeRunRequest("summarize my GitHub pull requests", {
                github: { connected: true, email: "person@example.com" }
              }),
              ["github"]
            ),
            [
              {
                name: "github_list_my_pull_requests",
                alias: "github.listMyPullRequests",
                provider: "github",
                title: "GitHub pull requests authored by me",
                description:
                  "List GitHub pull requests authored by this Slack user's connected GitHub account.",
                enabled: true,
                risk: "read",
                routeRequired: true,
                confirmation: "none",
                retrySafe: true,
                input: []
              }
            ]
          )
        )
      }),
      {
        env: {
          AI_MODEL: "openai:gpt-5.4",
          OPENAI_API_KEY: "test-openai-key",
          OPENAI_BASE_URL: "https://openai-compatible.example/v1",
          BURBLE_TOOL_GATEWAY_URL: "http://burble-app:3000/internal/tools",
          BURBLE_INTERNAL_TOKEN: "runtime-token",
          BURBLE_NATIVE_TOOL_GATEWAY_RETRY_BASE_MS: "0"
        },
        fetch: async (url: string, init?: RequestInit) => {
          requests.push({ url, init });
          if (url.includes("/github.listMyPullRequests/execute")) {
            return Response.json({
              classification: "user_private",
              content: {
                pullRequests: [
                  {
                    title: "Huge result",
                    body: "x".repeat(40_000)
                  }
                ]
              }
            });
          }
          const providerRequestCount = requests.filter((request) =>
            request.url.endsWith("/responses")
          ).length;
          if (providerRequestCount === 1) {
            return new Response(
              sseEvent({
                type: "response.completed",
                response: {
                  output: [
                    {
                      type: "function_call",
                      call_id: "call_123",
                      name: "burble_provider_call",
                      arguments: JSON.stringify({
                        toolName: "github.listMyPullRequests",
                        input: {}
                      })
                    }
                  ],
                  usage: {
                    input_tokens: 100,
                    output_tokens: 5,
                    total_tokens: 105
                  }
                }
              }),
              { headers: { "content-type": "text/event-stream" } }
            );
          }
          return new Response(
            [
              sseEvent({
                type: "response.output_text.delta",
                delta: "I found a large result."
              }),
              sseEvent({
                type: "response.completed",
                response: {
                  output_text: "I found a large result.",
                  usage: {
                    input_tokens: 80,
                    output_tokens: 8,
                    total_tokens: 88
                  }
                }
              })
            ].join(""),
            { headers: { "content-type": "text/event-stream" } }
          );
        }
      }
    );

    expect(response.status).toBe(200);
    await response.text();
    const secondProviderBody = JSON.parse(
      String(
        requests.filter((request) => request.url.endsWith("/responses"))[1].init
          ?.body
      )
    );
    const toolOutput = secondProviderBody.input.find(
      (item: { type?: string }) => item.type === "function_call_output"
    );
    expect(toolOutput.output.length).toBeLessThan(12_500);
    expect(toolOutput.output).toContain("\"truncated\":true");
    expect(toolOutput.output).toContain("\"originalChars\"");
  });

  test("does not expose the generic tool function without a selected tool catalog", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const response = await handleRuntimeRequest(
      new Request("http://runtime/runs", {
        method: "POST",
        headers: {
          accept: "application/x-ndjson",
          "content-type": "application/json"
        },
        body: JSON.stringify(
          withToolGroups(
            nativeRunRequest("who am I on GitHub?", {
              github: { connected: true, email: "person@example.com" }
            }),
            ["github"]
          )
        )
      }),
      {
        env: {
          AI_MODEL: "openai:gpt-5.4",
          OPENAI_API_KEY: "test-openai-key",
          OPENAI_BASE_URL: "https://openai-compatible.example/v1",
          BURBLE_TOOL_GATEWAY_URL: "http://burble-app:3000/internal/tools",
          BURBLE_INTERNAL_TOKEN: "runtime-token"
        },
        fetch: async (url: string, init?: RequestInit) => {
          requests.push({ url, init });
          return new Response(
            [
              sseEvent({
                type: "response.output_text.delta",
                delta: "I do not have provider tools available."
              }),
              sseEvent({
                type: "response.completed",
                response: {
                  output_text: "I do not have provider tools available.",
                  usage: {
                    input_tokens: 80,
                    output_tokens: 9,
                    total_tokens: 89
                  }
                }
              })
            ].join(""),
            { headers: { "content-type": "text/event-stream" } }
          );
        }
      }
    );

    expect(response.status).toBe(200);
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events).toEqual([
      { type: "status", text: "Burble Native accepted the turn." },
      { type: "message_delta", text: "I do not have provider tools available." },
      {
        type: "final",
        response: {
          classification: "user_private",
          text: "I do not have provider tools available.",
          usage: {
            inputTokens: 80,
            outputTokens: 9,
            totalTokens: 89,
            usageSource: "provider-output"
          }
        }
      }
    ]);

    const providerBody = JSON.parse(String(requests[0].init?.body));
    expect(providerBody).toMatchObject({
      tools: [],
      input: [
        {
          role: "user",
          content: expect.stringContaining(
            "No Burble provider tools are available"
          )
        }
      ]
    });
  });

  test("bounds hung OpenAI streams with a provider timeout", async () => {
    const response = await handleRuntimeRequest(
      new Request("http://runtime/runs", {
        method: "POST",
        headers: {
          accept: "application/x-ndjson",
          "content-type": "application/json"
        },
        body: JSON.stringify(nativeRunRequest("hello"))
      }),
      {
        env: {
          AI_MODEL: "openai:gpt-5.4",
          OPENAI_API_KEY: "test-openai-key",
          BURBLE_NATIVE_PROVIDER_TIMEOUT_MS: "5",
          BURBLE_NATIVE_PROVIDER_MAX_ATTEMPTS: "1"
        },
        fetch: async (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(init.signal?.reason ?? new Error("aborted"));
            });
          })
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
      {
        type: "error",
        message:
          "Runtime run failed: OpenAI Responses API timed out after 5ms"
      }
    ]);
  });

  test("does not retry non-transient OpenAI response failures", async () => {
    let requests = 0;
    const response = await handleRuntimeRequest(
      new Request("http://runtime/runs", {
        method: "POST",
        headers: {
          accept: "application/x-ndjson",
          "content-type": "application/json"
        },
        body: JSON.stringify(nativeRunRequest("hello"))
      }),
      {
        env: {
          AI_MODEL: "openai:gpt-5.4",
          OPENAI_API_KEY: "test-openai-key",
          BURBLE_NATIVE_PROVIDER_MAX_ATTEMPTS: "3",
          BURBLE_NATIVE_PROVIDER_RETRY_BASE_MS: "0"
        },
        fetch: async () => {
          requests += 1;
          return new Response("context too large", { status: 400 });
        }
      }
    );

    expect(response.status).toBe(200);
    expect(requests).toBe(1);
    expect(
      (await response.text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    ).toEqual([
      { type: "status", text: "Burble Native accepted the turn." },
      {
        type: "error",
        message: "Runtime run failed: OpenAI Responses API returned HTTP 400"
      }
    ]);
  });

  test("bounds stacked OpenAI retries with a turn timeout", async () => {
    let requests = 0;
    const response = await handleRuntimeRequest(
      new Request("http://runtime/runs", {
        method: "POST",
        headers: {
          accept: "application/x-ndjson",
          "content-type": "application/json"
        },
        body: JSON.stringify(nativeRunRequest("hello"))
      }),
      {
        env: {
          AI_MODEL: "openai:gpt-5.4",
          OPENAI_API_KEY: "test-openai-key",
          BURBLE_NATIVE_PROVIDER_TIMEOUT_MS: "1000",
          BURBLE_NATIVE_PROVIDER_MAX_ATTEMPTS: "3",
          BURBLE_NATIVE_PROVIDER_RETRY_BASE_MS: "0",
          BURBLE_NATIVE_TURN_TIMEOUT_MS: "5"
        },
        fetch: async (_url: string, init?: RequestInit) => {
          requests += 1;
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(init.signal?.reason ?? new Error("aborted"));
            });
          });
        }
      }
    );

    expect(response.status).toBe(200);
    expect(requests).toBe(1);
    expect(
      (await response.text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    ).toEqual([
      { type: "status", text: "Burble Native accepted the turn." },
      {
        type: "error",
        message: "Runtime run failed: Burble Native turn timed out after 5ms"
      }
    ]);
  });

  test("bounds stalled OpenAI SSE bodies with the same provider timeout", async () => {
    const response = await handleRuntimeRequest(
      new Request("http://runtime/runs", {
        method: "POST",
        headers: {
          accept: "application/x-ndjson",
          "content-type": "application/json"
        },
        body: JSON.stringify(nativeRunRequest("hello"))
      }),
      {
        env: {
          AI_MODEL: "openai:gpt-5.4",
          OPENAI_API_KEY: "test-openai-key",
          BURBLE_NATIVE_PROVIDER_TIMEOUT_MS: "5",
          BURBLE_NATIVE_PROVIDER_MAX_ATTEMPTS: "1"
        },
        fetch: async () =>
          new Response(new ReadableStream<Uint8Array>({ start() {} }), {
            headers: { "content-type": "text/event-stream" }
          })
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
      {
        type: "error",
        message:
          "Runtime run failed: OpenAI Responses API timed out after 5ms"
      }
    ]);
  });

  test("executes tools through the Burble tool gateway with runtime auth", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const executeTool = createBurbleNativeToolExecutor({
      toolGatewayUrl: "http://burble-app:3000/internal/tools/",
      runtimeToken: "runtime-token",
      runtimeId: "rt_u123",
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
      "content-type": "application/json",
      "x-burble-runtime-id": "rt_u123"
    });
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      user: { email: "person@example.com" }
    });
  });

  test("retries manifest-declared retry-safe read tools", async () => {
    let calls = 0;
    const executeTool = createBurbleNativeToolExecutor({
      toolGatewayUrl: "http://burble-app:3000/internal/tools/",
      runtimeToken: "runtime-token",
      tools: [
        {
          name: "github_list_my_pull_requests",
          alias: "github.listMyPullRequests",
          retrySafe: true
        }
      ],
      retryBaseDelayMs: 0,
      fetch: async () => {
        calls += 1;
        if (calls === 1) {
          return new Response("temporarily unavailable", { status: 503 });
        }
        return Response.json({
          classification: "user_private",
          content: { pullRequests: [] }
        });
      }
    });

    await expect(
      executeTool("github.listMyPullRequests", { input: { limit: 3 } })
    ).resolves.toEqual({
      classification: "user_private",
      content: { pullRequests: [] }
    });
    expect(calls).toBe(2);
  });

  test("does not retry manifest-declared unsafe write tools", async () => {
    let calls = 0;
    const executeTool = createBurbleNativeToolExecutor({
      toolGatewayUrl: "http://burble-app:3000/internal/tools/",
      runtimeToken: "runtime-token",
      tools: [
        {
          name: "google_slides_fill_placeholders",
          alias: "google.slidesFillPlaceholders",
          retrySafe: false
        }
      ],
      retryBaseDelayMs: 0,
      fetch: async () => {
        calls += 1;
        return new Response("temporarily unavailable", { status: 503 });
      }
    });

    await expect(
      executeTool("google.slidesFillPlaceholders", {
        input: {
          presentationId: "deck-1",
          replacements: [{ placeholderType: "TITLE", text: "Title" }]
        }
      })
    ).rejects.toThrow("Burble tool gateway returned HTTP 503");
    expect(calls).toBe(1);
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

function withToolGroups<T extends ReturnType<typeof nativeRunRequest>>(
  request: T,
  groups: string[]
): T {
  return {
    ...request,
    input: {
      ...request.input,
      toolGroups: {
        groups,
        reasons: groups.map((group) => `${group} test`)
      }
    }
  };
}

function withRuntimeManifestTools<T extends ReturnType<typeof nativeRunRequest>>(
  request: T,
  tools: Array<Record<string, unknown>>
): T {
  return {
    ...request,
    runtime: {
      ...request.runtime,
      manifest: {
        version: "1",
        policyHash: "policy-native-tools",
        skills: [],
        tools,
        memory: {
          userMemoryEnabled: false,
          workspaceMemoryEnabled: false,
          jobMemoryEnabled: false
        },
        streaming: {
          messageDeltasEnabled: true
        }
      }
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
