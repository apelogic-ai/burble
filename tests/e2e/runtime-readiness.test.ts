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
} from "../../src/agent/runtime-contract";
import { runRuntimeConformanceCheck } from "../../src/agent/runtime-conformance-harness";
import { createRuntimeContractHttpClient } from "../../src/agent/runtime-contract-http-client";
import { runRuntimeReadinessCheck } from "../../src/agent/runtime-readiness-harness";

const runtimeReadinessDescribe =
  Bun.env.BURBLE_E2E_RUNTIMES === "1" ? describe : describe.skip;
const runtimeConformanceDescribe =
  Bun.env.BURBLE_E2E_CONFORMANCE === "1" ? describe : describe.skip;
const runtimeBootSmokeDescribe =
  Bun.env.BURBLE_E2E_RUNTIME_BOOT_SMOKE === "1" ? describe : describe.skip;

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
          expect(report.checks.map((check) => check.name)).toEqual([
            "manifest",
            "health",
            "run_accepted",
            "events_stream",
            "final_response",
            "usage"
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
  principal: { workspaceId: string; slackUserId: string };
  fetch: RuntimeFetch;
}): Promise<void> {
  const response = await input.fetch(`${input.endpointUrl}/runs`, {
    method: "POST",
    headers: {
      accept: "application/x-ndjson",
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
    text: "Burble Native is ready.",
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
    case "burble-direct":
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
    "--publish",
    "127.0.0.1::8080",
    args[imageIndex] ?? ""
  ]);
};

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
