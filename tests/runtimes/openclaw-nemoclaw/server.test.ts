import { describe, expect, test } from "bun:test";
import {
  attachRuntimeEventWebSocket,
  handleRuntimeRequest as handleRuntimeRequestRaw
} from "../../../runtimes/openclaw-nemoclaw/src/server";
import { buildBurbleConversationDeliveryTarget } from "../../../runtimes/openclaw-nemoclaw/src/burble-conversation-connector";
import type { RuntimeConfig } from "../../../runtimes/openclaw-nemoclaw/src/config";
import { parseRuntimeCapabilityManifest } from "@burble/runtime-sdk/runtime-contract";

class FakeRuntimeWebSocket {
  readonly messages: string[] = [];
  closeCode: number | undefined;
  closeReason: string | undefined;

  send(message: string): void {
    this.messages.push(message);
  }

  close(code?: number, reason?: string): void {
    this.closeCode = code;
    this.closeReason = reason;
  }
}

const config: RuntimeConfig = {
  port: 8080,
  contractProbeMode: false,
  toolGatewayUrl: "http://burble-app:3000/internal/tools",
  internalToken: "secret",
  mcpGatewayUrl: null,
  runtimeJwt: null,
  engine: "deterministic",
  openClawCommand: "openclaw",
  openClawAgent: "main",
  openClawTimeoutMs: 60000,
  openClawStateDir: "/data/openclaw/state",
  openClawConfigPath: "/data/openclaw/config/openclaw.json",
  openClawWorkspaceDir: "/data/openclaw/workspace",
  openClawSetupOnStart: true,
  openClawConfigPatchPath: null,
  openClawValidateOnStart: true,
  openClawStreamDebug: false,
  openClawCodeMode: false,
  openClawFastMode: false,
  openClawRawStreamDebug: false,
  openClawGatewayPort: 18789,
  openClawGatewayBind: "loopback",
  openClawGatewayToken: "gateway-token",
  llmModel: "openai:gpt-5.4",
  ollamaBaseUrl: "https://ollama.com"
};

function handleRuntimeRequest(
  request: Request,
  runtimeConfig: RuntimeConfig,
  executeTool?: Parameters<typeof handleRuntimeRequestRaw>[2],
  options?: Parameters<typeof handleRuntimeRequestRaw>[3]
): ReturnType<typeof handleRuntimeRequestRaw> {
  return handleRuntimeRequestRaw(
    withRuntimeAuthorization(request, runtimeConfig.internalToken),
    runtimeConfig,
    executeTool,
    options
  );
}

