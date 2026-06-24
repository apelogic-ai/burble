import { describe, expect, test } from "bun:test";
import { createManagedRuntimeAgentRunner } from "../../src/agent/runners/managed-runtime";
import { hashRuntimeToken, type RuntimeHandle } from "../../src/agent/runtime-factory";
import type { RuntimeManifest } from "../../src/agent/runtime-manifest";
import { collectAgentRun } from "../../src/agent/types";
import type { Config } from "../../src/config";
import { createTokenStore } from "../../src/db";
import { handleToolGatewayRequest } from "../../src/tool-gateway";
import {
  attachRuntimeEventWebSocket,
  handleRuntimeRequest
} from "../../runtimes/burble-native/src/server";

const principal = {
  workspaceId: "T123",
  slackUserId: "U123"
};

const baseConfig: Config = {
  slackBotToken: "xoxb-test",
  slackAppToken: "xapp-test",
  slackClientId: null,
  slackClientSecret: null,
  slackRedirectUri: "https://example.test/oauth/slack/callback",
  githubClientId: "client-id",
  githubClientSecret: "client-secret",
  jiraClientId: null,
  jiraClientSecret: null,
  googleClientId: null,
  googleClientSecret: null,
  hubspotClientId: null,
  hubspotClientSecret: null,
  baseUrl: "https://example.test",
  port: 3000,
  databasePath: ":memory:",
  slackLogLevel: "info",
  agentMode: "llm",
  agentFastTrack: false,
  agentRuntime: "burble-runtime",
  agentRuntimeFactory: "docker",
  managedRuntimeUrl: null,
  openClawNemoClawUrl: null,
  agentRuntimeEngine: "burble-native",
  openClawNemoClawEngine: "openclaw",
  agentRuntimeDataRoot: "/data/runtimes",
  agentRuntimeDockerNetwork: "compose_default",
  agentRuntimeImage: "burble-native-runtime:dev",
  agentRuntimeIdleTtlMs: 86400000,
  agentRuntimeReaperEnabled: true,
  agentRuntimeReaperIntervalMs: 60000,
  agentRuntimeJwtTtlSeconds: 604800,
  agentRuntimeTokenSecret: "runtime-secret",
  agentRuntimeToolGatewayUrl: "http://burble-app:3000/internal/tools",
  agentRuntimeMcpGatewayUrl: null,
  agentRuntimeMcpAudience: null,
  agentRuntimeSandboxUrl: null,
  agentRuntimeSandboxToken: null,
  agentRuntimeSandboxStartCommand: null,
  atlassianMcpUrl: "https://mcp.atlassian.com/v1/mcp",
  runtimeJwtIssuer: "https://example.test",
  runtimeJwtPrivateKeyPath: null,
  openClawConfigPatchHostPath: null,
  internalApiToken: "internal-secret",
  observabilityJsonlPath: null,
  observabilityJsonlDir: null,
  observabilityIncludeContent: false,
  aiModel: "openai:gpt-5.4"
};

class InProcessRuntimeWebSocket {
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

