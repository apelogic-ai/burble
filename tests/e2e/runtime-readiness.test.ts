import { describe, expect, test } from "bun:test";
import { defaultAgentRuntimeImage } from "../../src/config";
import type { AgentRuntimeEngine } from "../../src/db";
import { createTokenStore } from "../../src/db";
import {
  createDockerRuntimeFactory,
  type RuntimeCommandExecutor,
  type RuntimeFetch
} from "../../src/agent/container-runtime-factory";
import {
  parseRuntimeRunEvent,
  type RuntimeRunEvent
} from "@burble/runtime-sdk/runtime-contract";
import { runRuntimeConformanceCheck } from "../../src/agent/runtime-conformance-harness";
import { createRuntimeContractHttpClient } from "@burble/runtime-sdk/runtime-contract-http-client";
import { runRuntimeReadinessCheck } from "../../src/agent/runtime-readiness-harness";
import type { RuntimeContractCheckName } from "@burble/runtime-sdk/runtime-contract-harness";

const runtimeReadinessDescribe =
  Bun.env.BURBLE_E2E_RUNTIMES === "1" ? describe : describe.skip;
const runtimeConformanceDescribe =
  Bun.env.BURBLE_E2E_CONFORMANCE === "1" ? describe : describe.skip;
const runtimeBootSmokeDescribe =
  Bun.env.BURBLE_E2E_RUNTIME_BOOT_SMOKE === "1" ? describe : describe.skip;
const burbleNativeBoundaryDescribe =
  Bun.env.BURBLE_E2E_BURBLE_NATIVE_BOUNDARY_SMOKE === "1"
    ? describe
    : describe.skip;

runtimeReadinessDescribe("runtime readiness e2e", () => {
  for (const engine of e2eRuntimeEngines()) {
    test(
      `${engine} reaches ready through the managed runtime factory`,
      async () => {
        const store = createTokenStore(":memory:");
        const principal = {
          workspaceId: Bun.env.BURBLE_E2E_WORKSPACE_ID ?? "T_E2E",
          slackUserId: `U_E2E_${engine.replace(/[^a-z0-9]/gi, "_")}_${Date.now()}`
        };
        const dockerNetwork = requiredE2eEnv("BURBLE_E2E_DOCKER_NETWORK");
        const runtimeFetch = createDockerRuntimeNetworkFetch(dockerNetwork);
        const factory = createDockerRuntimeFactory({
          store,
          engine,
          image: runtimeImageForEngine(engine),
          dataRoot: Bun.env.BURBLE_E2E_RUNTIME_DATA_ROOT ?? "/tmp/burble-runtimes",
          dockerNetwork,
          toolGatewayUrl:
            Bun.env.BURBLE_E2E_TOOL_GATEWAY_URL ??
            "http://burble-app:3000/internal/tools",
          mcpGatewayUrl: Bun.env.BURBLE_E2E_MCP_GATEWAY_URL,
          runtimeTokenSecret:
            Bun.env.BURBLE_E2E_RUNTIME_TOKEN_SECRET ?? "runtime-e2e-secret",
          openClawConfigPatchPath: Bun.env.BURBLE_E2E_OPENCLAW_CONFIG_PATCH_PATH,
          env: Bun.env,
          execute: executeDockerWithPublishedRuntimePort,
          fetch: runtimeFetch,
          healthCheckAttempts: Number.parseInt(
            Bun.env.BURBLE_E2E_HEALTH_ATTEMPTS ?? "120",
            10
          ),
          healthCheckIntervalMs: Number.parseInt(
            Bun.env.BURBLE_E2E_HEALTH_INTERVAL_MS ?? "1000",
            10
          )
        });
        let runtimeId: string | null = null;

        try {
          const report = await runRuntimeReadinessCheck({
            engine,
            principal,
            runtimeFactory: factory,
            store,
            fetch: runtimeFetch
          });
          runtimeId = report.runtimeId;
          if (engine === "openclaw") {
            await assertContainerLogsContain(
              new URL(report.endpointUrl).hostname,
              "OpenClaw gateway ready"
            );
          }
          expect(report.signals.map((signal) => signal.name)).toEqual([
            "runtime.created",
            "runtime.container_started",
            "runtime.healthz_ok",
            "runtime.capabilities_ok",
            "runtime.ready_recorded"
          ]);
        } finally {
          if (runtimeId) {
            await factory.stopRuntime(runtimeId);
          }
          store.close();
        }
      },
      { timeout: Number.parseInt(Bun.env.BURBLE_E2E_TIMEOUT_MS ?? "180000", 10) }
    );
  }
});

