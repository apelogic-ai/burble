import { describe, expect, test } from "bun:test";
import { createOpenClawNemoClawAgentRunner } from "../../src/agent/runners/openclaw-nemoclaw";
import { parseRuntimeRunRequest } from "@burble/runtime-sdk/runtime-contract";
import type { RuntimeCapabilityManifest } from "@burble/runtime-sdk/runtime-contract";
import type { RuntimeManifest } from "../../src/agent/runtime-manifest";
import { collectAgentRun } from "../../src/agent/types";
import type { ProviderConnection } from "../../src/db";
import type { ObservabilityEventInput } from "../../src/observability";

const connection: ProviderConnection = {
  provider: "github",
  email: "person@example.com",
  slackUserId: "U123",
  providerLogin: "octocat",
  accessToken: "secret-token",
  connectedAt: "2026-05-19T00:00:00Z"
};

const principal = {
  workspaceId: "T123",
  slackUserId: "U123"
};

const conversation = {
  source: "slack" as const,
  workspaceId: "T123",
  channelId: "D123",
  rootId: "dm:D123",
  isDirectMessage: true
};

const openClawCapabilityManifest: RuntimeCapabilityManifest = {
  runtimeType: "openclaw",
  version: "1",
  transports: ["http", "websocket"],
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
};

function runtimeManifest(input?: {
  streaming?: RuntimeManifest["streaming"];
  engine?: RuntimeManifest["runtime"]["engine"];
  tools?: RuntimeManifest["tools"];
}): RuntimeManifest {
  return {
    version: "1",
    principal,
    runtime: {
      engine: input?.engine ?? "openclaw",
      factory: "docker",
      ttlMs: 86_400_000,
      reaperEnabled: true
    },
    model: {
      provider: "openai",
      model: "gpt-5.4"
    },
    tools: input?.tools ?? [],
    skills: [],
    memory: {
      userMemoryEnabled: false,
      workspaceMemoryEnabled: false,
      jobMemoryEnabled: true
    },
    streaming: input?.streaming ?? {
      messageDeltasEnabled: true
    },
    memoryContext: [],
    disabledTools: [],
    policyHash: input?.streaming?.messageDeltasEnabled === false
      ? "policy-streaming-off"
      : "policy-streaming-on"
  };
}