function withRuntimeAuthorization(request: Request, token: string): Request {
  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${token}`);
  return new Request(request, { headers });
}

async function withMockFetch<T>(
  mock: typeof fetch,
  run: () => Promise<T>
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe("handleRuntimeRequest", () => {
  test("requires runtime bearer auth for run endpoints", async () => {
    const response = await handleRuntimeRequestRaw(
      new Request("http://runtime/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      }),
      config
    );

    expect(response.status).toBe(401);
  });

  test("builds Burble channel delivery URLs with scheduled job identity", () => {
    const target = buildBurbleConversationDeliveryTarget(config, {
      routeId: "convrt_abcdefabcdefabcdefabcdef",
      jobId: "job-123"
    });

    expect(target).toEqual({
      channel: "burble",
      routeId: "convrt_abcdefabcdefabcdefabcdef",
      localMessageUrl:
        "http://127.0.0.1:8080/internal/burble/channel/routes/convrt_abcdefabcdefabcdefabcdef/messages?jobId=job-123",
      localEventUrl:
        "http://127.0.0.1:8080/internal/burble/channel/routes/convrt_abcdefabcdefabcdefabcdef/events?jobId=job-123"
    });
  });

  test("serves health checks", async () => {
    const response = await handleRuntimeRequest(
      new Request("http://runtime/healthz"),
      config
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  test("serves a runtime capability manifest", async () => {
    const response = await handleRuntimeRequest(
      new Request("http://runtime/capabilities"),
      {
        ...config,
        engine: "openclaw-gateway",
        mcpGatewayUrl: "http://agentgateway:3000/mcp",
        runtimeJwt: "jwt"
      }
    );

    expect(response.status).toBe(200);
    const manifest = parseRuntimeCapabilityManifest(await response.json());
    expect(manifest).toEqual({
      runtimeType: "openclaw-gateway",
      version: expect.any(String),
      transports: ["http", "sse", "ndjson", "websocket"],
      streaming: true,
      cancellation: false,
      nativeScheduler: true,
      scheduledProviderCalls: true,
      toolCalls: true,
      toolBridgeModes: ["tool_gateway", "mcp"],
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

  test("handles run requests", async () => {
    const response = await handleRuntimeRequest(
      new Request("http://runtime/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runtime: { id: "rt_u123" },
          input: {
            text: "who am I on GitHub?",
            connections: {
              github: {
                connected: true,
                email: "person@example.com"
              }
            }
          }
        })
      }),
      config,
      async () => ({
        classification: "user_private",
        content: { login: "octocat" }
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      response: {
        classification: "user_private",
        text: "Authenticated to GitHub as `octocat`."
      }
    });
  });

  test("streams deterministic contract probe events without invoking an agent", async () => {
    const response = await handleRuntimeRequest(
      new Request("http://runtime/runs", {
        method: "POST",
        headers: {
          accept: "application/x-ndjson",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          runId: "run-contract-probe",
          principal: { workspaceId: "T123", slackUserId: "U123" },
          runtime: { id: "rt_probe", engine: "openclaw" },
          input: {
            text: "contract probe",
            conversation: {
              source: "slack",
              workspaceId: "T123",
              channelId: "D123",
              rootId: "dm:D123",
              isDirectMessage: true
            },
            connections: {
              github: { connected: false }
            }
          }
        })
      }),
      { ...config, engine: "openclaw", contractProbeMode: true }
    );

    expect(response.status).toBe(200);
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(events).toEqual([
      { type: "status", text: "Runtime contract probe accepted." },
      { type: "message_delta", text: "Runtime contract probe response." },
      {
        type: "final",
        response: {
          classification: "user_private",
          text: "Runtime contract probe response.",
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
            usageSource: "contract-probe"
          }
        }
      }
    ]);
  });

  test("accepts the legacy OpenClaw native execution mode alias at the request boundary", async () => {
    const response = await handleRuntimeRequest(
      new Request("http://runtime/runs", {
        method: "POST",
        headers: {
          accept: "application/x-ndjson",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          runId: "run-legacy-native-mode",
          executionMode: "openclaw-native",
          principal: { workspaceId: "T123", slackUserId: "U123" },
          runtime: { id: "rt_probe", engine: "openclaw" },
          input: {
            text: "contract probe",
            connections: {
              github: { connected: false }
            }
          }
        })
      }),
      { ...config, engine: "openclaw", contractProbeMode: true }
    );

    expect(response.status).toBe(200);
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.at(-1)).toMatchObject({
      type: "final",
      response: {
        text: "Runtime contract probe response."
      }
    });
  });

  test("streams deterministic capability assertion probe events", async () => {
    const toolResponse = await handleRuntimeRequest(
      new Request("http://runtime/runs", {
        method: "POST",
        headers: {
          accept: "application/x-ndjson",
          "content-type": "application/json"
        },
        body: JSON.stringify(
          contractProbeRequest({
            runId: "run-contract-tool-probe",
            text: "runtime contract tool capability probe"
          })
        )
      }),
      { ...config, engine: "openclaw", contractProbeMode: true }
    );
    const scheduledResponse = await handleRuntimeRequest(
      new Request("http://runtime/runs", {
        method: "POST",
        headers: {
          accept: "application/x-ndjson",
          "content-type": "application/json"
        },
        body: JSON.stringify(
          contractProbeRequest({
            runId: "run-contract-scheduled-probe",
            text: "runtime contract scheduled provider capability probe",
            scheduled: true
          })
        )
      }),
      { ...config, engine: "openclaw", contractProbeMode: true }
    );
    const attachmentResponse = await handleRuntimeRequest(
      new Request("http://runtime/runs", {
        method: "POST",
        headers: {
          accept: "application/x-ndjson",
          "content-type": "application/json"
        },
        body: JSON.stringify(
          contractProbeRequest({
            runId: "run-contract-attachment-probe",
            text: "runtime contract attachment capability probe",
            attachment: true
          })
        )
      }),
      { ...config, engine: "openclaw", contractProbeMode: true }
    );
    const reachabilityResponse = await handleRuntimeRequest(
      new Request("http://runtime/runs", {
        method: "POST",
        headers: {
          accept: "application/x-ndjson",
          "content-type": "application/json"
        },
        body: JSON.stringify(
          contractProbeRequest({
            runId: "run-contract-reachability-probe",
            text: "runtime contract tool reachability probe",
            tools: [
              {
                name: "github_search_issues",
                alias: "github.searchIssues",
                enabled: true
              },
              {
                name: "github_create_issue",
                alias: "github.createIssue",
                enabled: false
              }
            ]
          })
        )
      }),
      { ...config, engine: "openclaw", contractProbeMode: true }
    );

    expect(readNdjsonEvents(await toolResponse.text())).toContainEqual({
      type: "tool_call",
      toolName: "runtime.conformance.echo",
      callId: "contract-tool-probe"
    });
    const scheduledEvents = readNdjsonEvents(await scheduledResponse.text());
    expect(scheduledEvents).toContainEqual({
      type: "tool_call",
      toolName: "scheduledJob.registerCapability",
      callId: "contract-scheduled-provider-probe"
    });
    expect(scheduledEvents).toContainEqual({
      type: "tool_call",
      toolName: "burble_provider_call",
      callId: "contract-scheduled-provider-bridge-probe",
      input: {
        toolName: "runtime.conformance.echo",
        input: {
          jobId: "contract-scheduled-job",
          message: "scheduled provider bridge probe"
        }
      }
    });
    expect(scheduledEvents).toContainEqual({
      type: "tool_result",
      toolName: "burble_provider_call",
      callId: "contract-scheduled-provider-bridge-probe",
      classification: "user_private",
      content: {
        ok: true,
        toolName: "runtime.conformance.echo",
        input: {
          jobId: "contract-scheduled-job",
          message: "scheduled provider bridge probe"
        }
      }
    });
    expect(readNdjsonEvents(await attachmentResponse.text())).toContainEqual({
      type: "tool_call",
      toolName: "conversation.getAttachment",
      callId: "contract-attachment-probe",
      input: { attachmentId: "attcap_contract_probe" }
    });
    const reachabilityEvents = readNdjsonEvents(await reachabilityResponse.text());
    expect(reachabilityEvents).toContainEqual({
      type: "tool_call",
      toolName: "github_search_issues",
      callId: "contract-tool-reachability-0",
      input: { query: "contract-query" }
    });
    expect(reachabilityEvents).toContainEqual({
      type: "tool_result",
      toolName: "github_search_issues",
      callId: "contract-tool-reachability-0",
      classification: "user_private",
      content: {
        ok: true,
        toolName: "github_search_issues",
        input: { query: "contract-query" }
      }
    });
    expect(JSON.stringify(reachabilityEvents)).not.toContain("github.createIssue");
  });

  test("accepts HubSpot runtime tool groups and connection summaries", async () => {
    const response = await handleRuntimeRequest(
      new Request("http://runtime/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runtime: { id: "rt_u123" },
          input: {
            text: "Find HubSpot contacts for Acme",
            toolGroups: {
              groups: ["conversation", "hubspot"],
              reasons: ["keyword:hubspot:hubspot"]
            },
            connections: {
              github: {
                connected: false
              },
              hubspot: {
                connected: true,
                email: "person@example.com",
                providerLogin: "hubspot-user@example.com"
              }
            }
          }
        })
      }),
      config
    );

    expect(response.status).toBe(200);
  });

  test("streams run events as SSE when requested", async () => {
    const response = await handleRuntimeRequest(
      new Request("http://runtime/runs", {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          runtime: { id: "rt_u123" },
          input: {
            text: "who am I on GitHub?",
            connections: {
              github: {
                connected: true,
                email: "person@example.com"
              }
            }
          }
        })
      }),
      config,
      async () => ({
        classification: "user_private",
        content: { login: "octocat" }
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const stream = await response.text();

    expect(stream).toContain(": stream-start\n\n");
    expect(stream).toContain(
      `event: status\ndata: ${JSON.stringify({
        type: "status",
        text: "Loading Burble context..."
      })}\n\n`
    );
    expect(stream).toContain(
      `event: final\ndata: ${JSON.stringify({
        type: "final",
        response: {
          classification: "user_private",
          text: "Authenticated to GitHub as `octocat`."
        }
      })}\n\n`
    );
  });

  test("shares in-flight runs by run id across streaming and json clients", async () => {
    let toolCalls = 0;
    let resolveTool!: () => void;
    const toolGate = new Promise<void>((resolve) => {
      resolveTool = resolve;
    });
    const body = JSON.stringify({
      runId: "run-shared",
      runtime: { id: "rt_u123" },
      input: {
        text: "who am I on GitHub?",
        connections: {
          github: {
            connected: true,
            email: "person@example.com"
          }
        }
      }
    });
    const executeTool = async () => {
      toolCalls += 1;
      await toolGate;
      return {
        classification: "user_private" as const,
        content: { login: "octocat" }
      };
    };

    const streamResponse = await handleRuntimeRequest(
      new Request("http://runtime/runs", {
        method: "POST",
        headers: {
          accept: "application/x-ndjson",
          "content-type": "application/json"
        },
        body
      }),
      config,
      executeTool
    );
    const reader = streamResponse.body!.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    expect(decoder.decode(first.value)).toContain("Loading Burble context");

    const jsonResponsePromise = handleRuntimeRequest(
      new Request("http://runtime/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body
      }),
      config,
      executeTool
    );

    resolveTool();

    let streamText = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      streamText += decoder.decode(chunk.value);
    }

    const jsonResponse = await jsonResponsePromise;
    expect(jsonResponse.status).toBe(200);
    expect(await jsonResponse.json()).toEqual({
      response: {
        classification: "user_private",
        text: "Authenticated to GitHub as `octocat`."
      }
    });
    expect(streamText).toContain("\"type\":\"final\"");
    expect(streamText).toContain("Authenticated to GitHub as `octocat`.");
    expect(toolCalls).toBe(1);
  });

  test("starts runs asynchronously and exposes the final run snapshot", async () => {
    let resolveTool!: () => void;
    const toolGate = new Promise<void>((resolve) => {
      resolveTool = resolve;
    });

    const startResponse = await handleRuntimeRequest(
      new Request("http://runtime/runs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          prefer: "respond-async"
        },
        body: JSON.stringify({
          runId: "run-async",
          runtime: { id: "rt_u123" },
          input: {
            text: "who am I on GitHub?",
            connections: {
              github: {
                connected: true,
                email: "person@example.com"
              }
            }
          }
        })
      }),
      config,
      async () => {
        await toolGate;
        return {
          classification: "user_private" as const,
          content: { login: "octocat" }
        };
      }
    );

    expect(startResponse.status).toBe(200);
    expect(await startResponse.json()).toEqual({
      runId: "run-async",
      eventsUrl: "/runs/run-async/events"
    });

    const snapshotPromise = handleRuntimeRequest(
      new Request("http://runtime/runs/run-async"),
      config
    );
    resolveTool();

    const snapshotResponse = await snapshotPromise;
    expect(snapshotResponse.status).toBe(200);
    expect(await snapshotResponse.json()).toEqual({
      response: {
        classification: "user_private",
        text: "Authenticated to GitHub as `octocat`."
      },
      events: [
        { type: "status", text: "Loading Burble context..." },
        {
          type: "final",
          response: {
            classification: "user_private",
            text: "Authenticated to GitHub as `octocat`."
          }
        }
      ]
    });
  });

  test("attaches WebSocket clients to existing run events", async () => {
    let resolveTool!: () => void;
    const toolGate = new Promise<void>((resolve) => {
      resolveTool = resolve;
    });

    const startResponse = await handleRuntimeRequest(
      new Request("http://runtime/runs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          prefer: "respond-async"
        },
        body: JSON.stringify({
          runId: "run-ws",
          runtime: { id: "rt_u123" },
          input: {
            text: "who am I on GitHub?",
            connections: {
              github: {
                connected: true,
                email: "person@example.com"
              }
            }
          }
        })
      }),
      config,
      async () => {
        await toolGate;
        return {
          classification: "user_private" as const,
          content: { login: "octocat" }
        };
      }
    );
    expect(await startResponse.json()).toMatchObject({ runId: "run-ws" });

    const ws = new FakeRuntimeWebSocket();
    attachRuntimeEventWebSocket("run-ws", ws);

    resolveTool();
    for (let index = 0; index < 20 && ws.closeCode === undefined; index += 1) {
      await Bun.sleep(1);
    }

    const events = ws.messages.map((message) => JSON.parse(message));
    expect(events).toContainEqual({
      type: "status",
      text: "Loading Burble context..."
    });
    expect(events.at(-1)).toEqual({
      type: "final",
      response: {
        classification: "user_private",
        text: "Authenticated to GitHub as `octocat`."
      }
    });
    expect(ws.closeCode).toBe(1000);
  });

  test("streams sanitized runtime errors with the underlying message", async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (message?: unknown) => {
      errors.push(String(message));
    };

    try {
      const response = await handleRuntimeRequest(
        new Request("http://runtime/runs", {
          method: "POST",
          headers: {
            accept: "application/x-ndjson",
            "content-type": "application/json"
          },
          body: JSON.stringify({
            runId: "run-timeout",
            runtime: { id: "rt_u123" },
            input: {
              text: "who am I on GitHub?",
              connections: {
                github: {
                  connected: true,
                  email: "person@example.com"
                }
              }
            }
          })
        }),
        config,
        async () => {
          throw new Error("OpenClaw CLI timed out");
        }
      );

      const events = (await response.text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

      expect(events.at(-1)).toEqual({
        type: "error",
        message: "Runtime run failed: OpenClaw CLI timed out"
      });
      expect(errors.join("\n")).toContain("runId=run-timeout");
      expect(errors.join("\n")).toContain("OpenClaw CLI timed out");
    } finally {
      console.error = originalError;
    }
  });

  test("summarizes OpenClaw model quota failures", async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (message?: unknown) => {
      errors.push(String(message));
    };

    try {
      const response = await handleRuntimeRequest(
        new Request("http://runtime/runs", {
          method: "POST",
          headers: {
            accept: "application/x-ndjson",
            "content-type": "application/json"
          },
          body: JSON.stringify({
            runId: "run-quota",
            runtime: { id: "rt_u123" },
            input: {
              text: "who am I on GitHub?",
              connections: {
                github: {
                  connected: true,
                  email: "person@example.com"
                }
              }
            }
          })
        }),
        config,
        async () => {
          throw new Error(
            "OpenClaw CLI exited with code 1: code=insufficient_quota message=You exceeded your current quota"
          );
        }
      );

      const events = (await response.text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

      expect(events.at(-1)).toEqual({
        type: "error",
        message:
          "Runtime run failed: Agent model provider quota is exhausted. Update the selected provider key/billing or switch AI_MODEL to a provider/model with available quota."
      });
      expect(errors.join("\n")).toContain("runId=run-quota");
      expect(errors.join("\n")).toContain("model provider quota is exhausted");
    } finally {
      console.error = originalError;
    }
  });

  test("does not report a runtime failure when the stream client disconnects", async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (message?: unknown) => {
      errors.push(String(message));
    };
    let resolveTool!: () => void;
    const toolGate = new Promise<void>((resolve) => {
      resolveTool = resolve;
    });

    try {
      const response = await handleRuntimeRequest(
        new Request("http://runtime/runs", {
          method: "POST",
          headers: {
            accept: "application/x-ndjson",
            "content-type": "application/json"
          },
          body: JSON.stringify({
            runId: "run-cancelled",
            runtime: { id: "rt_u123" },
            input: {
              text: "who am I on GitHub?",
              connections: {
                github: {
                  connected: true,
                  email: "person@example.com"
                }
              }
            }
          })
        }),
        config,
        async () => {
          await toolGate;
          return {
            classification: "user_private",
            content: { login: "octocat" }
          };
        }
      );

      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      const first = await reader!.read();
      expect(new TextDecoder().decode(first.value)).toContain(
        "Loading Burble context"
      );

      await reader!.cancel();
      resolveTool();
      await Bun.sleep(5);

      expect(errors).toEqual([]);
    } finally {
      console.error = originalError;
    }
  });

  test("delivers local conversation messages through the Burble tool gateway", async () => {
    const requests: Request[] = [];
    const response = await withMockFetch(
      (async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return Response.json({
          classification: "user_private",
          content: {
            ok: true,
            transport: "slack",
            conversationId: "C123",
            messageId: "1779841120.000"
          }
        });
      }) as typeof fetch,
      () =>
        handleRuntimeRequest(
          new Request("http://runtime/internal/conversation/messages", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              jobId: "job-123",
              routeId: "convrt_abcdefabcdefabcdefabcdef",
              text: "hello"
            })
          }),
          {
            ...config,
            runtimeId: "rt_u123"
          }
        )
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      classification: "user_private",
      content: {
        ok: true,
        transport: "slack",
        conversationId: "C123",
        messageId: "1779841120.000"
      }
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(
      "http://burble-app:3000/internal/tools/conversation.sendMessage/execute"
    );
    expect(requests[0].headers.get("authorization")).toBe("Bearer secret");
    expect(requests[0].headers.get("x-burble-runtime-id")).toBe("rt_u123");
    expect(await requests[0].json()).toEqual({
      scheduledJob: {
        jobId: "job-123"
      },
      input: {
        jobId: "job-123",
        routeId: "convrt_abcdefabcdefabcdefabcdef",
        text: "hello"
      }
    });
  });

  test("delivers Burble channel messages with scheduled job identity from the local URL", async () => {
    const requests: Request[] = [];
    const response = await withMockFetch(
      (async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return Response.json({
          classification: "user_private",
          content: { ok: true }
        });
      }) as typeof fetch,
      () =>
        handleRuntimeRequest(
          new Request(
            "http://runtime/internal/burble/channel/routes/convrt_abcdefabcdefabcdefabcdef/messages?jobId=job-123",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                text: "No significant new AI news in the last 15 minutes."
              })
            }
          ),
          {
            ...config,
            runtimeId: "rt_u123"
          }
        )
    );

    expect(response.status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(await requests[0].json()).toEqual({
      scheduledJob: {
        jobId: "job-123"
      },
      input: {
        jobId: "job-123",
        routeId: "convrt_abcdefabcdefabcdefabcdef",
        text: "No significant new AI news in the last 15 minutes."
      }
    });
  });

  test("delivers attachment-only local conversation messages", async () => {
    const requests: Request[] = [];
    const response = await withMockFetch(
      (async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return Response.json({
          classification: "user_private",
          content: { ok: true }
        });
      }) as typeof fetch,
      () =>
        handleRuntimeRequest(
          new Request("http://runtime/internal/burble/channel/routes/convrt_abcdefabcdefabcdefabcdef/messages", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              text: "",
              attachments: [
                {
                  id: "agent:image-1",
                  source: "agent",
                  kind: "image",
                  mimeType: "image/png",
                  name: "preview.png"
                }
              ]
            })
          }),
          {
            ...config,
            runtimeId: "rt_u123"
          }
        )
    );

    expect(response.status).toBe(200);
    expect(await requests[0].json()).toEqual({
      input: {
        routeId: "convrt_abcdefabcdefabcdefabcdef",
        text: "",
        attachments: [
          {
            id: "agent:image-1",
            source: "agent",
            kind: "image",
            mimeType: "image/png",
            name: "preview.png"
          }
        ]
      }
    });
  });

  test("does not use Burble channel thread ids as scheduled delivery job identity", async () => {
    const requests: Request[] = [];
    const response = await withMockFetch(
      (async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return Response.json({
          classification: "user_private",
          content: { ok: true }
        });
      }) as typeof fetch,
      () =>
        handleRuntimeRequest(
          new Request(
            "http://runtime/internal/burble/channel/routes/%23burble-test/messages",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                text: "Cron finished.",
                threadId: "hourly-ai-news-summary-drive-dedupe"
              })
            }
          ),
          {
            ...config,
            runtimeId: "rt_u123"
          }
        )
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain(
      "Burble channel delivery requires a resolved convrt_* route id"
    );
    expect(requests).toHaveLength(0);
  });

  test("forwards unresolved Burble channel labels only with explicit scheduled job identity", async () => {
    const requests: Request[] = [];
    const response = await withMockFetch(
      (async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return Response.json({
          classification: "user_private",
          content: { ok: true }
        });
      }) as typeof fetch,
      () =>
        handleRuntimeRequest(
          new Request(
            "http://runtime/internal/burble/channel/routes/%23burble-test/messages",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                text: "Cron finished.",
                jobId: "hourly-ai-news-summary-drive-dedupe"
              })
            }
          ),
          {
            ...config,
            runtimeId: "rt_u123"
          }
        )
    );

    expect(response.status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(await requests[0].json()).toEqual({
      scheduledJob: {
        jobId: "hourly-ai-news-summary-drive-dedupe"
      },
      input: {
        jobId: "hourly-ai-news-summary-drive-dedupe",
        routeId: "#burble-test",
        text: "Cron finished."
      }
    });
  });

  test("rejects unresolved Burble channel labels without scheduled identity", async () => {
    const requests: Request[] = [];
    const response = await withMockFetch(
      (async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({
          classification: "user_private",
          content: { ok: true }
        });
      }) as typeof fetch,
      () =>
        handleRuntimeRequest(
          new Request(
            "http://runtime/internal/burble/channel/routes/%23burble-test/messages",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                text: "Cron finished."
              })
            }
          ),
          {
            ...config,
            runtimeId: "rt_u123"
          }
        )
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain(
      "Burble channel delivery requires a resolved convrt_* route id"
    );
    expect(requests).toHaveLength(0);
  });

  test("proxies Burble MCP calls with the runtime JWT", async () => {
    const requests: Request[] = [];
    const response = await withMockFetch(
      (async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return new Response(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { content: [] }
          })}\n\n`,
          {
            headers: {
              "content-type": "text/event-stream",
              "mcp-session-id": "session-123"
            }
          }
        );
      }) as typeof fetch,
      () =>
        handleRuntimeRequest(
          new Request("http://runtime/internal/burble/mcp", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              "mcp-protocol-version": "2025-06-18",
              "mcp-session-id": "session-123"
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: {
                name: "github_search_issues",
                arguments: {
                  routeId: "convrt_abcdefabcdefabcdefabcdef",
                  query: "repo:apelogic/burble is:pr"
                }
              }
            })
          }),
          {
            ...config,
            mcpGatewayUrl: "http://burble-app:3000/mcp",
            runtimeJwt: "runtime-jwt"
          }
        )
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBe("session-123");
    expect(await response.text()).toContain('"result":{"content":[]}');
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("http://burble-app:3000/mcp");
    expect(requests[0].headers.get("authorization")).toBe("Bearer runtime-jwt");
    expect(requests[0].headers.get("mcp-protocol-version")).toBe("2025-06-18");
    expect(requests[0].headers.get("mcp-session-id")).toBe("session-123");
    expect(await requests[0].json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "github_search_issues",
        arguments: {
          routeId: "convrt_abcdefabcdefabcdefabcdef",
          query: "repo:apelogic/burble is:pr"
        }
      }
    });
  });

  test("requires route ids or job ids for local Burble MCP tool calls", async () => {
    const requests: Request[] = [];
    const response = await withMockFetch(
      (async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({});
      }) as typeof fetch,
      () =>
        handleRuntimeRequest(
          new Request("http://runtime/internal/burble/mcp", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: {
                name: "github_search_issues",
                arguments: { query: "is:pr" }
              }
            })
          }),
          {
            ...config,
            mcpGatewayUrl: "http://burble-app:3000/mcp",
            runtimeJwt: "runtime-jwt"
          }
        )
    );

    expect(response.status).toBe(200);
    const body = readMcpData(await response.text());
    expect(body.error.message).toBe(
      "Burble provider tools require a routeId or jobId argument."
    );
    expect(requests).toEqual([]);
  });

  test("allows job ids for local scheduled Burble MCP tool calls", async () => {
    const requests: Request[] = [];
    const response = await withMockFetch(
      (async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return new Response(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    classification: "user_private",
                    content: { ok: true }
                  })
                }
              ]
            }
          })}\n\n`,
          { headers: { "content-type": "text/event-stream" } }
        );
      }) as typeof fetch,
      () =>
        handleRuntimeRequest(
          new Request("http://runtime/internal/burble/mcp", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: {
                name: "google_get_drive_file",
                arguments: {
                  fileId: "file-123",
                  jobId: "job-123"
                }
              }
            })
          }),
          {
            ...config,
            mcpGatewayUrl: "http://burble-app:3000/mcp",
            runtimeJwt: "runtime-jwt"
          }
        )
    );

    expect(response.status).toBe(200);
    expect(readMcpData(await response.text()).result.content[0].text).toContain(
      '"ok":true'
    );
    expect(requests).toHaveLength(1);
    expect(await requests[0].json()).toMatchObject({
      method: "tools/call",
      params: {
        name: "google_get_drive_file",
        arguments: {
          fileId: "file-123",
          jobId: "job-123"
        }
      }
    });
  });

  test("rejects non-conversation route ids for local Burble MCP tool calls", async () => {
    const requests: Request[] = [];
    const response = await withMockFetch(
      (async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({});
      }) as typeof fetch,
      () =>
        handleRuntimeRequest(
          new Request("http://runtime/internal/burble/mcp", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: {
                name: "github_search_issues",
                arguments: {
                  query: "is:pr",
                  routeId: "d35c4522-3eab-4b58-ba23-4bd96f75d293"
                }
              }
            })
          }),
          {
            ...config,
            mcpGatewayUrl: "http://burble-app:3000/mcp",
            runtimeJwt: "runtime-jwt"
          }
        )
    );

    expect(response.status).toBe(200);
    const body = readMcpData(await response.text());
    expect(body.error.message).toBe(
      "Burble provider tool routeId must be the active convrt_* conversation route, not a cron job id, run id, session id, or UUID."
    );
    expect(requests).toEqual([]);
  });

  test("adds route and scheduled job identity hints to local Burble MCP tool schemas", async () => {
    const upstreamPayload = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [
          {
            name: "github_search_issues",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string" }
              },
              required: ["query"]
            }
          }
        ]
      }
    };

    const response = await withMockFetch(
      (async (_input, _init) =>
        new Response(`event: message\ndata: ${JSON.stringify(upstreamPayload)}\n\n`, {
          headers: { "content-type": "text/event-stream" }
        })) as typeof fetch,
      () =>
        handleRuntimeRequest(
          new Request("http://runtime/internal/burble/mcp", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/list"
            })
          }),
          {
            ...config,
            mcpGatewayUrl: "http://burble-app:3000/mcp",
            runtimeJwt: "runtime-jwt"
          }
        )
    );

    const body = readMcpData(await response.text());
    const schema = body.result.tools[0].inputSchema;
    expect(schema.properties.routeId).toMatchObject({
      type: "string",
      minLength: 1,
      pattern: "^convrt_[0-9a-f]{24}$"
    });
    expect(schema.properties.routeId.description).toContain(
      "Never use a cron job id"
    );
    expect(schema.properties.jobId).toMatchObject({
      type: "string",
      minLength: 1
    });
    expect(schema.properties.jobId.description).toContain("scheduled");
    expect(schema.required).toEqual(["query"]);
  });

  test("exposes scheduled job registration through local Burble MCP tools/list", async () => {
    const upstreamPayload = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: []
      }
    };

    const response = await withMockFetch(
      (async (_input, _init) =>
        new Response(`event: message\ndata: ${JSON.stringify(upstreamPayload)}\n\n`, {
          headers: { "content-type": "text/event-stream" }
        })) as typeof fetch,
      () =>
        handleRuntimeRequest(
          new Request("http://runtime/internal/burble/mcp", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/list"
            })
          }),
          {
            ...config,
            mcpGatewayUrl: "http://burble-app:3000/mcp",
            runtimeJwt: "runtime-jwt"
          }
        )
    );

    expect(response.status).toBe(200);
    const body = readMcpData(await response.text());
    const tool = body.result.tools.find(
      (entry: { name?: string }) =>
        entry.name === "scheduled_job_register_capability"
    );
    expect(tool).toBeTruthy();
    expect(tool.description).toContain("scheduledJob.registerCapability");
    expect(tool.description).toContain("scheduled Slack destination delivery");
    expect(tool.description).toContain("returned convrt_* route");
    expect(tool.description).toContain("never use a Slack label as delivery.to");
    expect(tool.inputSchema.required).toEqual(["jobId", "requiredTools"]);
    expect(tool.inputSchema.properties.routeId.description).toContain(
      "Never pass a Slack label"
    );
    expect(tool.inputSchema.properties.destination.description).toContain(
      "/agent grant here"
    );
    expect(tool.inputSchema.properties.destination.description).toContain(
      "Pass named Slack channels here"
    );
    expect(tool.inputSchema.properties.visibilityPolicy.description).toContain(
      '"maxOutputVisibility":"public"'
    );
    expect(tool.inputSchema.properties.visibilityPolicy.description).toContain(
      "Do not set allowPrivateToolDeclassification automatically"
    );
    expect(
      tool.inputSchema.properties.visibilityPolicy.properties.maxOutputVisibility
        .enum
    ).toEqual(["public", "user_private", "restricted"]);
    expect(
      tool.inputSchema.properties.visibilityPolicy.properties
        .allowPrivateToolDeclassification.type
    ).toBe("boolean");
    expect(
      tool.inputSchema.properties.visibilityPolicy.additionalProperties
    ).toBe(false);
    expect(tool.inputSchema.properties.stateRefs.description).toContain(
      "objects, never strings"
    );
    const toolNames = body.result.tools.map((entry: { name?: string }) => entry.name);
    expect(toolNames).toContain("scheduled_job_list");
    expect(toolNames).toContain("scheduled_job_create");
    expect(toolNames).toContain("scheduled_job_pause");
    expect(toolNames).toContain("scheduled_job_resume");
    expect(toolNames).toContain("scheduled_job_delete");
    expect(toolNames).toContain("scheduled_job_trigger");
    expect(toolNames).toContain("scheduled_job_validate");
    expect(toolNames).toContain("scheduled_job_show");
    expect(toolNames).toContain("scheduled_job_latest_run_status");
  });

  test("executes scheduled job registration through local Burble MCP", async () => {
    const requests: Request[] = [];
    const response = await withMockFetch(
      (async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return Response.json({
          classification: "user_private",
          content: {
            ok: true,
            scheduledPromptInstruction: "Use job id job-123."
          }
        });
      }) as typeof fetch,
      () =>
        handleRuntimeRequest(
          new Request("http://runtime/internal/burble/mcp", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: {
                name: "scheduled_job_register_capability",
                arguments: {
                  jobId: "job-123",
                  requiredTools: ["google.getDriveFile"],
                  routeId: "convrt_abcdefabcdefabcdefabcdef",
                  visibilityPolicy: {
                    maxOutputVisibility: "public"
                  },
                  stateRefs: [
                    {
                      provider: "google",
                      kind: "drive_file",
                      id: "file-123"
                    }
                  ]
                }
              }
            })
          }),
          {
            ...config,
            runtimeId: "rt_u123",
            mcpGatewayUrl: null,
            runtimeJwt: null
          }
        )
    );

    expect(response.status).toBe(200);
    const body = readMcpData(await response.text());
    expect(body.result.content[0].text).toContain('"ok":true');
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(
      "http://burble-app:3000/internal/tools/scheduledJob.registerCapability/execute"
    );
    expect(requests[0].headers.get("authorization")).toBe("Bearer secret");
    expect(requests[0].headers.get("x-burble-runtime-id")).toBe("rt_u123");
    expect(await requests[0].json()).toEqual({
      input: {
        jobId: "job-123",
        requiredTools: ["google.getDriveFile"],
        routeId: "convrt_abcdefabcdefabcdefabcdef",
        visibilityPolicy: {
          maxOutputVisibility: "public"
        },
        stateRefs: [
          {
            provider: "google",
            kind: "drive_file",
            id: "file-123"
          }
        ]
      }
    });
  });

  test("executes scheduler control tools through local Burble MCP", async () => {
    const requests: Request[] = [];
    const response = await withMockFetch(
      (async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return Response.json({
          classification: "user_private",
          content: {
            ok: true,
            tool: decodeURIComponent(
              new URL(request.url).pathname
                .split("/")
                .at(-2) ?? ""
            )
          }
        });
      }) as typeof fetch,
      () =>
        handleRuntimeRequest(
          new Request("http://runtime/internal/burble/mcp", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: {
                name: "scheduled_job_trigger",
                arguments: {
                  jobId: "job-123"
                }
              }
            })
          }),
          {
            ...config,
            runtimeId: "rt_u123",
            mcpGatewayUrl: null,
            runtimeJwt: null
          }
        )
    );

    expect(response.status).toBe(200);
    const body = readMcpData(await response.text());
    expect(body.result.content[0].text).toContain("scheduledJob.trigger");
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(
      "http://burble-app:3000/internal/tools/scheduledJob.trigger/execute"
    );
    expect(requests[0].headers.get("authorization")).toBe("Bearer secret");
    expect(requests[0].headers.get("x-burble-runtime-id")).toBe("rt_u123");
    expect(await requests[0].json()).toEqual({
      input: {
        jobId: "job-123"
      }
    });
  });

  test("executes scheduled task validation through local Burble MCP", async () => {
    const requests: Request[] = [];
    const response = await withMockFetch(
      (async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return Response.json({
          classification: "user_private",
          content: {
            ok: true,
            validation: {
              ok: true,
              expectedTools: ["github_search_issues"],
              grantedTools: ["github_search_issues"],
              errors: [],
              warnings: []
            }
          }
        });
      }) as typeof fetch,
      () =>
        handleRuntimeRequest(
          new Request("http://runtime/internal/burble/mcp", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: {
                name: "scheduled_job_validate",
                arguments: {
                  jobId: "job-123"
                }
              }
            })
          }),
          {
            ...config,
            runtimeId: "rt_u123",
            mcpGatewayUrl: null,
            runtimeJwt: null
          }
        )
    );

    expect(response.status).toBe(200);
    const body = readMcpData(await response.text());
    expect(body.result.content[0].text).toContain('"validation"');
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(
      "http://burble-app:3000/internal/tools/scheduledJob.validate/execute"
    );
    expect(await requests[0].json()).toEqual({
      input: {
        jobId: "job-123"
      }
    });
  });

  test("executes scheduled task detail reads through local Burble MCP", async () => {
    const requests: Request[] = [];
    const response = await withMockFetch(
      (async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return Response.json({
          classification: "user_private",
          content: {
            ok: true,
            task: {
              taskId: "job-123",
              title: "Open PR monitor"
            }
          }
        });
      }) as typeof fetch,
      () =>
        handleRuntimeRequest(
          new Request("http://runtime/internal/burble/mcp", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: {
                name: "scheduled_job_show",
                arguments: {
                  jobId: "job-123"
                }
              }
            })
          }),
          {
            ...config,
            runtimeId: "rt_u123",
            mcpGatewayUrl: null,
            runtimeJwt: null
          }
        )
    );

    expect(response.status).toBe(200);
    const body = readMcpData(await response.text());
    expect(body.result.content[0].text).toContain('"task"');
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(
      "http://burble-app:3000/internal/tools/scheduledJob.show/execute"
    );
    expect(await requests[0].json()).toEqual({
      input: {
        jobId: "job-123"
      }
    });
  });

  test("executes scheduled job creation through local Burble MCP", async () => {
    const requests: Request[] = [];
    const response = await withMockFetch(
      (async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return Response.json({
          classification: "user_private",
          content: {
            ok: true,
            job: {
              jobId: "job-created-1",
              title: "Hourly AI news summary"
            }
          }
        });
      }) as typeof fetch,
      () =>
        handleRuntimeRequest(
          new Request("http://runtime/internal/burble/mcp", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: {
                name: "scheduled_job_create",
                arguments: {
                  title: "Hourly AI news summary",
                  prompt: "Find fresh AI news and summarize it.",
                  schedule: {
                    kind: "interval",
                    every: { hours: 1 }
                  }
                }
              }
            })
          }),
          {
            ...config,
            runtimeId: "rt_u123",
            mcpGatewayUrl: null,
            runtimeJwt: null
          }
        )
    );

    expect(response.status).toBe(200);
    const body = readMcpData(await response.text());
    expect(body.result.content[0].text).toContain("job-created-1");
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(
      "http://burble-app:3000/internal/tools/scheduledJob.create/execute"
    );
    expect(await requests[0].json()).toEqual({
      input: {
        title: "Hourly AI news summary",
        prompt: "Find fresh AI news and summarize it.",
        schedule: {
          kind: "interval",
          every: { hours: 1 }
        }
      }
    });
  });

  test("delivers Burble channel events through the Burble tool gateway", async () => {
    const requests: Request[] = [];
    const response = await withMockFetch(
      (async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return Response.json({
          classification: "user_private",
          content: {
            ok: true,
            transport: "slack",
            conversationId: "C123",
            messageId: "1779841120.000"
          }
        });
      }) as typeof fetch,
      () =>
        handleRuntimeRequest(
          new Request(
            "http://runtime/internal/burble/channel/routes/convrt_abcdefabcdefabcdefabcdef/events",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                jobId: "job-123",
                runId: "run-123",
                result: {
                  summary: "Open GitHub PRs: none found."
                }
              })
            }
          ),
          {
            ...config,
            runtimeId: "rt_u123"
          }
        )
    );

    expect(response.status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(
      "http://burble-app:3000/internal/tools/conversation.sendMessage/execute"
    );
    expect(await requests[0].json()).toEqual({
      scheduledJob: {
        jobId: "job-123"
      },
      input: {
        jobId: "job-123",
        routeId: "convrt_abcdefabcdefabcdefabcdef",
        text: "Open GitHub PRs: none found."
      }
    });
  });

  test("delivers Burble channel events with scheduled job identity from the local URL", async () => {
    const requests: Request[] = [];
    const response = await withMockFetch(
      (async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return Response.json({
          classification: "user_private",
          content: { ok: true }
        });
      }) as typeof fetch,
      () =>
        handleRuntimeRequest(
          new Request(
            "http://runtime/internal/burble/channel/routes/convrt_abcdefabcdefabcdefabcdef/events?jobId=job-123",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                result: {
                  summary: "No significant new AI news in the last 15 minutes."
                }
              })
            }
          ),
          {
            ...config,
            runtimeId: "rt_u123"
          }
        )
    );

    expect(response.status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(await requests[0].json()).toEqual({
      scheduledJob: {
        jobId: "job-123"
      },
      input: {
        jobId: "job-123",
        routeId: "convrt_abcdefabcdefabcdefabcdef",
        text: "No significant new AI news in the last 15 minutes."
      }
    });
  });

  test("rejects invisible-only Burble channel messages without posting", async () => {
    const requests: Request[] = [];
    const response = await withMockFetch(
      (async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({});
      }) as typeof fetch,
      () =>
        handleRuntimeRequest(
          new Request(
            "http://runtime/internal/burble/channel/routes/convrt_abcdefabcdefabcdefabcdef/messages",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ text: "\u200B" })
            }
          ),
          {
            ...config,
            runtimeId: "rt_u123"
          }
        )
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Invalid Burble channel message input");
    expect(requests).toEqual([]);
  });

  test("accepts Burble channel events without deliverable text without posting", async () => {
    const requests: Request[] = [];
    const response = await withMockFetch(
      (async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({});
      }) as typeof fetch,
      () =>
        handleRuntimeRequest(
          new Request(
            "http://runtime/internal/burble/channel/routes/convrt_abcdefabcdefabcdefabcdef/events",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ jobId: "job-123", status: "ok" })
            }
          ),
          {
            ...config,
            runtimeId: "rt_u123"
          }
        )
    );

    expect(response.status).toBe(202);
    expect(await response.text()).toBe(
      "Burble channel event did not contain deliverable text"
    );
    expect(requests).toEqual([]);
  });

  test("delivers Burble channel events with attachments but no text", async () => {
    const requests: Request[] = [];
    const response = await withMockFetch(
      (async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return Response.json({
          classification: "user_private",
          content: { ok: true }
        });
      }) as typeof fetch,
      () =>
        handleRuntimeRequest(
          new Request(
            "http://runtime/internal/burble/channel/routes/convrt_abcdefabcdefabcdefabcdef/events",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                result: {
                  attachments: [
                    {
                      id: "agent:report-1",
                      source: "agent",
                      kind: "file",
                      mimeType: "text/plain",
                      name: "report.txt"
                    }
                  ]
                }
              })
            }
          ),
          {
            ...config,
            runtimeId: "rt_u123"
          }
        )
    );

    expect(response.status).toBe(200);
    expect(await requests[0].json()).toEqual({
      input: {
        routeId: "convrt_abcdefabcdefabcdefabcdef",
        text: "",
        attachments: [
          {
            id: "agent:report-1",
            source: "agent",
            kind: "file",
            mimeType: "text/plain",
            name: "report.txt"
          }
        ]
      }
    });
  });

  test("ignores invisible-only Burble channel events without posting", async () => {
    const requests: Request[] = [];
    const response = await withMockFetch(
      (async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({});
      }) as typeof fetch,
      () =>
        handleRuntimeRequest(
          new Request(
            "http://runtime/internal/burble/channel/routes/convrt_abcdefabcdefabcdefabcdef/events",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                result: {
                  summary: "\u200B"
                }
              })
            }
          ),
          {
            ...config,
            runtimeId: "rt_u123"
          }
        )
    );

    expect(response.status).toBe(202);
    expect(await response.text()).toBe(
      "Burble channel event did not contain deliverable text"
    );
    expect(requests).toEqual([]);
  });

  test("keeps the previous conversation webhook endpoint as a compatibility alias", async () => {
    const requests: Request[] = [];
    const response = await withMockFetch(
      (async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return Response.json({
          classification: "user_private",
          content: { ok: true }
        });
      }) as typeof fetch,
      () =>
        handleRuntimeRequest(
          new Request(
            "http://runtime/internal/conversation/routes/convrt_abcdefabcdefabcdefabcdef/webhook",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ text: "hello through old path" })
            }
          ),
          {
            ...config,
            runtimeId: "rt_u123"
          }
        )
    );

    expect(response.status).toBe(200);
    expect(await requests[0].json()).toEqual({
      input: {
        routeId: "convrt_abcdefabcdefabcdefabcdef",
        text: "hello through old path"
      }
    });
  });

  test("accepts legacy run manifests without streaming preferences", async () => {
    const response = await handleRuntimeRequest(
      new Request("http://runtime/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runtime: {
            id: "rt_legacy_manifest",
            manifest: {
              version: "1",
              policyHash: "policy",
              skills: [],
              memory: {
                userMemoryEnabled: true,
                workspaceMemoryEnabled: false,
                jobMemoryEnabled: true
              }
            }
          },
          input: {
            text: "hello from an older Burble app",
            connections: {
              github: {
                connected: false
              }
            }
          }
        })
      }),
      config,
      async () => ({
        classification: "user_private",
        content: "Legacy manifest accepted."
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      response: {
        classification: "user_private",
        text: "No Burble tool context is needed for this request."
      }
    });
  });

  test("rejects malformed run requests", async () => {
    const response = await handleRuntimeRequest(
      new Request("http://runtime/runs", {
        method: "POST",
        body: JSON.stringify({ input: { text: "" } })
      }),
      config
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Invalid run request");
  });

  test("rejects malformed runtime tool group selections", async () => {
    const response = await handleRuntimeRequest(
      new Request("http://runtime/runs", {
        method: "POST",
        body: JSON.stringify({
          input: {
            text: "hello",
            toolGroups: {
              groups: ["conversation", "not-a-real-group"],
              reasons: ["test"]
            },
            connections: {
              github: { connected: false }
            }
          }
        })
      }),
      config
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Invalid run request");
  });

  test("rejects malformed runtime metadata", async () => {
    const response = await handleRuntimeRequest(
      new Request("http://runtime/runs", {
        method: "POST",
        body: JSON.stringify({
          runtime: { id: "" },
          input: {
            text: "who am I on GitHub?",
            connections: {
              github: { connected: true }
            }
          }
        })
      }),
      config
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Invalid run request");
  });
});

function contractProbeRequest(input: {
  runId: string;
  text: string;
  scheduled?: boolean;
  attachment?: boolean;
  tools?: Array<{ name: string; alias: string; enabled: boolean }>;
}) {
  return {
    runId: input.runId,
    principal: { workspaceId: "T123", slackUserId: "U123" },
    runtime: {
      id: "rt_probe",
      engine: "openclaw",
      ...(input.tools
        ? {
            manifest: {
              version: "1",
              policyHash: "contract-probe",
              skills: [],
              tools: input.tools.map((tool) => ({
                ...tool,
                provider: "github",
                title: tool.name,
                description: tool.name,
                risk: tool.enabled ? "read" : "low_write",
                routeRequired: true,
                confirmation: "none",
                retrySafe: tool.enabled,
                input:
                  tool.name === "github_search_issues"
                    ? [
                        {
                          name: "query",
                          type: "string",
                          required: true
                        }
                      ]
                    : []
              })),
              memory: {
                userMemoryEnabled: false,
                workspaceMemoryEnabled: false,
                jobMemoryEnabled: false
              },
              streaming: { messageDeltasEnabled: true }
            }
          }
        : {})
    },
    input: {
      text: input.text,
      ...(input.scheduled
        ? {
            scheduledJob: {
              jobId: "contract-scheduled-job",
              capabilityProfile: "contract-probe",
              allowedTools: ["runtime.conformance.echo"],
              routeId: "convrt_111111111111111111111111",
              stateRefs: [],
              visibilityPolicy: {
                maxOutputVisibility: "user_private",
                allowPrivateToolDeclassification: false
              }
            }
          }
        : {}),
      ...(input.attachment
        ? {
            attachments: [
              {
                id: "attcap_contract_probe",
                source: "slack",
                kind: "file",
                name: "contract-attachment.txt",
                mimeType: "text/plain",
                sizeBytes: 27
              }
            ]
          }
        : {}),
      conversation: {
        source: "slack",
        workspaceId: "T123",
        channelId: "D123",
        rootId: "dm:D123",
        isDirectMessage: true
      },
      connections: {
        github: { connected: false }
      }
    }
  };
}

function readNdjsonEvents(text: string): unknown[] {
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readMcpData(text: string): any {
  const dataLine = text
    .split("\n")
    .find((line) => line.startsWith("data: "));
  if (!dataLine) {
    throw new Error(`Missing MCP data line in response: ${text}`);
  }
  return JSON.parse(dataLine.slice("data: ".length));
}