  send(message: string): void {
    for (const listener of this.listeners.message) {
      listener({ data: message });
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

describe("managed runtime Burble Native integration", () => {
  test("executes a provider tool through the real app tool gateway auth path", async () => {
    const store = createTokenStore(":memory:");
    const runtimeToken = "runtime-token-u123";
    const runtime = store.getOrCreateAgentRuntime({
      ...principal,
      engine: "burble-native",
      endpointUrl: "http://burble-native-runtime:8080",
      authTokenHash: hashRuntimeToken(runtimeToken),
      statePath: "/data/runtimes/rt_native/state",
      configPath: "/data/runtimes/rt_native/config/burble-native.json",
      workspacePath: "/data/runtimes/rt_native/workspace",
      policyHash: "policy-native"
    });
    store.upsertProviderConnection({
      provider: "github",
      email: "person@example.com",
      slackUserId: principal.slackUserId,
      providerLogin: "octocat",
      accessToken: "github-token"
    });

    const runtimeHandle: RuntimeHandle = {
      id: runtime.id,
      engine: "burble-native",
      endpointUrl: runtime.endpointUrl,
      authToken: runtimeToken,
      status: "ready",
      statePath: runtime.statePath,
      configPath: runtime.configPath,
      workspacePath: runtime.workspacePath,
      manifest: runtimeManifest(runtime.id)
    };
    const calls: string[] = [];
    const runtimeRunHeaders: HeadersInit[] = [];
    const webSocketOptions: Array<{ headers?: HeadersInit } | undefined> = [];

    const fetchRouter = async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      const parsed = new URL(url);

      if (parsed.hostname === "burble-native-runtime") {
        if (parsed.pathname === "/runs") {
          runtimeRunHeaders.push(init?.headers ?? {});
        }
        return handleRuntimeRequest(
          new Request(url, init),
          {
            env: {
              AI_MODEL: "openai:gpt-5.4",
              OPENAI_API_KEY: "test-openai-key",
              OPENAI_BASE_URL: "https://openai-compatible.example/v1",
              BURBLE_TOOL_GATEWAY_URL: "http://burble-app:3000/internal/tools",
              BURBLE_INTERNAL_TOKEN: runtimeToken
            },
            fetch: fetchRouter
          }
        );
      }

      if (parsed.hostname === "openai-compatible.example") {
        const providerRequestCount = calls.filter((call) =>
          call.endsWith("https://openai-compatible.example/v1/responses")
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
                      input: {}
                    })
                  }
                ],
                usage: {
                  input_tokens: 100,
                  output_tokens: 4,
                  total_tokens: 104
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

      if (
        (parsed.hostname === "burble-app" ||
          (parsed.hostname === "127.0.0.1" && parsed.port === "3000")) &&
        parsed.pathname.startsWith("/internal/tools/")
      ) {
        const toolName = decodeURIComponent(
          parsed.pathname
            .replace(/^\/internal\/tools\//, "")
            .replace(/\/execute$/, "")
        );
        return handleToolGatewayRequest(
          baseConfig,
          store,
          toolName,
          new Request(url, init),
          {
            getGitHubUser: async (token) => {
              expect(token).toBe("github-token");
              return { login: "octocat" };
            }
          }
        );
      }

      throw new Error(`Unexpected request ${url}`);
    };

    const runner = createManagedRuntimeAgentRunner({
      runtimeFactory: {
        async getOrCreateRuntime() {
          return runtimeHandle;
        },
        async stopRuntime() {},
        async reapIdleRuntimes() {}
      },
      fetch: fetchRouter,
      webSocketFactory(url, options) {
        webSocketOptions.push(options);
        const socket = new InProcessRuntimeWebSocket(url);
        const runId = decodeURIComponent(
          new URL(url).pathname.match(/^\/runs\/([^/]+)\/events$/)?.[1] ?? ""
        );
        attachRuntimeEventWebSocket(runId, {
          send: (message) => socket.send(message),
          close: () => socket.closeFromRuntime()
        });
        return socket;
      }
    });

    const result = await collectAgentRun(runner, {
      principal,
      conversation: {
        source: "slack",
        workspaceId: principal.workspaceId,
        channelId: "D123",
        rootId: "dm:D123",
        isDirectMessage: true
      },
      text: "who am I on GitHub?",
      toolGroups: {
        groups: ["conversation", "github"],
        reasons: ["default:conversation", "keyword:github:github"]
      },
      connections: {
        github: {
          provider: "github",
          email: "person@example.com",
          slackUserId: principal.slackUserId,
          providerLogin: "octocat",
          accessToken: "redacted",
          connectedAt: "2026-06-08T00:00:00.000Z"
        }
      }
    });

    expect(result.text).toBe("Authenticated as octocat.");
    expect(runtimeRunHeaders).toEqual([
      {
        accept: "application/x-ndjson",
        authorization: `Bearer ${runtimeHandle.authToken}`,
        "content-type": "application/json",
        "x-burble-runtime-id": runtimeHandle.id,
        "x-burble-runtime-token": runtimeHandle.authToken
      }
    ]);
    expect(webSocketOptions).toEqual([]);
    expect(calls).toContain(
      "POST http://burble-app:3000/internal/tools/github.getAuthenticatedUser/execute"
    );
  });

  test("executes Hermes provider tool stream callbacks through the app gateway", async () => {
    const store = createTokenStore(":memory:");
    const runtimeToken = "runtime-token-u123";
    const runtime = store.getOrCreateAgentRuntime({
      ...principal,
      engine: "hermes",
      endpointUrl: "http://hermes-runtime:8080",
      authTokenHash: hashRuntimeToken(runtimeToken),
      statePath: "/data/runtimes/rt_hermes/state",
      configPath: "/data/runtimes/rt_hermes/config/hermes.json",
      workspacePath: "/data/runtimes/rt_hermes/workspace",
      policyHash: "policy-hermes"
    });
    store.upsertProviderConnection({
      provider: "google",
      email: "person@example.com",
      slackUserId: principal.slackUserId,
      providerLogin: "person@example.com",
      accessToken: "google-token"
    });

    const runtimeHandle: RuntimeHandle = {
      id: runtime.id,
      engine: "hermes",
      endpointUrl: runtime.endpointUrl,
      authToken: runtimeToken,
      status: "ready",
      statePath: runtime.statePath,
      configPath: runtime.configPath,
      workspacePath: runtime.workspacePath,
      manifest: runtimeManifest(runtime.id, "hermes")
    };
    const calls: string[] = [];
    const events: string[] = [];

    const fetchRouter = async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      const parsed = new URL(url);

      if (parsed.hostname === "hermes-runtime") {
        if (parsed.pathname === "/capabilities") {
          return new Response("not implemented", { status: 404 });
        }
        if (parsed.pathname === "/runs") {
          return new Response(
            [
              JSON.stringify({ type: "status", text: "Agent is thinking..." }),
              JSON.stringify({
                type: "tool_call",
                toolName: "google_search_drive_files",
                callId: "hermes-provider-marker-test",
                input: { limit: 1 }
              }),
              JSON.stringify({ type: "status", text: "Agent has thought for 8s..." })
            ].join("\n"),
            { headers: { "content-type": "application/x-ndjson" } }
          );
        }
      }

      if (
        (parsed.hostname === "burble-app" ||
          (parsed.hostname === "127.0.0.1" && parsed.port === "3000")) &&
        parsed.pathname.startsWith("/internal/tools/")
      ) {
        const toolName = decodeURIComponent(
          parsed.pathname
            .replace(/^\/internal\/tools\//, "")
            .replace(/\/execute$/, "")
        );
        return handleToolGatewayRequest(
          baseConfig,
          store,
          toolName,
          new Request(url, init),
          {
            searchGoogleDriveFiles: async (token, input) => {
              expect(token).toBe("google-token");
              expect(input).toEqual({ limit: 1 });
              return [
                {
                  id: "drive-file-1",
                  name: "apelogic-ai-open-prs-last-24h-seen.txt",
                  webViewLink: "https://drive.google.com/file/d/drive-file-1/view",
                  modifiedTime: "2026-06-21T19:02:13.000Z"
                }
              ];
            }
          }
        );
      }

      throw new Error(`Unexpected request ${url}`);
    };

    const runner = createManagedRuntimeAgentRunner({
      config: baseConfig,
      runtimeFactory: {
        async getOrCreateRuntime() {
          return runtimeHandle;
        },
        async stopRuntime() {},
        async reapIdleRuntimes() {}
      },
      fetch: fetchRouter,
      logInfo(message) {
        events.push(message);
      }
    });

    const result = await collectAgentRun(
      runner,
      {
        principal,
        conversation: {
          source: "slack",
          workspaceId: principal.workspaceId,
          channelId: "D123",
          rootId: "dm:D123",
          isDirectMessage: true
        },
        text: "list my last edited google drive file",
        toolGroups: {
          groups: ["conversation", "google"],
          reasons: ["default:conversation", "keyword:google:drive"]
        },
        connections: {
          github: null,
          google: {
            provider: "google",
            email: "person@example.com",
            slackUserId: principal.slackUserId,
            providerLogin: "person@example.com",
            accessToken: "redacted",
            connectedAt: "2026-06-08T00:00:00.000Z"
          }
        }
      },
      (event) => {
        events.push(event.type);
      }
    );

    expect(result.text).toBe(
      [
        "Last edited Google Drive file: <https://drive.google.com/file/d/drive-file-1/view|apelogic-ai-open-prs-last-24h-seen.txt>",
        "modified: 2026-06-21 19:02:13 UTC"
      ].join("\n")
    );
    expect(events).toContain("tool_call");
    expect(events).toContain("tool_result");
    expect(
      calls.filter(
        (call) =>
          call ===
          "POST http://127.0.0.1:3000/internal/tools/google.searchDriveFiles/execute"
      )
    ).toHaveLength(1);
  });

  test("does not auto-execute Hermes provider write tool stream callbacks", async () => {
    const store = createTokenStore(":memory:");
    const runtimeToken = "runtime-token-u123";
    const runtime = store.getOrCreateAgentRuntime({
      ...principal,
      engine: "hermes",
      endpointUrl: "http://hermes-runtime:8080",
      authTokenHash: hashRuntimeToken(runtimeToken),
      statePath: "/data/runtimes/rt_hermes/state",
      configPath: "/data/runtimes/rt_hermes/config/hermes.json",
      workspacePath: "/data/runtimes/rt_hermes/workspace",
      policyHash: "policy-hermes"
    });
    store.upsertProviderConnection({
      provider: "github",
      email: "person@example.com",
      slackUserId: principal.slackUserId,
      providerLogin: "person@example.com",
      accessToken: "github-token"
    });

    const runtimeHandle: RuntimeHandle = {
      id: runtime.id,
      engine: "hermes",
      endpointUrl: runtime.endpointUrl,
      authToken: runtimeToken,
      status: "ready",
      statePath: runtime.statePath,
      configPath: runtime.configPath,
      workspacePath: runtime.workspacePath,
      manifest: runtimeManifest(runtime.id, "hermes")
    };
    const calls: string[] = [];
    const events: string[] = [];

    const fetchRouter = async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      const parsed = new URL(url);

      if (parsed.hostname === "hermes-runtime") {
        if (parsed.pathname === "/capabilities") {
          return new Response("not implemented", { status: 404 });
        }
        if (parsed.pathname === "/runs") {
          return new Response(
            [
              JSON.stringify({ type: "status", text: "Agent is thinking..." }),
              JSON.stringify({
                type: "tool_call",
                toolName: "github_create_issue",
                callId: "hermes-write-tool-test",
                input: { repo: "owner/repo", title: "Do not create this" }
              }),
              JSON.stringify({
                type: "message_delta",
                text: "I cannot create that issue without confirmation."
              })
            ].join("\n"),
            { headers: { "content-type": "application/x-ndjson" } }
          );
        }
      }

      if (
        (parsed.hostname === "burble-app" ||
          (parsed.hostname === "127.0.0.1" && parsed.port === "3000")) &&
        parsed.pathname.startsWith("/internal/tools/")
      ) {
        throw new Error(`Unexpected provider gateway write call ${url}`);
      }

      throw new Error(`Unexpected request ${url}`);
    };

    const runner = createManagedRuntimeAgentRunner({
      config: baseConfig,
      runtimeFactory: {
        async getOrCreateRuntime() {
          return runtimeHandle;
        },
        async stopRuntime() {},
        async reapIdleRuntimes() {}
      },
      fetch: fetchRouter,
      logInfo(message) {
        events.push(message);
      }
    });

    const result = await collectAgentRun(
      runner,
      {
        principal,
        conversation: {
          source: "slack",
          workspaceId: principal.workspaceId,
          channelId: "D123",
          rootId: "dm:D123",
          isDirectMessage: true
        },
        text: "create a GitHub issue",
        toolGroups: {
          groups: ["conversation", "github"],
          reasons: ["default:conversation", "keyword:github"]
        },
        connections: {
          github: {
            provider: "github",
            email: "person@example.com",
            slackUserId: principal.slackUserId,
            providerLogin: "person@example.com",
            accessToken: "redacted",
            connectedAt: "2026-06-08T00:00:00.000Z"
          }
        }
      },
      (event) => {
        events.push(event.type);
      }
    );

    expect(result.text).toBe("I cannot create that issue without confirmation.");
    expect(events).toContain("tool_call");
    expect(events).not.toContain("tool_result");
    expect(
      calls.filter((call) => call.includes("/internal/tools/github.createIssue/execute"))
    ).toHaveLength(0);
  });

  test("seals Slack attachment ids before sending input to a runtime", async () => {
    const runtimeToken = "runtime-token-u123";
    const runtimeHandle: RuntimeHandle = {
      id: "rt_native",
      engine: "burble-native",
      endpointUrl: "http://burble-native-runtime:8080",
      authToken: runtimeToken,
      status: "ready",
      statePath: "/data/runtimes/rt_native/state",
      configPath: "/data/runtimes/rt_native/config/burble-native.json",
      workspacePath: "/data/runtimes/rt_native/workspace",
      manifest: runtimeManifest("rt_native")
    };
    let postedBody: unknown;
    let runtimeRequirements: unknown;

    const runner = createManagedRuntimeAgentRunner({
      config: baseConfig,
      runtimeFactory: {
        async getOrCreateRuntime(_principal, requirements) {
          runtimeRequirements = requirements;
          return runtimeHandle;
        },
        async stopRuntime() {},
        async reapIdleRuntimes() {}
      },
      fetch: async (url, init) => {
        const parsed = new URL(url);
        if (
          parsed.hostname === "burble-native-runtime" &&
          parsed.pathname === "/runs"
        ) {
          postedBody = JSON.parse(String(init.body));
          return Response.json({
            response: {
              classification: "public",
              text: "ok"
            }
          });
        }

        return new Response("not found", { status: 404 });
      }
    });

    const result = await collectAgentRun(runner, {
      principal,
      conversation: {
        source: "slack",
        workspaceId: principal.workspaceId,
        channelId: "D123",
        rootId: "dm:D123",
        isDirectMessage: true
      },
      text: "summarize the file",
      toolGroups: {
        groups: ["attachments", "conversation"],
        reasons: ["metadata:attachments", "default:conversation"]
      },
      attachments: [
        {
          id: "slack:F123",
          externalId: "F123",
          source: "slack",
          kind: "file",
          mimeType: "text/markdown",
          name: "scope.md",
          sizeBytes: 12
        }
      ],
      connections: {
        github: null
      }
    });

    expect(result.text).toBe("ok");
    expect(runtimeRequirements).toEqual({ attachments: true });
    expect(postedBody).toMatchObject({
      input: {
        attachments: [
          {
            source: "slack",
            kind: "file",
            mimeType: "text/markdown",
            name: "scope.md",
            sizeBytes: 12
          }
        ]
      }
    });
    const attachment = (postedBody as {
      input?: { attachments?: Array<Record<string, unknown>> };
    }).input?.attachments?.[0];
    expect(attachment?.id).toStartWith("attcap_");
    expect(attachment).not.toHaveProperty("externalId");
    expect(JSON.stringify(postedBody)).not.toContain("F123");
  });
});

function runtimeManifest(
  runtimeId: string,
  engine: RuntimeManifest["runtime"]["engine"] = "burble-native"
): RuntimeManifest {
  return {
    version: "1",
    principal,
    runtime: {
      engine,
      factory: "docker",
      ttlMs: 86400000,
      reaperEnabled: true
    },
    model: {
      provider: "openai",
      model: "gpt-5.4"
    },
    tools: [
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
      }
    ],
    skills: [],
    memory: {
      userMemoryEnabled: false,
      workspaceMemoryEnabled: false,
      jobMemoryEnabled: false
    },
    streaming: {
      messageDeltasEnabled: true
    },
    memoryContext: [],
    disabledTools: [],
    policyHash: `policy-${runtimeId}`
  };
}

function sseEvent(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}
