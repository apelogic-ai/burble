import { createHmac } from "node:crypto";
import type { AgentRuntimeEngine, TokenStore } from "../db";
import type { RuntimeJwtIssuer } from "../runtime-jwt";
import {
  buildRuntimeDataId,
  hashRuntimeToken,
  type PrincipalId,
  type RuntimeFactory,
  type RuntimeHandle
} from "./runtime-factory";

export type RuntimeCommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type RuntimeCommandExecutor = (
  command: string,
  args: string[]
) => Promise<RuntimeCommandResult>;

export type RuntimeFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type ContainerRuntimeSpec = {
  name: string;
  image: string;
  network: string;
  endpointUrl: string;
  env: Record<string, string>;
  volumes: Array<{ source: string; target: string; readonly?: boolean }>;
};

const approvedForwardedEnv = new Set([
  "AI_MODEL",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OLLAMA_API_KEY",
  "OLLAMA_BASE_URL",
  "OLLAMA_OPENAI_BASE_URL",
  "OPENCLAW_TIMEOUT_MS",
  "OPENCLAW_STREAM_DEBUG",
  "OPENCLAW_LOG_LEVEL",
  "OPENCLAW_DIAGNOSTICS",
  "OPENCLAW_DEBUG_MODEL_TRANSPORT",
  "OPENCLAW_DEBUG_MODEL_PAYLOAD",
  "OPENCLAW_DEBUG_SSE",
  "OPENCLAW_DEBUG_CODE_MODE",
  "OPENCLAW_RAW_STREAM_DEBUG"
]);