runtimeConformanceDescribe("runtime contract conformance e2e", () => {
  for (const engine of e2eRuntimeEngines()) {
    test(
      `${engine} passes the runtime contract smoke test through its image`,
      async () => {
        const store = createTokenStore(":memory:");
        const principal = {
          workspaceId: Bun.env.BURBLE_E2E_WORKSPACE_ID ?? "T_E2E",
          slackUserId: `U_E2E_CONFORMANCE_${engine.replace(/[^a-z0-9]/gi, "_")}_${Date.now()}`
        };
        const dockerNetwork = requiredE2eEnv("BURBLE_E2E_DOCKER_NETWORK");
        const runtimeFetch = createDockerRuntimeNetworkFetch(dockerNetwork);
        const factory = createDockerRuntimeFactory({
          store,
          engine,
          image: runtimeImageForEngine(engine),
          dataRoot: Bun.env.BURBLE_E2E_RUNTIME_DATA_ROOT ?? "/tmp/burble-runtimes",
          dockerNetwork,
          toolGatewayUrl:
            Bun.env.BURBLE_E2E_TOOL_GATEWAY_URL ??
            "http://burble-app:3000/internal/tools",
          mcpGatewayUrl: Bun.env.BURBLE_E2E_MCP_GATEWAY_URL,
          runtimeTokenSecret:
            Bun.env.BURBLE_E2E_RUNTIME_TOKEN_SECRET ?? "runtime-e2e-secret",
          openClawConfigPatchPath: Bun.env.BURBLE_E2E_OPENCLAW_CONFIG_PATCH_PATH,
          env: {
            ...Bun.env,
            BURBLE_RUNTIME_CONTRACT_PROBE: "1"
          },
          execute: executeDockerWithPublishedRuntimePort,
          fetch: runtimeFetch,
          healthCheckAttempts: Number.parseInt(
            Bun.env.BURBLE_E2E_HEALTH_ATTEMPTS ?? "120",
            10
          ),
          healthCheckIntervalMs: Number.parseInt(
            Bun.env.BURBLE_E2E_HEALTH_INTERVAL_MS ?? "1000",
            10
          )
        });
        let runtimeId: string | null = null;

        try {
          const report = await runRuntimeConformanceCheck({
            engine,
            principal,
            runtimeFactory: factory,
            resolveBaseUrl: async (runtime) => {
              runtimeId = runtime.id;
              return inspectPublishedRuntimeAddress(
                new URL(runtime.endpointUrl).hostname,
                dockerNetwork
              );
            }
          });

          expect(report.runtimeType).toBe(engine);
          const expectedChecks: RuntimeContractCheckName[] = [
            "manifest",
            "health",
            "run_accepted",
            "events_stream",
            "final_response",
            "usage"
          ];
          if (report.manifest.toolCalls) {
            expectedChecks.push("tool_calls");
            expectedChecks.push("tool_reachability");
          }
          if (report.manifest.scheduledProviderCalls) {
            expectedChecks.push("scheduled_provider_calls");
          }
          if (report.manifest.attachments) {
            expectedChecks.push("attachments");
          }
          expect(report.checks.map((check) => check.name)).toEqual(
            expectedChecks
          );
        } finally {
          if (runtimeId) {
            await factory.stopRuntime(runtimeId);
          }
          store.close();
        }
      },
      { timeout: Number.parseInt(Bun.env.BURBLE_E2E_TIMEOUT_MS ?? "180000", 10) }
    );
  }
});