function sseEvent(event: unknown): string {
  const type =
    typeof event === "object" && event !== null && "type" in event
      ? String(event.type)
      : "message";
  return `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
}

class FakeRuntimeWebSocket {
  readonly listeners = {
    message: [] as Array<(event: { data?: unknown }) => void>,
    error: [] as Array<(event: { data?: unknown }) => void>,
    close: [] as Array<(event: { data?: unknown }) => void>
  };
  closed = false;

  constructor(readonly url: string) {}

  addEventListener(
    type: "message" | "error" | "close",
    listener: (event: { data?: unknown }) => void
  ): void {
    this.listeners[type].push(listener);
  }

  sendEvent(event: unknown): void {
    for (const listener of this.listeners.message) {
      listener({ data: JSON.stringify(event) });
    }
  }

  closeFromRuntime(): void {
    for (const listener of this.listeners.close) {
      listener({});
    }
  }

  close(): void {
    this.closed = true;
  }
}

async function waitForSocket(
  sockets: FakeRuntimeWebSocket[]
): Promise<FakeRuntimeWebSocket> {
  for (let index = 0; index < 20; index += 1) {
    if (sockets[0]) {
      return sockets[0];
    }
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for fake runtime WebSocket");
}

describe("createOpenClawNemoClawAgentRunner", () => {
  test("posts a sanitized run request to the remote runtime", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const runner = createOpenClawNemoClawAgentRunner({
      baseUrl: "http://openclaw-runtime:8080/",
      fetch: async (url, init) => {
        requests.push({ url: String(url), init: init ?? {} });

        return new Response(
          JSON.stringify({
            response: {
              classification: "user_private",
              text: "You have one issue."
            }
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }
    });

    const result = await collectAgentRun(runner, {
      principal,
      executionMode: "native-runtime",
      conversation,
      text: "summarize my GitHub work",
      toolGroups: {
        groups: ["conversation", "github"],
        reasons: ["default:conversation", "keyword:github:github"]
      },
      scheduledJob: {
        jobId: "job-123",
        capabilityProfile: "scheduled_job",
        allowedTools: ["github_list_my_pull_requests"],
        routeId: "convrt_123",
        runtimeType: "openclaw",
        stateRefs: [],
        visibilityPolicy: {
          maxOutputVisibility: "user_private"
        }
      },
      attachments: [
        {
          id: "slack:F123",
          externalId: "F123",
          source: "slack",
          kind: "image",
          mimeType: "image/png",
          name: "screenshot.png",
          sizeBytes: 2048
        }
      ],
      connections: { github: connection }
    });

    expect(result).toEqual({
      classification: "user_private",
      text: "You have one issue."
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("http://openclaw-runtime:8080/runs");
    expect(requests[0].init.method).toBe("POST");
    expect(requests[0].init.headers).toEqual({
      accept: "application/json",
      "content-type": "application/json",
      prefer: "respond-async"
    });

    const body = JSON.parse(String(requests[0].init.body));
    expect(body).toMatchObject({
      principal,
      executionMode: "native-runtime",
      input: {
        text: "summarize my GitHub work",
        toolGroups: {
          groups: ["conversation", "github"],
          reasons: ["default:conversation", "keyword:github:github"]
        },
        attachments: [
          {
            id: "slack:F123",
            externalId: "F123",
            source: "slack",
            kind: "image",
            mimeType: "image/png",
            name: "screenshot.png",
            sizeBytes: 2048
          }
        ],
        conversation,
        scheduledJob: {
          jobId: "job-123",
          capabilityProfile: "scheduled_job",
          allowedTools: ["github_list_my_pull_requests"],
          routeId: "convrt_123",
          runtimeType: "openclaw",
          stateRefs: [],
          visibilityPolicy: {
            maxOutputVisibility: "user_private"
          }
        },
        connections: {
          github: {
            connected: true,
            email: "person@example.com",
            providerLogin: "octocat"
          }
        }
      }
    });
    expect(body.runId).toBeString();
    expect(JSON.stringify(body)).not.toContain("secret-token");
  });

  test("sends the runtime tool catalog to managed runtimes", async () => {
    const toolCatalog: RuntimeManifest["tools"] = [
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
      }
    ];
    const seenRunBodies: Record<string, unknown>[] = [];
    const runner = createOpenClawNemoClawAgentRunner({
      runtimeFactory: {
        async getOrCreateRuntime() {
          const runIndex = seenRunBodies.length;
          const engine = runIndex === 0 ? "openclaw" : "burble-native";
          return {
            id: `rt_${engine}`,
            engine,
            endpointUrl: `http://${engine}-runtime:8080`,
            authToken: "runtime-token",
            status: "ready",
            statePath: `/data/runtimes/rt_${engine}/state`,
            configPath: `/data/runtimes/rt_${engine}/config/runtime.json`,
            workspacePath: `/data/runtimes/rt_${engine}/workspace`,
            manifest: runtimeManifest({ engine, tools: toolCatalog })
          };
        },
        async stopRuntime() {},
        async reapIdleRuntimes() {}
      },
      fetch: async (url, init) => {
        if (String(url).endsWith("/capabilities")) {
          const runtimeType = String(url).includes("burble-native")
            ? "burble-native"
            : "openclaw";
          return Response.json({
            ...openClawCapabilityManifest,
            runtimeType
          });
        }
        seenRunBodies.push(JSON.parse(String(init.body)));
        return Response.json({
          response: {
            classification: "user_private",
            text: "ok"
          }
        });
      }
    });

    await collectAgentRun(runner, {
      principal,
      conversation,
      text: "first",
      connections: { github: connection }
    });
    await collectAgentRun(runner, {
      principal,
      conversation,
      text: "second",
      connections: { github: connection }
    });

    expect(
      (seenRunBodies[0].runtime as { manifest?: { tools?: unknown } }).manifest
        ?.tools
    ).toEqual(toolCatalog);
    expect(
      (seenRunBodies[1].runtime as { manifest?: { tools?: unknown } }).manifest
        ?.tools
    ).toEqual(toolCatalog);
  });

  test("builds SDK-parseable run requests for Burble Native runtimes", async () => {
    const requests: Array<{ body: unknown }> = [];
    const runner = createOpenClawNemoClawAgentRunner({
      runtimeFactory: {
        async getOrCreateRuntime() {
          return {
            id: "rt_burble_native",
            engine: "burble-native",
            endpointUrl: "http://burble-native-runtime:8080",
            authToken: "runtime-token",
            status: "ready",
            statePath: "/data/runtimes/rt_burble_native/state",
            configPath: "/data/runtimes/rt_burble_native/config/runtime.json",
            workspacePath: "/data/runtimes/rt_burble_native/workspace",
            manifest: runtimeManifest({
              engine: "burble-native",
              tools: []
            })
          };
        },
        async stopRuntime() {},
        async reapIdleRuntimes() {}
      },
      fetch: async (url, init) => {
        if (String(url).endsWith("/capabilities")) {
          return Response.json({
            ...openClawCapabilityManifest,
            runtimeType: "burble-native",
            nativeScheduler: false,
            scheduledProviderCalls: false,
            multimodalInput: false,
            memory: false,
            durableWorkflowState: false,
            attachments: false,
            toolBridgeModes: ["tool_gateway"]
          });
        }
        const body = JSON.parse(String(init.body));
        requests.push({ body });
        return Response.json({
          response: {
            classification: "user_private",
            text: "ok"
          }
        });
      }
    });

    await collectAgentRun(runner, {
      principal,
      conversation,
      text: "hello agent",
      toolGroups: {
        groups: ["conversation"],
        reasons: ["default:conversation"]
      },
      connections: { github: connection }
    });

    expect(requests).toHaveLength(1);
    const request = parseRuntimeRunRequest(requests[0].body);
    expect(request.runtime.engine).toBe("burble-native");
    expect(request.runtime.status).toBe("ready");
  });

  test("bounds Slack context before posting to any remote runtime", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const runner = createOpenClawNemoClawAgentRunner({
      baseUrl: "http://runtime:8080",
      fetch: async (url, init) => {
        requests.push({ url: String(url), init: init ?? {} });
        return Response.json({
          response: {
            classification: "user_private",
            text: "Bounded context."
          }
        });
      }
    });

    await collectAgentRun(runner, {
      principal,
      conversation,
      text: "summarize this channel",
      context: {
        currentChannel: {
          id: "D123",
          isDirectMessage: true,
          historyAvailable: true
        },
        recentMessages: Array.from({ length: 20 }, (_, index) => ({
          author: "user" as const,
          speaker: "Leo",
          text:
            index === 0
              ? "old message should not cross the runtime boundary"
              : `recent message ${index + 1} ${"x".repeat(500)}`
        }))
      },
      connections: { github: null }
    });

    const body = JSON.parse(String(requests[0].init.body));
    expect(body.input.context.recentMessages).toHaveLength(12);
    expect(JSON.stringify(body.input.context)).not.toContain(
      "old message should not cross the runtime boundary"
    );
    expect(body.input.context.recentMessages.at(-1).text.length).toBeLessThanOrEqual(
      320
    );
    expect(body.input.context).toMatchObject({
      currentChannel: {
        id: "D123",
        isDirectMessage: true,
        historyAvailable: true
      }
    });
  });

  test("routes requests through a principal-scoped runtime factory", async () => {
    const principals: unknown[] = [];
    const runtimeEvents: unknown[] = [];
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const runner = createOpenClawNemoClawAgentRunner({
      runtimeFactory: {
        async getOrCreateRuntime(runtimePrincipal) {
          principals.push(runtimePrincipal);
          return {
            id: "rt_u123",
            engine: "openclaw",
            endpointUrl: "http://runtime-u123:8080/",
            authToken: "runtime-token",
            status: "ready",
            statePath: "/data/runtimes/rt_u123/state",
            configPath: "/data/runtimes/rt_u123/config/openclaw.json",
            workspacePath: "/data/runtimes/rt_u123/workspace"
          };
        },
        async stopRuntime() {},
        async reapIdleRuntimes() {},
        recordRuntimeEvent(runtimeId, event) {
          runtimeEvents.push({ runtimeId, ...event });
        }
      },
      fetch: async (url, init) => {
        requests.push({ url: String(url), init: init ?? {} });
        if (String(url).endsWith("/capabilities")) {
          return Response.json(openClawCapabilityManifest);
        }
        return Response.json({
          response: {
            classification: "user_private",
            text: "Runtime answer."
          }
        });
      }
    });

    const result = await collectAgentRun(runner, {
      principal,
      conversation,
      text: "summarize my GitHub work",
      scheduledJob: {
        jobId: "job-123",
        capabilityProfile: "scheduled_job",
        allowedTools: ["github_list_my_pull_requests"],
        routeId: "convrt_abc123",
        runtimeType: "openclaw",
        stateRefs: [
          {
            provider: "google",
            kind: "drive_file",
            id: "file-123",
            purpose: "dedupe_state"
          }
        ],
        visibilityPolicy: {
          maxOutputVisibility: "public",
          allowPrivateToolDeclassification: false
        }
      },
      connections: { github: connection }
    });

    expect(result.text).toBe("Runtime answer.");
    expect(principals).toEqual([principal]);
    expect(requests[0].url).toBe("http://runtime-u123:8080/capabilities");
    expect(requests[0].init.headers).toEqual({
      authorization: "Bearer runtime-token",
      "x-burble-runtime-token": "runtime-token",
      "x-burble-runtime-id": "rt_u123"
    });
    expect(requests[1].url).toBe("http://runtime-u123:8080/runs");
    expect(requests[1].init.headers).toEqual({
      accept: "application/json",
      authorization: "Bearer runtime-token",
      "content-type": "application/json",
      prefer: "respond-async",
      "x-burble-runtime-token": "runtime-token",
      "x-burble-runtime-id": "rt_u123"
    });
    expect(JSON.parse(String(requests[1].init.body))).toMatchObject({
      runtime: {
        id: "rt_u123",
        engine: "openclaw",
        status: "ready"
      }
    });
    expect(String(requests[1].init.body)).not.toContain("runtime-token");
    expect(runtimeEvents).toEqual([
      {
        runtimeId: "rt_u123",
        eventType: "runtime_run_started",
        summary: {
          conversationRoot: "dm:D123",
          textLength: 24,
          githubConnected: true,
          googleConnected: false,
          jiraConnected: false,
          slackConnected: false,
          scheduledJob: {
            jobId: "job-123",
            capabilityProfile: "scheduled_job",
            allowedToolCount: 1,
            routeId: "convrt_abc123",
            runtimeType: "openclaw",
            stateRefCount: 1,
            maxOutputVisibility: "public",
            allowPrivateToolDeclassification: false
          },
          runtimeCapabilities: {
            runtimeType: "openclaw",
            transports: ["http", "websocket"],
            streaming: true,
            nativeScheduler: true,
            scheduledProviderCalls: true,
            toolCalls: true,
            toolBridgeModes: ["tool_gateway", "mcp"],
            usageReporting: "exact",
            multimodalInput: true,
            attachments: true,
            jobScopedAuth: true
          }
        }
      },
      {
        runtimeId: "rt_u123",
        eventType: "runtime_run_finished",
        summary: {
          classification: "user_private",
          textLength: 15
        }
      }
    ]);
  });

  test("continues when an older managed runtime has no capabilities endpoint", async () => {
    const observabilityEvents: ObservabilityEventInput[] = [];
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const runner = createOpenClawNemoClawAgentRunner({
      runtimeFactory: {
        async getOrCreateRuntime() {
          return {
            id: "rt_legacy",
            engine: "openclaw",
            endpointUrl: "http://runtime-legacy:8080/",
            authToken: "runtime-token",
            status: "ready",
            statePath: "/data/runtimes/rt_legacy/state",
            configPath: "/data/runtimes/rt_legacy/config/openclaw.json",
            workspacePath: "/data/runtimes/rt_legacy/workspace"
          };
        },
        async stopRuntime() {},
        async reapIdleRuntimes() {},
        recordRuntimeEvent() {}
      },
      observability: {
        emit(event) {
          observabilityEvents.push(event);
        }
      },
      fetch: async (url, init) => {
        requests.push({ url: String(url), init: init ?? {} });
        if (String(url).endsWith("/capabilities")) {
          return new Response("not found", { status: 404 });
        }
        return Response.json({
          response: {
            classification: "user_private",
            text: "Legacy runtime answer."
          }
        });
      }
    });

    const result = await collectAgentRun(runner, {
      principal,
      conversation,
      text: "hello",
      connections: { github: null }
    });

    expect(result.text).toBe("Legacy runtime answer.");
    expect(requests.map((request) => request.url)).toEqual([
      "http://runtime-legacy:8080/capabilities",
      "http://runtime-legacy:8080/runs"
    ]);
    expect(observabilityEvents.map((event) => event.name)).toEqual([
      "runtime.capabilities.unavailable",
      "runtime.run.started",
      "runtime.run.accepted",
      "runtime.run.completed"
    ]);
  });

  test("continues when managed runtime capability discovery returns invalid data", async () => {
    const observabilityEvents: ObservabilityEventInput[] = [];
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const runner = createOpenClawNemoClawAgentRunner({
      runtimeFactory: {
        async getOrCreateRuntime() {
          return {
            id: "rt_bad_manifest",
            engine: "openclaw",
            endpointUrl: "http://runtime-bad-manifest:8080/",
            authToken: "runtime-token",
            status: "ready",
            statePath: "/data/runtimes/rt_bad_manifest/state",
            configPath: "/data/runtimes/rt_bad_manifest/config/openclaw.json",
            workspacePath: "/data/runtimes/rt_bad_manifest/workspace"
          };
        },
        async stopRuntime() {},
        async reapIdleRuntimes() {},
        recordRuntimeEvent() {}
      },
      observability: {
        emit(event) {
          observabilityEvents.push(event);
        }
      },
      fetch: async (url, init) => {
        requests.push({ url: String(url), init: init ?? {} });
        if (String(url).endsWith("/capabilities")) {
          return Response.json({ runtimeType: "openclaw" });
        }
        return Response.json({
          response: {
            classification: "user_private",
            text: "Runtime answer despite bad manifest."
          }
        });
      }
    });

    const result = await collectAgentRun(runner, {
      principal,
      conversation,
      text: "hello",
      connections: { github: null }
    });

    expect(result.text).toBe("Runtime answer despite bad manifest.");
    expect(requests.map((request) => request.url)).toEqual([
      "http://runtime-bad-manifest:8080/capabilities",
      "http://runtime-bad-manifest:8080/runs"
    ]);
    expect(observabilityEvents.map((event) => event.name)).toEqual([
      "runtime.capabilities.unavailable",
      "runtime.run.started",
      "runtime.run.accepted",
      "runtime.run.completed"
    ]);
  });

  test("caches managed runtime capabilities for repeated runs", async () => {
    const observabilityEvents: ObservabilityEventInput[] = [];
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const runner = createOpenClawNemoClawAgentRunner({
      runtimeFactory: {
        async getOrCreateRuntime() {
          return {
            id: "rt_cache",
            engine: "openclaw",
            endpointUrl: "http://runtime-cache:8080/",
            authToken: "runtime-token",
            status: "ready",
            statePath: "/data/runtimes/rt_cache/state",
            configPath: "/data/runtimes/rt_cache/config/openclaw.json",
            workspacePath: "/data/runtimes/rt_cache/workspace"
          };
        },
        async stopRuntime() {},
        async reapIdleRuntimes() {},
        recordRuntimeEvent() {}
      },
      observability: {
        emit(event) {
          observabilityEvents.push(event);
        }
      },
      fetch: async (url, init) => {
        requests.push({ url: String(url), init: init ?? {} });
        if (String(url).endsWith("/capabilities")) {
          return Response.json(openClawCapabilityManifest);
        }
        return Response.json({
          response: {
            classification: "user_private",
            text: "Runtime answer."
          }
        });
      }
    });

    await collectAgentRun(runner, {
      principal,
      conversation,
      text: "hello one",
      connections: { github: null }
    });
    await collectAgentRun(runner, {
      principal,
      conversation,
      text: "hello two",
      connections: { github: null }
    });

    expect(
      requests.filter((request) => request.url.endsWith("/capabilities"))
    ).toHaveLength(1);
    expect(requests.filter((request) => request.url.endsWith("/runs"))).toHaveLength(
      2
    );
    expect(
      observabilityEvents.filter(
        (event) => event.name === "runtime.capabilities.discovered"
      )
    ).toHaveLength(1);
  });

  test("rejects a managed runtime whose capabilities report a different engine", async () => {
    const runner = createOpenClawNemoClawAgentRunner({
      runtimeFactory: {
        async getOrCreateRuntime() {
          return {
            id: "rt_u123",
            engine: "openclaw",
            endpointUrl: "http://runtime-u123:8080/",
            authToken: "runtime-token",
            status: "ready",
            statePath: "/data/runtimes/rt_u123/state",
            configPath: "/data/runtimes/rt_u123/config/openclaw.json",
            workspacePath: "/data/runtimes/rt_u123/workspace"
          };
        },
        async stopRuntime() {},
        async reapIdleRuntimes() {},
        recordRuntimeEvent() {}
      },
      fetch: async (url) => {
        if (String(url).endsWith("/capabilities")) {
          return Response.json({
            ...openClawCapabilityManifest,
            runtimeType: "hermes"
          });
        }
        return Response.json({
          response: {
            classification: "user_private",
            text: "Should not run."
          }
        });
      }
    });

    await expect(
      collectAgentRun(runner, {
        principal,
        conversation,
        text: "hello",
        connections: { github: null }
      })
    ).rejects.toThrow(
      "Runtime capability manifest type hermes does not match runtime engine openclaw"
    );
  });

  test("accepts OpenClaw family capability aliases", async () => {
    const runner = createOpenClawNemoClawAgentRunner({
      runtimeFactory: {
        async getOrCreateRuntime() {
          return {
            id: "rt_openclaw_family",
            engine: "openclaw",
            endpointUrl: "http://runtime-openclaw-family:8080/",
            authToken: "runtime-token",
            status: "ready",
            statePath: "/data/runtimes/rt_openclaw_family/state",
            configPath: "/data/runtimes/rt_openclaw_family/config/openclaw.json",
            workspacePath: "/data/runtimes/rt_openclaw_family/workspace"
          };
        },
        async stopRuntime() {},
        async reapIdleRuntimes() {},
        recordRuntimeEvent() {}
      },
      fetch: async (url) => {
        if (String(url).endsWith("/capabilities")) {
          return Response.json({
            ...openClawCapabilityManifest,
            runtimeType: "openclaw-gateway"
          });
        }
        return Response.json({
          response: {
            classification: "user_private",
            text: "OpenClaw family runtime answer."
          }
        });
      }
    });

    const result = await collectAgentRun(runner, {
      principal,
      conversation,
      text: "hello",
      connections: { github: null }
    });

    expect(result.text).toBe("OpenClaw family runtime answer.");
  });

  test("emits observability events for remote runtime calls", async () => {
    const observabilityEvents: ObservabilityEventInput[] = [];
    const runner = createOpenClawNemoClawAgentRunner({
      runtimeFactory: {
        async getOrCreateRuntime() {
          return {
            id: "rt_u123",
            engine: "openclaw",
            endpointUrl: "http://runtime-u123:8080/",
            authToken: "runtime-token",
            status: "ready",
            statePath: "/data/runtimes/rt_u123/state",
            configPath: "/data/runtimes/rt_u123/config/openclaw.json",
            workspacePath: "/data/runtimes/rt_u123/workspace"
          };
        },
        async stopRuntime() {},
        async reapIdleRuntimes() {},
        recordRuntimeEvent() {}
      },
      observability: {
        emit: (event) => {
          observabilityEvents.push(event);
        }
      },
      fetch: async (url) => {
        if (String(url).endsWith("/capabilities")) {
          return Response.json(openClawCapabilityManifest);
        }
        return Response.json({
          response: {
            classification: "user_private",
            text: "Runtime answer.",
            usage: {
              inputTokens: 12,
              outputTokens: 4,
              totalTokens: 16
            },
            telemetry: {
              promptChars: 4096,
              promptApproxTokens: 1024,
              steps: [
                {
                  step: 1,
                  usageSource: "provider-output"
                }
              ]
            }
          }
        });
      }
    });

    const result = await collectAgentRun(runner, {
      principal,
      conversation,
      text: "summarize my GitHub work",
      scheduledJob: {
        jobId: "job-123",
        capabilityProfile: "scheduled_job",
        allowedTools: ["github_list_my_pull_requests"],
        routeId: "convrt_abc123",
        runtimeType: "openclaw",
        stateRefs: [
          {
            provider: "google",
            kind: "drive_file",
            id: "file-123",
            purpose: "dedupe_state"
          }
        ],
        visibilityPolicy: {
          maxOutputVisibility: "public",
          allowPrivateToolDeclassification: false
        }
      },
      connections: { github: connection }
    });

    expect(result.text).toBe("Runtime answer.");
    expect(observabilityEvents.map((event) => event.name)).toEqual([
      "runtime.capabilities.discovered",
      "runtime.run.started",
      "runtime.run.accepted",
      "runtime.run.completed"
    ]);
    expect(observabilityEvents[0]).toMatchObject({
      workspaceId: "T123",
      principalId: "T123:U123",
      runtimeId: "rt_u123",
      runtimeType: "openclaw",
      status: "ok",
      attributes: {
        transports: ["http", "websocket"],
        streaming: true,
        nativeScheduler: true,
        scheduledProviderCalls: true,
        toolCalls: true,
        toolBridgeModes: ["tool_gateway", "mcp"],
        usageReporting: "exact",
        multimodalInput: true,
        attachments: true,
        jobScopedAuth: true
      }
    });
    expect(observabilityEvents[1]).toMatchObject({
      workspaceId: "T123",
      principalId: "T123:U123",
      runtimeId: "rt_u123",
      runtimeType: "openclaw",
      attributes: {
        conversationRoot: "dm:D123",
        textLength: 24,
        githubConnected: true,
        scheduledJob: {
          jobId: "job-123",
          capabilityProfile: "scheduled_job",
          allowedToolCount: 1,
          routeId: "convrt_abc123",
          runtimeType: "openclaw",
          stateRefCount: 1,
          maxOutputVisibility: "public",
          allowPrivateToolDeclassification: false
        },
        runtimeCapabilities: {
          runtimeType: "openclaw",
          transports: ["http", "websocket"],
          streaming: true,
          nativeScheduler: true,
          scheduledProviderCalls: true,
          toolCalls: true,
          toolBridgeModes: ["tool_gateway", "mcp"],
          usageReporting: "exact",
          multimodalInput: true,
          attachments: true,
          jobScopedAuth: true
        }
      }
    });
    expect(observabilityEvents[2]).toMatchObject({
      runtimeId: "rt_u123",
      runtimeType: "openclaw",
      status: "ok",
      attributes: {
        httpStatus: 200
      }
    });
    expect(observabilityEvents[3]).toMatchObject({
      runtimeId: "rt_u123",
      runtimeType: "openclaw",
      classification: "user_private",
      status: "ok",
      usage: {
        inputTokens: 12,
        outputTokens: 4,
        totalTokens: 16
      },
      attributes: {
        telemetry: {
          promptChars: 4096,
          promptApproxTokens: 1024,
          steps: [
            {
              step: 1,
              usageSource: "provider-output"
            }
          ]
        }
      }
    });
    expect(
      new Set(
        observabilityEvents
          .filter((event) => event.name.startsWith("runtime.run."))
          .map((event) => event.runId)
      ).size
    ).toBe(1);
    expect(JSON.stringify(observabilityEvents)).not.toContain("runtime-token");
    expect(JSON.stringify(observabilityEvents)).not.toContain("secret-token");
  });

  test("streams remote runtime events over WebSocket before returning the final response", async () => {
    const sockets: FakeRuntimeWebSocket[] = [];
    const runner = createOpenClawNemoClawAgentRunner({
      baseUrl: "http://openclaw-runtime:8080",
      fetch: async () =>
        Response.json({
          runId: "run-1",
          eventsUrl: "/runs/run-1/events"
        }),
      webSocketFactory: (url) => {
        const socket = new FakeRuntimeWebSocket(url);
        sockets.push(socket);
        return socket;
      }
    });
    const events: string[] = [];

    const resultPromise = collectAgentRun(
      runner,
      {
        principal,
        conversation,
        text: "summarize my GitHub work",
        connections: { github: connection }
      },
      (event) => {
        events.push(`${event.type}:${"text" in event ? event.text : ""}`);
      }
    );
    const socket = await waitForSocket(sockets);

    expect(socket.url).toBe("ws://openclaw-runtime:8080/runs/run-1/events");
    socket.sendEvent({ type: "status", text: "Loading context..." });
    socket.sendEvent({
      type: "tool_call",
      toolName: "jira.searchIssues",
      callId: "call-1"
    });
    socket.sendEvent({
      type: "tool_result",
      toolName: "jira.searchIssues",
      callId: "call-1",
      classification: "user_private"
    });
    socket.sendEvent({ type: "message_delta", text: "Partial answer" });
    socket.sendEvent({
      type: "final",
      response: {
        classification: "user_private",
        text: "Final answer"
      }
    });

    const result = await resultPromise;

    expect(events).toEqual([
      "status:Starting agent runtime...",
      "status:Agent is thinking...",
      "status:Loading context...",
      "tool_call:",
      "tool_result:",
      "message_delta:Partial answer"
    ]);
    expect(result).toEqual({
      classification: "user_private",
      text: "Final answer"
    });
  });

  test("prefers NDJSON run events over WebSocket when the runtime advertises HTTP streaming", async () => {
    const calls: Array<{ url: string; method: string; accept: string | null }> = [];
    const webSocketCalls: string[] = [];
    const runner = createOpenClawNemoClawAgentRunner({
      runtimeFactory: {
        async getOrCreateRuntime() {
          return {
            id: "rt_openclaw",
            engine: "openclaw",
            endpointUrl: "http://openclaw-runtime:8080",
            authToken: "runtime-token",
            status: "ready",
            statePath: "/runtime/state",
            configPath: "/runtime/config/openclaw.json",
            workspacePath: "/runtime/workspace",
            manifest: runtimeManifest()
          };
        },
        async stopRuntime() {},
        async reapIdleRuntimes() {}
      },
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers);
        calls.push({
          url: String(url),
          method: init?.method ?? "GET",
          accept: headers.get("accept")
        });
        if (String(url).endsWith("/capabilities")) {
          return Response.json({
            ...openClawCapabilityManifest,
            transports: ["http", "ndjson", "websocket"]
          });
        }
        return new Response(
          [
            JSON.stringify({ type: "status", text: "Loading context..." }),
            JSON.stringify({
              type: "tool_call",
              toolName: "jira.searchIssues",
              callId: "call-1"
            }),
            JSON.stringify({
              type: "tool_result",
              toolName: "jira.searchIssues",
              callId: "call-1",
              classification: "user_private"
            }),
            JSON.stringify({ type: "message_delta", text: "Partial answer" }),
            JSON.stringify({
              type: "final",
              response: {
                classification: "user_private",
                text: "Final answer"
              }
            })
          ].join("\n"),
          {
            headers: {
              "content-type": "application/x-ndjson; charset=utf-8"
            }
          }
        );
      },
      webSocketFactory: (url) => {
        webSocketCalls.push(url);
        throw new Error("unexpected WebSocket connection");
      }
    });
    const events: string[] = [];

    const result = await collectAgentRun(
      runner,
      {
        principal,
        conversation,
        text: "summarize my GitHub work",
        connections: { github: connection }
      },
      (event) => {
        events.push(`${event.type}:${"text" in event ? event.text : ""}`);
      }
    );

    expect(calls).toEqual([
      {
        url: "http://openclaw-runtime:8080/capabilities",
        method: "GET",
        accept: null
      },
      {
        url: "http://openclaw-runtime:8080/runs",
        method: "POST",
        accept: "application/x-ndjson"
      }
    ]);
    expect(webSocketCalls).toEqual([]);
    expect(events).toEqual([
      "status:Starting agent runtime...",
      "status:Agent is thinking...",
      "status:Loading context...",
      "tool_call:",
      "tool_result:",
      "message_delta:Partial answer"
    ]);
    expect(result).toEqual({
      classification: "user_private",
      text: "Final answer"
    });
  });

  test("accepts attachment-only final responses from managed runtimes", async () => {
    const runner = createOpenClawNemoClawAgentRunner({
      baseUrl: "http://openclaw-runtime:8080",
      fetch: async (url) => {
        if (String(url).endsWith("/capabilities")) {
          return Response.json({
            ...openClawCapabilityManifest,
            transports: ["http", "ndjson", "websocket"]
          });
        }
        return new Response(
          JSON.stringify({
            type: "final",
            response: {
              classification: "user_private",
              text: "",
              attachments: [
                {
                  id: "agent:report-1",
                  kind: "file",
                  mimeType: "text/plain",
                  source: "agent",
                  name: "report.txt"
                }
              ]
            }
          }),
          {
            headers: {
              "content-type": "application/x-ndjson; charset=utf-8"
            }
          }
        );
      }
    });

    await expect(
      collectAgentRun(runner, {
        principal,
        conversation,
        text: "send report",
        connections: { github: connection }
      })
    ).resolves.toEqual({
      classification: "user_private",
      text: "",
      attachments: [
        {
          id: "agent:report-1",
          kind: "file",
          mimeType: "text/plain",
          source: "agent",
          name: "report.txt"
        }
      ]
    });
  });

  test("routes OpenShell virtual-host WebSocket streams through the dial host", async () => {
    const calls: Array<{ url: string; method: string; host: string | null }> = [];
    const sockets: FakeRuntimeWebSocket[] = [];
    const webSocketCalls: Array<{ url: string; host: string | null }> = [];
    const runner = createOpenClawNemoClawAgentRunner({
      config: {
        agentRuntimeOpenShellDialHost: "openshell"
      } as never,
      runtimeFactory: {
        async getOrCreateRuntime() {
          return {
            id: "rt_openshell",
            engine: "openclaw",
            endpointUrl: "http://b-123--runtime.openshell.localhost:8080",
            authToken: "runtime-token",
            status: "ready",
            statePath: "/runtime/state",
            configPath: "/runtime/config/openclaw.json",
            workspacePath: "/runtime/workspace",
            manifest: runtimeManifest()
          };
        },
        async stopRuntime() {},
        async reapIdleRuntimes() {}
      },
      fetch: async (url, init) => {
        calls.push({
          url: String(url),
          method: init?.method ?? "GET",
          host: new Headers(init?.headers).get("host")
        });
        if (String(url) === "http://openshell:8080/capabilities") {
          return Response.json(openClawCapabilityManifest);
        }
        if (String(url) === "http://openshell:8080/runs") {
          return Response.json({
            runId: "run-openshell",
            eventsUrl: "/runs/run-openshell/events"
          });
        }
        throw new Error(`Unexpected request ${url}`);
      },
      webSocketFactory(url, options) {
        webSocketCalls.push({
          url,
          host: new Headers(options?.headers).get("host")
        });
        const socket = new FakeRuntimeWebSocket(url);
        sockets.push(socket);
        return socket;
      }
    });

    const resultPromise = collectAgentRun(runner, {
      principal,
      conversation,
      text: "summarize my GitHub work",
      connections: { github: connection }
    });
    const socket = await waitForSocket(sockets);
    socket.sendEvent({
      type: "final",
      response: {
        classification: "user_private",
        text: "Final from OpenShell WS"
      }
    });
    const result = await resultPromise;

    expect(calls.map((call) => [call.method, call.url, call.host])).toEqual([
      [
        "GET",
        "http://openshell:8080/capabilities",
        "b-123--runtime.openshell.localhost:8080"
      ],
      [
        "POST",
        "http://openshell:8080/runs",
        "b-123--runtime.openshell.localhost:8080"
      ]
    ]);
    expect(webSocketCalls).toEqual([
      {
        url: "ws://openshell:8080/runs/run-openshell/events",
        host: "b-123--runtime.openshell.localhost:8080"
      }
    ]);
    expect(result).toEqual({
      classification: "user_private",
      text: "Final from OpenShell WS"
    });
  });

  test("suppresses WebSocket message deltas when runtime streaming is disabled", async () => {
    const sockets: FakeRuntimeWebSocket[] = [];
    const runner = createOpenClawNemoClawAgentRunner({
      runtimeFactory: {
        async getOrCreateRuntime() {
          return {
            id: "rt_streaming_disabled",
            engine: "openclaw",
            endpointUrl: "http://runtime-streaming-disabled:8080",
            authToken: "runtime-token",
            status: "ready",
            statePath: "/data/runtimes/rt_streaming_disabled/state",
            configPath: "/data/runtimes/rt_streaming_disabled/config/openclaw.json",
            workspacePath: "/data/runtimes/rt_streaming_disabled/workspace",
            manifest: runtimeManifest({
              streaming: {
                messageDeltasEnabled: false
              }
            })
          };
        },
        async stopRuntime() {},
        async reapIdleRuntimes() {}
      },
      fetch: async (url) => {
        if (String(url).endsWith("/capabilities")) {
          return Response.json(openClawCapabilityManifest);
        }
        return Response.json({
          runId: "run-streaming-disabled",
          eventsUrl: "/runs/run-streaming-disabled/events"
        });
      },
      webSocketFactory: (url) => {
        const socket = new FakeRuntimeWebSocket(url);
        sockets.push(socket);
        return socket;
      }
    });
    const events: string[] = [];

    const resultPromise = collectAgentRun(
      runner,
      {
        principal,
        conversation,
        text: "summarize my GitHub work",
        connections: { github: connection }
      },
      (event) => {
        events.push(`${event.type}:${"text" in event ? event.text : ""}`);
      }
    );
    const socket = await waitForSocket(sockets);

    socket.sendEvent({ type: "status", text: "Loading context..." });
    socket.sendEvent({ type: "message_delta", text: "Hidden partial answer" });
    socket.sendEvent({
      type: "final",
      response: {
        classification: "user_private",
        text: "Final answer"
      }
    });

    await expect(resultPromise).resolves.toEqual({
      classification: "user_private",
      text: "Final answer"
    });
    expect(events).toEqual([
      "status:Starting agent runtime...",
      "status:Agent is thinking...",
      "status:Loading context..."
    ]);
  });

  test("emits runtime-scoped observability for streamed tool and message events", async () => {
    const observabilityEvents: ObservabilityEventInput[] = [];
    const runtimeEvents: Array<{ eventType: string; summary?: unknown }> = [];
    const sockets: FakeRuntimeWebSocket[] = [];
    const runner = createOpenClawNemoClawAgentRunner({
      runtimeFactory: {
        async getOrCreateRuntime() {
          return {
            id: "rt_stream",
            engine: "openclaw",
            endpointUrl: "http://runtime-stream:8080",
            authToken: "runtime-token",
            status: "ready",
            statePath: "/data/runtimes/rt_stream/state",
            configPath: "/data/runtimes/rt_stream/config/openclaw.json",
            workspacePath: "/data/runtimes/rt_stream/workspace"
          };
        },
        async stopRuntime() {},
        async reapIdleRuntimes() {},
        recordRuntimeEvent(_runtimeId, event) {
          runtimeEvents.push(event);
        }
      },
      observability: {
        emit: (event) => {
          observabilityEvents.push(event);
        }
      },
      fetch: async (url, init) => {
        if (String(url).endsWith("/capabilities")) {
          return Response.json(openClawCapabilityManifest);
        }
        expect(init.method).toBe("POST");
        return Response.json({
          runId: "run-stream",
          eventsUrl: "/runs/run-stream/events"
        });
      },
      webSocketFactory: (url) => {
        const socket = new FakeRuntimeWebSocket(url);
        sockets.push(socket);
        return socket;
      }
    });

    const resultPromise = collectAgentRun(runner, {
      principal,
      conversation,
      text: "summarize my GitHub work",
      connections: { github: connection }
    });
    const socket = await waitForSocket(sockets);
    socket.sendEvent({ type: "status", text: "Loading context..." });
    socket.sendEvent({
      type: "tool_call",
      toolName: "jira.searchIssues",
      callId: "call-1"
    });
    socket.sendEvent({
      type: "tool_result",
      toolName: "jira.searchIssues",
      callId: "call-1",
      classification: "user_private"
    });
    socket.sendEvent({ type: "message_delta", text: "Partial answer" });
    socket.sendEvent({
      type: "final",
      response: {
        classification: "user_private",
        text: "Final answer"
      }
    });

    await expect(resultPromise).resolves.toEqual({
      classification: "user_private",
      text: "Final answer"
    });
    expect(observabilityEvents.map((event) => event.name)).toEqual([
      "runtime.capabilities.discovered",
      "runtime.run.started",
      "runtime.run.accepted",
      "runtime.status",
      "runtime.tool.call.started",
      "runtime.tool.call.completed",
      "runtime.message.delta",
      "runtime.run.completed"
    ]);
    expect(observabilityEvents[4]).toMatchObject({
      runtimeId: "rt_stream",
      runtimeType: "openclaw",
      toolName: "jira.searchIssues",
      callId: "call-1"
    });
    expect(observabilityEvents[5]).toMatchObject({
      runtimeId: "rt_stream",
      runtimeType: "openclaw",
      toolName: "jira.searchIssues",
      callId: "call-1",
      classification: "user_private",
      status: "ok"
    });
    expect(observabilityEvents[6]).toMatchObject({
      runtimeId: "rt_stream",
      runtimeType: "openclaw",
      attributes: {
        textLength: 14
      }
    });
    expect(runtimeEvents).toEqual([
      {
        eventType: "runtime_run_started",
        summary: expect.objectContaining({
          textLength: 24
        })
      },
      {
        eventType: "runtime_tool_called",
        summary: {
          phase: "started",
          toolName: "jira.searchIssues",
          callId: "call-1"
        }
      },
      {
        eventType: "runtime_tool_called",
        summary: {
          phase: "completed",
          toolName: "jira.searchIssues",
          callId: "call-1",
          classification: "user_private"
        }
      },
      {
        eventType: "runtime_run_finished",
        summary: {
          classification: "user_private",
          textLength: 12
        }
      }
    ]);
  });

  test("emits runtime failure observability when a remote run is rejected", async () => {
    const observabilityEvents: ObservabilityEventInput[] = [];
    const runtimeEvents: Array<{ eventType: string; summary?: unknown }> = [];
    const runner = createOpenClawNemoClawAgentRunner({
      runtimeFactory: {
        async getOrCreateRuntime() {
          return {
            id: "rt_failed",
            engine: "openclaw",
            endpointUrl: "http://runtime-failed:8080",
            authToken: "runtime-token",
            status: "ready",
            statePath: "/data/runtimes/rt_failed/state",
            configPath: "/data/runtimes/rt_failed/config/openclaw.json",
            workspacePath: "/data/runtimes/rt_failed/workspace"
          };
        },
        async stopRuntime() {},
        async reapIdleRuntimes() {},
        recordRuntimeEvent(_runtimeId, event) {
          runtimeEvents.push(event);
        }
      },
      observability: {
        emit: (event) => {
          observabilityEvents.push(event);
        }
      },
      fetch: async (url) => {
        if (String(url).endsWith("/capabilities")) {
          return Response.json(openClawCapabilityManifest);
        }
        return new Response("unavailable", { status: 503 });
      }
    });

    await expect(
      collectAgentRun(runner, {
        principal,
        conversation,
        text: "summarize my GitHub work",
        connections: { github: connection }
      })
    ).rejects.toThrow("Managed runtime returned HTTP 503");

    expect(observabilityEvents.map((event) => event.name)).toEqual([
      "runtime.capabilities.discovered",
      "runtime.run.started",
      "runtime.run.failed"
    ]);
    expect(observabilityEvents[2]).toMatchObject({
      runtimeId: "rt_failed",
      runtimeType: "openclaw",
      status: "error",
      error: {
        name: "Error",
        message: "Managed runtime returned HTTP 503: unavailable"
      }
    });
    expect(runtimeEvents.at(-1)).toEqual({
      eventType: "runtime_run_finished",
      summary: {
        status: "error",
        error: {
          name: "Error",
          message: "Managed runtime returned HTTP 503: unavailable"
        }
      }
    });
  });

  test("emits one runtime failure when a streamed run reports an error", async () => {
    const observabilityEvents: ObservabilityEventInput[] = [];
    const sockets: FakeRuntimeWebSocket[] = [];
    const runner = createOpenClawNemoClawAgentRunner({
      runtimeFactory: {
        async getOrCreateRuntime() {
          return {
            id: "rt_stream_error",
            engine: "openclaw",
            endpointUrl: "http://runtime-stream-error:8080",
            authToken: "runtime-token",
            status: "ready",
            statePath: "/data/runtimes/rt_stream_error/state",
            configPath: "/data/runtimes/rt_stream_error/config/openclaw.json",
            workspacePath: "/data/runtimes/rt_stream_error/workspace"
          };
        },
        async stopRuntime() {},
        async reapIdleRuntimes() {}
      },
      observability: {
        emit: (event) => {
          observabilityEvents.push(event);
        }
      },
      fetch: async (url) => {
        if (String(url).endsWith("/capabilities")) {
          return Response.json(openClawCapabilityManifest);
        }
        return Response.json({
          runId: "run-stream-error",
          eventsUrl: "/runs/run-stream-error/events"
        });
      },
      webSocketFactory: (url) => {
        const socket = new FakeRuntimeWebSocket(url);
        sockets.push(socket);
        return socket;
      }
    });

    const resultPromise = collectAgentRun(runner, {
      principal,
      conversation,
      text: "summarize my GitHub work",
      connections: { github: connection }
    });
    const socket = await waitForSocket(sockets);
    socket.sendEvent({ type: "error", message: "remote runtime exploded" });

    await expect(resultPromise).rejects.toThrow("remote runtime exploded");
    expect(observabilityEvents.map((event) => event.name)).toEqual([
      "runtime.capabilities.discovered",
      "runtime.run.started",
      "runtime.run.accepted",
      "runtime.run.failed"
    ]);
  });

  test("falls back to the run snapshot when the runtime event socket closes before final", async () => {
    const requests: Array<{
      url: string;
      method: string;
      body?: { runId?: string };
    }> = [];
    const sockets: FakeRuntimeWebSocket[] = [];
    const runner = createOpenClawNemoClawAgentRunner({
      baseUrl: "http://openclaw-runtime:8080",
      fetch: async (url, init) => {
        const headers = init.headers as Record<string, string>;
        requests.push({
          url,
          method: init.method ?? "GET",
          ...(init.body
            ? { body: JSON.parse(String(init.body)) as { runId?: string } }
            : {})
        });

        if (init.method === "POST") {
          return Response.json({
            runId: "run-closed",
            eventsUrl: "/runs/run-closed/events"
          });
        }

        return Response.json({
          response: {
            classification: "user_private",
            text: "Final answer from JSON fallback."
          }
        });
      },
      webSocketFactory: (url) => {
        const socket = new FakeRuntimeWebSocket(url);
        sockets.push(socket);
        return socket;
      }
    });
    const events: string[] = [];

    const resultPromise = collectAgentRun(
      runner,
      {
        principal,
        conversation,
        text: "which jira tickets mention onboarding?",
        connections: { github: connection }
      },
      (event) => {
        events.push(`${event.type}:${"text" in event ? event.text : ""}`);
      }
    );
    const socket = await waitForSocket(sockets);
    socket.sendEvent({
      type: "status",
      text: "Agent is thinking..."
    });
    socket.closeFromRuntime();

    const result = await resultPromise;

    expect(events).not.toContain(
      "status:Runtime stream closed; fetching final answer..."
    );
    expect(result).toEqual({
      classification: "user_private",
      text: "Final answer from JSON fallback."
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      url: "http://openclaw-runtime:8080/runs",
      method: "POST"
    });
    expect(requests[1]).toMatchObject({
      url: "http://openclaw-runtime:8080/runs/run-closed",
      method: "GET"
    });
    expect(requests[0].body?.runId).toBeString();
  });

  test("times out the run snapshot fallback when the runtime never finalizes", async () => {
    const observabilityEvents: ObservabilityEventInput[] = [];
    const sockets: FakeRuntimeWebSocket[] = [];
    const runner = createOpenClawNemoClawAgentRunner({
      baseUrl: "http://openclaw-runtime:8080",
      runSnapshotTimeoutMs: 5,
      observability: {
        emit: (event) => observabilityEvents.push(event)
      },
      fetch: async (_url, init) => {
        if (init.method === "POST") {
          return Response.json({
            runId: "run-hung",
            eventsUrl: "/runs/run-hung/events"
          });
        }

        return new Promise<Response>(() => undefined);
      },
      webSocketFactory: (url) => {
        const socket = new FakeRuntimeWebSocket(url);
        sockets.push(socket);
        return socket;
      }
    });

    const resultPromise = collectAgentRun(runner, {
      principal,
      conversation,
      text: "Use my GitHub connection and list my assigned GitHub issues.",
      connections: { github: connection }
    });
    const socket = await waitForSocket(sockets);
    socket.closeFromRuntime();

    await expect(resultPromise).rejects.toThrow(
      "Managed runtime did not produce a final response within 5ms"
    );
    expect(observabilityEvents.at(-1)).toMatchObject({
      name: "runtime.run.failed",
      status: "error",
      error: {
        message: "Managed runtime did not produce a final response within 5ms"
      }
    });
  });

  test("reports remote runtime failures without leaking response bodies", async () => {
    const runner = createOpenClawNemoClawAgentRunner({
      baseUrl: "http://openclaw-runtime:8080",
      fetch: async () =>
        new Response("token secret leaked by remote", {
          status: 500
        })
    });

    await expect(
      collectAgentRun(runner, {
        principal,
        text: "hello",
        connections: { github: null }
      })
    ).rejects.toThrow("Managed runtime returned HTTP 500");
  });

  test("reports safe remote runtime failure details", async () => {
    const runner = createOpenClawNemoClawAgentRunner({
      baseUrl: "http://openclaw-runtime:8080",
      fetch: async () =>
        new Response("Run did not produce a final response", {
          status: 500
        })
    });

    await expect(
      collectAgentRun(runner, {
        principal,
        text: "hello",
        connections: { github: null }
      })
    ).rejects.toThrow(
      "Managed runtime returned HTTP 500: Run did not produce a final response"
    );
  });

  test("rejects malformed remote runtime responses", async () => {
    const runner = createOpenClawNemoClawAgentRunner({
      baseUrl: "http://openclaw-runtime:8080",
      fetch: async () =>
        Response.json({
          response: {
            classification: "everyone_can_see_this",
            text: "bad"
          }
        })
    });

    await expect(
      collectAgentRun(runner, {
        principal,
        text: "hello",
        connections: { github: null }
      })
    ).rejects.toThrow("Managed runtime returned an invalid response");
  });

  test("rejects blank final remote runtime responses", async () => {
    const runner = createOpenClawNemoClawAgentRunner({
      baseUrl: "http://openclaw-runtime:8080",
      fetch: async () =>
        Response.json({
          response: {
            classification: "user_private",
            text: "   "
          }
        })
    });

    await expect(
      collectAgentRun(runner, {
        principal,
        text: "hello",
        connections: { github: null }
      })
    ).rejects.toThrow("Managed runtime did not produce a final response");
  });

  test("rejects provider progress markers as final remote runtime responses", async () => {
    const runner = createOpenClawNemoClawAgentRunner({
      baseUrl: "http://openclaw-runtime:8080",
      fetch: async () =>
        Response.json({
          response: {
            classification: "user_private",
            text: "⚙️ burble_provider_call..."
          }
        })
    });

    await expect(
      collectAgentRun(runner, {
        principal,
        text: "list my last edited google drive file",
        connections: { github: null }
      })
    ).rejects.toThrow("Managed runtime returned an invalid response");
  });
});