export function createDockerRuntimeFactory(input: {
  store: TokenStore;
  engine: AgentRuntimeEngine;
  image: string;
  dataRoot: string;
  dockerNetwork: string;
  toolGatewayUrl: string;
  mcpGatewayUrl?: string | null;
  mcpAudience?: string | null;
  runtimeJwtIssuer?: RuntimeJwtIssuer | null;
  runtimeTokenSecret: string;
  openClawConfigPatchPath?: string | null;
  env?: Record<string, string | undefined>;
  execute?: RuntimeCommandExecutor;
  fetch?: RuntimeFetch;
  healthCheckAttempts?: number;
  healthCheckIntervalMs?: number;
  idleTtlMs?: number;
}): RuntimeFactory {
  const execute = input.execute ?? executeCommand;
  const requestFetch = input.fetch ?? fetch;
  const stopRuntime = async (runtimeId: string): Promise<void> => {
    const runtime = input.store.getAgentRuntime(runtimeId);
    if (!runtime) {
      return;
    }

    const runtimeDataId = buildRuntimeDataId(
      {
        workspaceId: runtime.workspaceId,
        slackUserId: runtime.slackUserId
      },
      runtime.engine
    );
    await execute("docker", ["stop", buildContainerName(runtimeDataId)]);
    input.store.updateAgentRuntimeStatus(runtimeId, { status: "stopped" });
    input.store.recordAgentRuntimeEvent({
      runtimeId,
      eventType: "runtime_stopped",
      summary: { reason: "idle_or_requested" }
    });
  };

  return {
    async getOrCreateRuntime(principal) {
      const runtimeDataId = buildRuntimeDataId(principal, input.engine);
      const token = deriveRuntimeToken({
        secret: input.runtimeTokenSecret,
        principal,
        engine: input.engine
      });
      const endpointUrl = `http://${buildContainerName(runtimeDataId)}:8080`;
      const runtime = input.store.getOrCreateAgentRuntime({
        workspaceId: principal.workspaceId,
        slackUserId: principal.slackUserId,
        engine: input.engine,
        endpointUrl,
        authTokenHash: hashRuntimeToken(token),
        statePath: `${input.dataRoot}/${runtimeDataId}/state`,
        configPath: `${input.dataRoot}/${runtimeDataId}/config/openclaw.json`,
        workspacePath: `${input.dataRoot}/${runtimeDataId}/workspace`
      });
      const runtimeJwt =
        input.runtimeJwtIssuer && input.mcpGatewayUrl
          ? input.runtimeJwtIssuer.issueRuntimeJwt({
              audience: input.mcpAudience ?? input.mcpGatewayUrl,
              runtimeId: runtime.id,
              workspaceId: principal.workspaceId,
              slackUserId: principal.slackUserId
            })
          : null;
      const spec = buildContainerRuntimeSpec({
        principal,
        engine: input.engine,
        image: input.image,
        dataRoot: input.dataRoot,
        dockerNetwork: input.dockerNetwork,
        toolGatewayUrl: input.toolGatewayUrl,
        mcpGatewayUrl: input.mcpGatewayUrl ?? null,
        runtimeToken: token,
        runtimeId: runtime.id,
        runtimeJwt,
        runtimeDataId,
        openClawConfigPatchPath: input.openClawConfigPatchPath ?? null,
        env: input.env ?? {}
      });
      input.store.recordAgentRuntimeEvent({
        runtimeId: runtime.id,
        eventType: "runtime_provision_requested",
        summary: {
          engine: input.engine,
          image: input.image
        }
      });

      input.store.updateAgentRuntimeStatus(runtime.id, {
        status: "provisioning"
      });

      try {
        await ensureContainerRunning(spec, execute);
        await waitForRuntimeHealth({
          endpointUrl: spec.endpointUrl,
          fetch: requestFetch,
          attempts: input.healthCheckAttempts ?? 30,
          intervalMs: input.healthCheckIntervalMs ?? 1000
        });
        input.store.updateAgentRuntimeStatus(runtime.id, { status: "ready" });
        input.store.recordAgentRuntimeEvent({
          runtimeId: runtime.id,
          eventType: "runtime_provision_finished",
          summary: {
            endpointUrl: spec.endpointUrl
          }
        });
        input.store.touchAgentRuntime(runtime.id);
      } catch (error) {
        const failureReason =
          error instanceof Error ? error.message : "unknown error";
        input.store.updateAgentRuntimeStatus(runtime.id, {
          status: "failed",
          failureReason
        });
        input.store.recordAgentRuntimeEvent({
          runtimeId: runtime.id,
          eventType: "runtime_provision_failed",
          summary: { failureReason }
        });
        throw error;
      }

      return toRuntimeHandle(runtime, spec, token);
    },

    async stopRuntime(runtimeId) {
      await stopRuntime(runtimeId);
    },

    async reapIdleRuntimes(now) {
      const idleBefore = new Date(
        now.getTime() - (input.idleTtlMs ?? 30 * 60 * 1000)
      );
      const staleRuntimes = input.store
        .listIdleAgentRuntimes(idleBefore)
        .filter((runtime) => runtime.engine === input.engine);

      for (const runtime of staleRuntimes) {
        await stopRuntime(runtime.id);
      }
    },

    recordRuntimeEvent(runtimeId, event) {
      input.store.recordAgentRuntimeEvent({
        runtimeId,
        eventType: event.eventType,
        summary: event.summary
      });
    }
  };
}