burbleNativeBoundaryDescribe("Burble Native image boundary e2e", () => {
  test(
    "runs model to tool gateway to final through the built image",
    async () => {
      const boundary = startBurbleNativeBoundaryServer();
      const store = createTokenStore(":memory:");
      const principal = {
        workspaceId: "T_E2E",
        slackUserId: `U_E2E_NATIVE_BOUNDARY_${Date.now()}`
      };
      const dockerNetwork = requiredE2eEnv("BURBLE_E2E_DOCKER_NETWORK");
      const runtimeFetch = createDockerRuntimeNetworkFetch(dockerNetwork);
      const hostBaseUrl = `http://host.docker.internal:${boundary.port}`;
      const factory = createDockerRuntimeFactory({
        store,
        engine: "burble-native",
        image: runtimeImageForEngine("burble-native"),
        dataRoot: Bun.env.BURBLE_E2E_RUNTIME_DATA_ROOT ?? "/tmp/burble-runtimes",
        dockerNetwork,
        toolGatewayUrl: `${hostBaseUrl}/internal/tools`,
        inferenceBaseUrl: `${hostBaseUrl}/v1`,
        runtimeTokenSecret:
          Bun.env.BURBLE_E2E_RUNTIME_TOKEN_SECRET ?? "runtime-e2e-secret",
        env: { AI_MODEL: "openai:gpt-5.4" },
        execute: executeDockerWithPublishedRuntimePort,
        fetch: runtimeFetch,
        healthCheckAttempts: Number.parseInt(
          Bun.env.BURBLE_E2E_HEALTH_ATTEMPTS ?? "60",
          10
        ),
        healthCheckIntervalMs: Number.parseInt(
          Bun.env.BURBLE_E2E_HEALTH_INTERVAL_MS ?? "1000",
          10
        )
      });
      let runtimeId: string | null = null;

      try {
        const runtime = await factory.getOrCreateRuntime(principal);
        runtimeId = runtime.id;
        const response = await runtimeFetch(`${runtime.endpointUrl}/runs`, {
          method: "POST",
          headers: {
            accept: "application/x-ndjson",
            authorization: `Bearer ${runtime.authToken}`,
            "content-type": "application/json",
            "x-burble-runtime-id": runtime.id
          },
          body: JSON.stringify({
            runId: `native-boundary-${crypto.randomUUID()}`,
            principal,
            runtime: {
              id: runtime.id,
              engine: "burble-native",
              manifest: burbleNativeBoundaryRequestManifest()
            },
            input: {
              text: "Who am I on GitHub?",
              conversation: {
                source: "slack",
                workspaceId: principal.workspaceId,
                channelId: "D_NATIVE_BOUNDARY",
                rootId: "dm:D_NATIVE_BOUNDARY",
                isDirectMessage: true
              },
              toolGroups: {
                groups: ["github"],
                reasons: ["boundary smoke"]
              },
              connections: {
                github: { connected: true, login: "octocat" }
              }
            }
          })
        });
        expect(response.status).toBe(200);
        const events = (await response.text())
          .trim()
          .split("\n")
          .map((line) => parseRuntimeRunEvent(JSON.parse(line)));

        expect(events.map((event) => event.type)).toEqual([
          "status",
          "tool_call",
          "tool_result",
          "message_delta",
          "final"
        ]);
        expect(readFinalEvent(events)?.response).toMatchObject({
          classification: "user_private",
          text: "Authenticated as octocat."
        });
        expect(boundary.providerRequests).toHaveLength(2);
        expect(boundary.toolRequests).toHaveLength(1);
        const continuation = boundary.providerRequests[1].body as {
          input?: unknown[];
        };
        expect(continuation.input).toContainEqual({
          type: "function_call_output",
          call_id: "call_native_boundary",
          output: JSON.stringify({
            classification: "user_private",
            content: { login: "octocat" }
          })
        });
        expect(boundary.providerRequests[0].headers.get("authorization")).toBe(
          "Bearer sk-BURBLE-INFERENCE-PROXY"
        );
        expect(boundary.toolRequests[0].headers.get("authorization")).toBe(
          `Bearer ${runtime.authToken}`
        );
        expect(
          boundary.toolRequests[0].headers.get("x-burble-runtime-id")
        ).toBe(runtime.id);
      } finally {
        if (runtimeId) {
          await factory.stopRuntime(runtimeId);
        }
        store.close();
        await boundary.stop();
      }
    },
    { timeout: Number.parseInt(Bun.env.BURBLE_E2E_TIMEOUT_MS ?? "120000", 10) }
  );
});

