import { createHmac } from "node:crypto";
import type { AgentRuntimeEngine, TokenStore } from "../db";
import type { RuntimeJwtIssuer } from "../runtime-jwt";
import {
  buildRuntimeDataId,
  hashRuntimeToken,
  nativeAgentConfigFileName,
  type RuntimeConfigRead,
  type PrincipalId,
  type RuntimeFactory,
  type RuntimeHandle,
  type RuntimeManifestBuilder
} from "./runtime-factory";
import type { RuntimeManifest } from "./runtime-manifest";

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
  "OPENAI_BASE_URL",
  "OPENROUTER_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
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
  "OPENCLAW_FAST_MODE",
  "OPENCLAW_RAW_STREAM_DEBUG",
  "OPENCLAW_GATEWAY_PORT",
  "OPENCLAW_GATEWAY_BIND",
  "OPENCLAW_GATEWAY_TOKEN",
  "HERMES_GATEWAY_COMMAND",
  "HERMES_INFERENCE_MODEL",
  "HERMES_MODEL",
  "HERMES_INFERENCE_PROVIDER",
  "HERMES_RUN_TIMEOUT_SECONDS",
  "HERMES_PROGRESS_INTERVAL_SECONDS",
  "HERMES_WEB_BACKEND",
  "HERMES_WEB_SEARCH_BACKEND",
  "HERMES_WEB_EXTRACT_BACKEND",
  "WEB_TOOLS_DEBUG",
  "EXA_API_KEY",
  "PARALLEL_API_KEY",
  "PARALLEL_SEARCH_MODE",
  "TAVILY_API_KEY",
  "FIRECRAWL_API_KEY",
  "FIRECRAWL_API_URL",
  "FIRECRAWL_GATEWAY_URL",
  "SEARXNG_URL",
  "BRAVE_SEARCH_API_KEY",
  "AGENT_BROWSER_ENGINE",
  "AGENT_BROWSER_ARGS",
  "AGENT_BROWSER_EXECUTABLE_PATH",
  "AGENT_BROWSER_IDLE_TIMEOUT_MS",
  "BROWSER_INACTIVITY_TIMEOUT",
  "BROWSER_CDP_URL",
  "BROWSER_USE_API_KEY",
  "BROWSERBASE_API_KEY",
  "BROWSERBASE_PROJECT_ID",
  "BROWSERBASE_PROXIES",
  "BROWSERBASE_ADVANCED_STEALTH",
  "BROWSERBASE_KEEP_ALIVE",
  "BROWSERBASE_SESSION_TIMEOUT",
  "HERMES_BROWSER_ENGINE",
  "HERMES_BROWSER_CLOUD_PROVIDER"
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
  runtimeJwtTtlSeconds?: number;
  runtimeTokenSecret: string;
  openClawConfigPatchPath?: string | null;
  env?: Record<string, string | undefined>;
  execute?: RuntimeCommandExecutor;
  fetch?: RuntimeFetch;
  healthCheckAttempts?: number;
  healthCheckIntervalMs?: number;
  idleTtlMs?: number;
  buildManifest?: RuntimeManifestBuilder;
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
      const manifest = await input.buildManifest?.(principal);
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
        configPath: `${input.dataRoot}/${runtimeDataId}/config/${nativeAgentConfigFileName(
          input.engine
        )}`,
        workspacePath: `${input.dataRoot}/${runtimeDataId}/workspace`,
        policyHash: manifest?.policyHash ?? null
      });
      const runtimeJwt =
        input.runtimeJwtIssuer && input.mcpGatewayUrl
          ? input.runtimeJwtIssuer.issueRuntimeJwt({
              audience: input.mcpAudience ?? input.mcpGatewayUrl,
              runtimeId: runtime.id,
              workspaceId: principal.workspaceId,
              slackUserId: principal.slackUserId,
              ttlSeconds: input.runtimeJwtTtlSeconds
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
        manifest,
        openClawConfigPatchPath: input.openClawConfigPatchPath ?? null,
        env: input.env ?? {}
      });
      input.store.recordAgentRuntimeEvent({
        runtimeId: runtime.id,
        eventType: "runtime_provision_requested",
        summary: {
          engine: input.engine,
          image: input.image,
          ...(manifest ? { policyHash: manifest.policyHash } : {})
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
          attempts:
            input.healthCheckAttempts ??
            defaultRuntimeHealthCheckAttempts(input.engine),
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

      return toRuntimeHandle(runtime, spec, token, manifest);
    },

    async syncRuntimeStatus(runtimeId) {
      const runtime = input.store.getAgentRuntime(runtimeId);
      if (!runtime) {
        return null;
      }

      const runtimeDataId = buildRuntimeDataId(
        {
          workspaceId: runtime.workspaceId,
          slackUserId: runtime.slackUserId
        },
        runtime.engine
      );
      const state = await inspectContainerState(
        buildContainerName(runtimeDataId),
        execute
      );
      if (!state.ok) {
        input.store.updateAgentRuntimeStatus(runtime.id, {
          status: "stopped",
          failureReason: state.failureReason
        });
        return input.store.getAgentRuntime(runtime.id);
      }

      if (state.restarting) {
        input.store.updateAgentRuntimeStatus(runtime.id, {
          status: "failed",
          failureReason: "Runtime container is restarting"
        });
        return input.store.getAgentRuntime(runtime.id);
      }

      if (!state.running) {
        input.store.updateAgentRuntimeStatus(runtime.id, {
          status: state.exitCode && state.exitCode !== 0 ? "failed" : "stopped",
          failureReason:
            state.exitCode && state.exitCode !== 0
              ? `Runtime container exited with code ${state.exitCode}`
              : null
        });
        return input.store.getAgentRuntime(runtime.id);
      }

      try {
        const response = await requestFetch(`${runtime.endpointUrl}/healthz`);
        if (!response.ok) {
          input.store.updateAgentRuntimeStatus(runtime.id, {
            status: "failed",
            failureReason: `Runtime health check failed: HTTP ${response.status}`
          });
          return input.store.getAgentRuntime(runtime.id);
        }
      } catch (error) {
        input.store.updateAgentRuntimeStatus(runtime.id, {
          status: "failed",
          failureReason:
            error instanceof Error
              ? `Runtime health check failed: ${error.message}`
              : "Runtime health check failed"
        });
        return input.store.getAgentRuntime(runtime.id);
      }

      if (
        runtime.status === "failed" ||
        runtime.status === "stopped" ||
        runtime.status === "provisioning"
      ) {
        input.store.updateAgentRuntimeStatus(runtime.id, { status: "ready" });
      }
      return input.store.getAgentRuntime(runtime.id);
    },

    async readRuntimeConfig(runtimeId) {
      const runtime = input.store.getAgentRuntime(runtimeId);
      if (!runtime) {
        throw new Error(`Runtime ${runtimeId} was not found`);
      }

      const runtimeDataId = buildRuntimeDataId(
        {
          workspaceId: runtime.workspaceId,
          slackUserId: runtime.slackUserId
        },
        runtime.engine
      );
      const result = await execute("docker", [
        "exec",
        buildContainerName(runtimeDataId),
        "cat",
        toRuntimeContainerPath({
          hostPath: runtime.configPath,
          runtimeRoot: `${input.dataRoot}/${runtimeDataId}`
        })
      ]);
      if (result.code !== 0) {
        throw new Error(`docker exec cat failed with code ${result.code}`);
      }

      return {
        path: runtime.configPath,
        text: result.stdout
      } satisfies RuntimeConfigRead;
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

type DockerContainerState =
  | {
      ok: true;
      running: boolean;
      restarting: boolean;
      exitCode: number | null;
    }
  | {
      ok: false;
      failureReason: string;
    };

async function inspectContainerState(
  containerName: string,
  execute: RuntimeCommandExecutor
): Promise<DockerContainerState> {
  const result = await execute("docker", [
    "inspect",
    "--format",
    "{{json .State}}",
    containerName
  ]);
  if (result.code !== 0) {
    return {
      ok: false,
      failureReason: "Runtime container is not present"
    };
  }

  try {
    const state = JSON.parse(result.stdout.trim()) as {
      Running?: unknown;
      Restarting?: unknown;
      ExitCode?: unknown;
    };
    return {
      ok: true,
      running: state.Running === true,
      restarting: state.Restarting === true,
      exitCode: typeof state.ExitCode === "number" ? state.ExitCode : null
    };
  } catch {
    return {
      ok: false,
      failureReason: "Could not inspect runtime container state"
    };
  }
}

export function toRuntimeContainerPath(input: {
  hostPath: string;
  runtimeRoot: string;
}): string {
  const normalizedRoot = input.runtimeRoot.replace(/\/+$/, "");
  if (input.hostPath === normalizedRoot) {
    return "/data/openclaw";
  }

  if (input.hostPath.startsWith(`${normalizedRoot}/`)) {
    return `/data/openclaw/${input.hostPath.slice(normalizedRoot.length + 1)}`;
  }

  return input.hostPath;
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
  manifest?: RuntimeManifest | null;
  openClawConfigPatchPath?: string | null;
  env?: Record<string, string | undefined>;
}): ContainerRuntimeSpec {
  const name = buildContainerName(input.runtimeDataId);
  const runtimeRoot = `${input.dataRoot}/${input.runtimeDataId}`;
  const runtimeConfigPath = `/data/openclaw/config/${nativeAgentConfigFileName(
    input.engine
  )}`;
  const env: Record<string, string> = {
    BURBLE_TOOL_GATEWAY_URL: input.toolGatewayUrl,
    BURBLE_INTERNAL_TOKEN: input.runtimeToken,
    AGENT_RUNTIME_ENGINE: input.engine,
    AGENT_RUNTIME_STATE_DIR: "/data/openclaw/state",
    AGENT_RUNTIME_CONFIG_PATH: runtimeConfigPath,
    AGENT_RUNTIME_WORKSPACE_DIR: "/data/openclaw/workspace"
  };

  if (input.engine !== "hermes") {
    Object.assign(env, {
      OPENCLAW_NEMOCLAW_ENGINE: input.engine,
      OPENCLAW_STATE_DIR: "/data/openclaw/state",
      OPENCLAW_CONFIG_PATH: runtimeConfigPath,
      OPENCLAW_WORKSPACE_DIR: "/data/openclaw/workspace"
    });
  }

  if (input.engine === "hermes") {
    Object.assign(env, {
      HERMES_HOME: "/data/openclaw/hermes"
    });
  }

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
  if (input.manifest?.model) {
    const modelId = `${input.manifest.model.provider}:${input.manifest.model.model}`;
    env.AI_MODEL = modelId;
    if (input.engine === "hermes") {
      env.HERMES_INFERENCE_MODEL = modelId;
      env.HERMES_INFERENCE_PROVIDER = input.manifest.model.provider;
    }
  }

  const openClawConfigPatchHostPath =
    input.engine !== "hermes" ? input.openClawConfigPatchPath : null;

  if (openClawConfigPatchHostPath) {
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
      ...(openClawConfigPatchHostPath
        ? [
            {
              source: openClawConfigPatchHostPath,
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
    if (spec.env.BURBLE_RUNTIME_JWT) {
      await assertCommandOk(execute("docker", ["rm", spec.name]), "docker rm");
      await runContainer(spec, execute);
      return;
    }
    await assertCommandOk(execute("docker", ["start", spec.name]), "docker start");
    return;
  }

  await runContainer(spec, execute);
}

function defaultRuntimeHealthCheckAttempts(engine: AgentRuntimeEngine): number {
  return engine === "openclaw" || engine === "openclaw-gateway" ? 90 : 30;
}

async function runContainer(
  spec: ContainerRuntimeSpec,
  execute: RuntimeCommandExecutor
): Promise<void> {
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
  token: string,
  manifest?: RuntimeHandle["manifest"]
): RuntimeHandle {
  return {
    id: runtime.id,
    engine: runtime.engine,
    endpointUrl: spec.endpointUrl,
    authToken: token,
    status: "ready",
    statePath: runtime.statePath,
    configPath: runtime.configPath,
    workspacePath: runtime.workspacePath,
    ...(manifest ? { manifest } : {})
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