export function buildContainerRuntimeSpec(input: {
  principal: PrincipalId;
  engine: AgentRuntimeEngine;
  image: string;
  dataRoot: string;
  dockerNetwork: string;
  toolGatewayUrl: string;
  mcpGatewayUrl?: string | null;
  runtimeToken: string;
  runtimeId?: string;
  runtimeJwt?: string | null;
  runtimeDataId: string;
  openClawConfigPatchPath?: string | null;
  env?: Record<string, string | undefined>;
}): ContainerRuntimeSpec {
  const name = buildContainerName(input.runtimeDataId);
  const runtimeRoot = `${input.dataRoot}/${input.runtimeDataId}`;
  const env: Record<string, string> = {
    BURBLE_TOOL_GATEWAY_URL: input.toolGatewayUrl,
    BURBLE_INTERNAL_TOKEN: input.runtimeToken,
    OPENCLAW_NEMOCLAW_ENGINE: input.engine,
    OPENCLAW_STATE_DIR: "/data/openclaw/state",
    OPENCLAW_CONFIG_PATH: "/data/openclaw/config/openclaw.json",
    OPENCLAW_WORKSPACE_DIR: "/data/openclaw/workspace"
  };

  if (input.runtimeId) {
    env.BURBLE_RUNTIME_ID = input.runtimeId;
  }

  if (input.mcpGatewayUrl && input.runtimeJwt) {
    env.BURBLE_MCP_GATEWAY_URL = input.mcpGatewayUrl;
    env.BURBLE_RUNTIME_JWT = input.runtimeJwt;
  }

  for (const key of approvedForwardedEnv) {
    const value = input.env?.[key]?.trim();
    if (value) {
      env[key] = value;
    }
  }

  if (input.openClawConfigPatchPath) {
    env.OPENCLAW_CONFIG_PATCH_PATH = "/etc/openclaw/patches/openai.json5";
  }

  return {
    name,
    image: input.image,
    network: input.dockerNetwork,
    endpointUrl: `http://${name}:8080`,
    env,
    volumes: [
      { source: runtimeRoot, target: "/data/openclaw" },
      ...(input.openClawConfigPatchPath
        ? [
            {
              source: input.openClawConfigPatchPath,
              target: "/etc/openclaw/patches",
              readonly: true
            }
          ]
        : [])
    ]
  };
}

export function deriveRuntimeToken(input: {
  secret: string;
  principal: PrincipalId;
  engine: AgentRuntimeEngine;
}): string {
  const digest = createHmac("sha256", input.secret)
    .update(
      `${input.principal.workspaceId}:${input.principal.slackUserId}:${input.engine}`
    )
    .digest("hex");

  return `burble_rt_${digest}`;
}

function buildContainerName(runtimeDataId: string): string {
  return `burble-rt-${runtimeDataId}`;
}

async function ensureContainerRunning(
  spec: ContainerRuntimeSpec,
  execute: RuntimeCommandExecutor
): Promise<void> {
  const inspected = await execute("docker", [
    "inspect",
    "--format",
    "{{.State.Running}}",
    spec.name
  ]);

  if (inspected.code === 0 && inspected.stdout.trim() === "true") {
    return;
  }

  if (inspected.code === 0) {
    await assertCommandOk(execute("docker", ["start", spec.name]), "docker start");
    return;
  }

  await assertCommandOk(
    execute("docker", [
      "run",
      "--detach",
      "--name",
      spec.name,
      "--network",
      spec.network,
      "--restart",
      "unless-stopped",
      ...Object.entries(spec.env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
      ...spec.volumes.flatMap((volume) => [
        "-v",
        `${volume.source}:${volume.target}${volume.readonly ? ":ro" : ""}`
      ]),
      spec.image
    ]),
    "docker run"
  );
}

async function waitForRuntimeHealth(input: {
  endpointUrl: string;
  fetch: RuntimeFetch;
  attempts: number;
  intervalMs: number;
}): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < input.attempts; attempt += 1) {
    try {
      const response = await input.fetch(`${input.endpointUrl}/healthz`);
      if (response.ok) {
        return;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    if (attempt < input.attempts - 1) {
      await sleep(input.intervalMs);
    }
  }

  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`Runtime health check failed${detail}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function assertCommandOk(
  resultPromise: Promise<RuntimeCommandResult>,
  description: string
): Promise<void> {
  const result = await resultPromise;
  if (result.code !== 0) {
    throw new Error(`${description} failed with code ${result.code}`);
  }
}

function toRuntimeHandle(
  runtime: {
    id: string;
    engine: AgentRuntimeEngine;
    statePath: string;
    configPath: string;
    workspacePath: string;
  },
  spec: ContainerRuntimeSpec,
  token: string
): RuntimeHandle {
  return {
    id: runtime.id,
    engine: runtime.engine,
    endpointUrl: spec.endpointUrl,
    authToken: token,
    status: "ready",
    statePath: runtime.statePath,
    configPath: runtime.configPath,
    workspacePath: runtime.workspacePath
  };
}

async function executeCommand(
  command: string,
  args: string[]
): Promise<RuntimeCommandResult> {
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