runtimeBootSmokeDescribe("runtime boot smoke e2e", () => {
  for (const engine of e2eRuntimeEngines()) {
    test(
      `${engine} boots and serves contract endpoints`,
      async () => {
        const store = createTokenStore(":memory:");
        const principal = {
          workspaceId: Bun.env.BURBLE_E2E_WORKSPACE_ID ?? "T_E2E",
          slackUserId: `U_BOOT_${engine.replace(/[^a-z0-9]/gi, "_")}_${Date.now()}`
        };
        const dockerNetwork = requiredE2eEnv("BURBLE_E2E_DOCKER_NETWORK");
        const runtimeFetch = createDockerRuntimeNetworkFetch(dockerNetwork);
        const factory = createDockerRuntimeFactory({
          store,
          engine,
          image: runtimeImageForEngine(engine),
          dataRoot: Bun.env.BURBLE_E2E_RUNTIME_DATA_ROOT ?? "/tmp/burble-runtimes",
          dockerNetwork,
          toolGatewayUrl:
            Bun.env.BURBLE_E2E_TOOL_GATEWAY_URL ??
            "http://burble-app:3000/internal/tools",
          mcpGatewayUrl: Bun.env.BURBLE_E2E_MCP_GATEWAY_URL,
          runtimeTokenSecret:
            Bun.env.BURBLE_E2E_RUNTIME_TOKEN_SECRET ?? "runtime-e2e-secret",
          openClawConfigPatchPath: Bun.env.BURBLE_E2E_OPENCLAW_CONFIG_PATCH_PATH,
          env: Bun.env,
          execute: executeDockerWithPublishedRuntimePort,
          fetch: runtimeFetch,
          healthCheckAttempts: Number.parseInt(
            Bun.env.BURBLE_E2E_HEALTH_ATTEMPTS ?? "120",
            10
          ),
          healthCheckIntervalMs: Number.parseInt(
            Bun.env.BURBLE_E2E_HEALTH_INTERVAL_MS ?? "1000",
            10
          )
        });
        let runtimeId: string | null = null;

        try {
          const runtime = await factory.getOrCreateRuntime(principal);
          runtimeId = runtime.id;
          const client = createRuntimeContractHttpClient({
            baseUrl: runtime.endpointUrl,
            fetch: runtimeFetch,
            headers: {
              authorization: `Bearer ${runtime.authToken}`,
              "x-burble-runtime-id": runtime.id
            }
          });
          await expect(client.health()).resolves.toEqual({ ok: true });
          await expect(client.getCapabilityManifest()).resolves.toMatchObject({
            runtimeType: engine
          });
          expect(store.getAgentRuntime(runtime.id)?.status).toBe("ready");
          if (engine === "burble-native") {
            await assertBurbleNativeRunContract({
              runtimeId: runtime.id,
              endpointUrl: runtime.endpointUrl,
              authToken: runtime.authToken,
              principal,
              fetch: runtimeFetch
            });
          }
        } finally {
          if (runtimeId) {
            await factory.stopRuntime(runtimeId);
          }
          store.close();
        }
      },
      { timeout: Number.parseInt(Bun.env.BURBLE_E2E_TIMEOUT_MS ?? "180000", 10) }
    );
  }
});

async function assertBurbleNativeRunContract(input: {
  runtimeId: string;
  endpointUrl: string;
  authToken: string;
  principal: { workspaceId: string; slackUserId: string };
  fetch: RuntimeFetch;
}): Promise<void> {
  const response = await input.fetch(`${input.endpointUrl}/runs`, {
    method: "POST",
    headers: {
      accept: "application/x-ndjson",
      authorization: `Bearer ${input.authToken}`,
      "content-type": "application/json",
      "x-burble-runtime-id": input.runtimeId
    },
    body: JSON.stringify({
      runId: `boot-smoke-${crypto.randomUUID()}`,
      principal: input.principal,
      runtime: {
        id: input.runtimeId,
        engine: "burble-native"
      },
      input: {
        text: "hello native runtime",
        conversation: {
          source: "slack",
          workspaceId: input.principal.workspaceId,
          channelId: "D_BOOT_SMOKE",
          rootId: "dm:D_BOOT_SMOKE",
          isDirectMessage: true
        },
        connections: {}
      }
    })
  });
  expect(response.status).toBe(200);

  const events = (await response.text())
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => parseRuntimeRunEvent(JSON.parse(line)));
  expect(events.some((event) => event.type === "message_delta")).toBe(true);
  expect(readFinalEvent(events)?.response).toEqual({
    classification: "user_private",
    text: "Runtime contract probe response.",
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      usageSource: "burble-native"
    }
  });
}

function readFinalEvent(
  events: RuntimeRunEvent[]
): Extract<RuntimeRunEvent, { type: "final" }> | null {
  return (
    events.find(
      (event): event is Extract<RuntimeRunEvent, { type: "final" }> =>
        event.type === "final"
    ) ?? null
  );
}

function e2eRuntimeEngines(): AgentRuntimeEngine[] {
  const raw = Bun.env.BURBLE_E2E_RUNTIME_ENGINES ?? "openclaw,hermes";
  return raw.split(",").map((engine) => normalizeRuntimeEngine(engine.trim()));
}

function normalizeRuntimeEngine(value: string): AgentRuntimeEngine {
  switch (value) {
    case "openclaw":
    case "openclaw-gateway":
    case "burble-native":
    case "hermes":
      return value;
    default:
      throw new Error(`Unsupported E2E runtime engine: ${value}`);
  }
}

function runtimeImageForEngine(engine: AgentRuntimeEngine): string {
  const envName = `BURBLE_E2E_${engine
    .replace(/[^a-z0-9]/gi, "_")
    .toUpperCase()}_IMAGE`;
  return Bun.env[envName] ?? defaultAgentRuntimeImage(engine);
}

function requiredE2eEnv(name: string): string {
  const value = Bun.env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is required when BURBLE_E2E_RUNTIMES=1 so runtime container hostnames are resolvable from the test process.`
    );
  }
  return value;
}

function createDockerRuntimeNetworkFetch(network: string): RuntimeFetch {
  const containerAddressCache = new Map<string, string>();
  return async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname.startsWith("burble-rt-")) {
      const address =
        containerAddressCache.get(url.hostname) ??
        (await inspectPublishedRuntimeAddress(url.hostname, network));
      containerAddressCache.set(url.hostname, address);
      const mapped = new URL(address);
      url.hostname = mapped.hostname;
      url.port = mapped.port;
      url.protocol = mapped.protocol;
    }
    return fetch(url.toString(), init);
  };
}

async function inspectPublishedRuntimeAddress(
  containerName: string,
  network: string
): Promise<string> {
  await assertContainerAttachedToNetwork(containerName, network);
  const { code, stdout, stderr } = await runCommand("docker", [
    "port",
    containerName,
    "8080/tcp"
  ]);
  if (code !== 0) {
    throw new Error(
      `docker port failed for ${containerName}: ${stderr.trim() || stdout.trim()}`
    );
  }
  const address = stdout.trim().split(/\r?\n/).at(-1)?.trim();
  if (!address || !address.includes(":")) {
    throw new Error(
      `docker port did not return a host address for ${containerName}`
    );
  }
  const port = address.slice(address.lastIndexOf(":") + 1);
  return `http://127.0.0.1:${port}`;
}

const executeDockerWithPublishedRuntimePort: RuntimeCommandExecutor = (
  command,
  args
) => {
  if (command !== "docker" || args[0] !== "run") {
    return runCommand(command, args);
  }
  const imageIndex = args.length - 1;
  return runCommand(command, [
    ...args.slice(0, imageIndex),
    "--add-host",
    "host.docker.internal:host-gateway",
    "--publish",
    "127.0.0.1::8080",
    args[imageIndex] ?? ""
  ]);
};

function startBurbleNativeBoundaryServer(): {
  port: number;
  providerRequests: BoundaryRequest[];
  toolRequests: BoundaryRequest[];
  stop(): Promise<void>;
} {
  const providerRequests: BoundaryRequest[] = [];
  const toolRequests: BoundaryRequest[] = [];
  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/v1/responses") {
        providerRequests.push(await captureBoundaryRequest(request));
        if (providerRequests.length === 1) {
          return sseResponse({
            type: "response.completed",
            response: {
              output: [
                {
                  type: "function_call",
                  call_id: "call_native_boundary",
                  name: "burble_provider_call",
                  arguments: JSON.stringify({
                    toolName: "github.getAuthenticatedUser",
                    input: {}
                  })
                }
              ],
              usage: {
                input_tokens: 20,
                output_tokens: 4,
                total_tokens: 24
              }
            }
          });
        }
        return new Response(
          [
            sseData({
              type: "response.output_text.delta",
              delta: "Authenticated as octocat."
            }),
            sseData({
              type: "response.completed",
              response: {
                output_text: "Authenticated as octocat.",
                usage: {
                  input_tokens: 30,
                  output_tokens: 6,
                  total_tokens: 36
                }
              }
            })
          ].join(""),
          { headers: { "content-type": "text/event-stream" } }
        );
      }
      if (
        url.pathname ===
        "/internal/tools/github.getAuthenticatedUser/execute"
      ) {
        toolRequests.push(await captureBoundaryRequest(request));
        return Response.json({
          classification: "user_private",
          content: { login: "octocat" }
        });
      }
      return new Response("Not found", { status: 404 });
    }
  });
  const port = server.port;
  if (!port) {
    void server.stop(true);
    throw new Error("Burble Native boundary server did not bind a port");
  }
  return {
    port,
    providerRequests,
    toolRequests,
    async stop() {
      await server.stop(true);
    }
  };
}

type BoundaryRequest = {
  headers: Headers;
  body: unknown;
};

async function captureBoundaryRequest(request: Request): Promise<BoundaryRequest> {
  return {
    headers: new Headers(request.headers),
    body: await request.json()
  };
}

function sseResponse(payload: Record<string, unknown>): Response {
  return new Response(sseData(payload), {
    headers: { "content-type": "text/event-stream" }
  });
}

function sseData(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function burbleNativeBoundaryRequestManifest() {
  return {
    version: "1",
    policyHash: "policy-native-boundary",
    skills: [],
    tools: [
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
    ],
    memory: {
      userMemoryEnabled: false,
      workspaceMemoryEnabled: false,
      jobMemoryEnabled: true
    },
    streaming: { messageDeltasEnabled: true },
    memoryContext: []
  };
}

async function assertContainerAttachedToNetwork(
  containerName: string,
  network: string
): Promise<void> {
  const template = `{{if index .NetworkSettings.Networks "${network}"}}ok{{end}}`;
  const { code, stdout, stderr } = await runCommand("docker", [
    "inspect",
    "--format",
    template,
    containerName
  ]);
  if (code !== 0 || stdout.trim() !== "ok") {
    throw new Error(
      `docker inspect did not find ${containerName} on ${network}: ${
        stderr.trim() || stdout.trim()
      }`
    );
  }
}

async function assertContainerLogsContain(
  containerName: string,
  expected: string
): Promise<void> {
  const { code, stdout, stderr } = await runCommand("docker", [
    "logs",
    containerName
  ]);
  if (code !== 0) {
    throw new Error(
      `docker logs failed for ${containerName}: ${stderr.trim() || stdout.trim()}`
    );
  }
  if (!stdout.includes(expected) && !stderr.includes(expected)) {
    throw new Error(
      `docker logs for ${containerName} did not contain ${JSON.stringify(expected)}`
    );
  }
}

async function runCommand(
  command: string,
  args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([command, ...args], {
    stdout: "pipe",
    stderr: "pipe"
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  return { code, stdout, stderr };
}
