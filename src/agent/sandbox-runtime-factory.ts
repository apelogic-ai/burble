import { createHash } from "node:crypto";
import {
  buildAgentRuntimeId,
  type AgentRuntimeEngine,
  type AgentRuntimeRecord,
  type TokenStore
} from "../db";
import type { RuntimeJwtIssuer } from "../runtime-jwt";
import { buildBrokeredRuntimeSandboxPolicy } from "./sandbox-policy";
import type {
  SandboxCredentialBinding,
  SandboxPolicy,
  SandboxProvider,
  SandboxRunHandle
} from "./sandbox-provider";
import {
  runtimeDescriptor,
  runtimeHealthCheckAttempts
} from "./runtime-descriptors";
import {
  buildRuntimeDataId,
  deriveRuntimeToken,
  hashRuntimeToken,
  nativeAgentConfigFileName,
  type PrincipalId,
  type RuntimeFactory,
  type RuntimeHandle,
  type RuntimeManifestBuilder
} from "./runtime-factory";
import type { RuntimeManifest } from "./runtime-manifest";
import {
  collectApprovedRuntimeEnv,
  modelProviderUrlsForRuntimeModel,
  runtimeExtraAllowedUrlsFromEnv
} from "./runtime-env";
import { routeRuntimeEndpointFetch } from "./runtime-endpoint-routing";

export type SandboxRuntimeFetch = (
  input: string,
  init?: RequestInit
) => Promise<Response>;

export type SandboxRuntimeFactoryPolicyBuilder = (input: {
  principal: PrincipalId;
  engine: AgentRuntimeEngine;
  runtimeId: string;
  runtimeDataId: string;
  manifest?: RuntimeManifest | null;
}) => SandboxPolicy | Promise<SandboxPolicy>;

export type SandboxRuntimeFactoryCredentialBuilder = (input: {
  principal: PrincipalId;
  engine: AgentRuntimeEngine;
  runtimeId: string;
  runtimeDataId: string;
  manifest?: RuntimeManifest | null;
}) => SandboxCredentialBinding[] | Promise<SandboxCredentialBinding[]>;

export function createSandboxRuntimeFactory(input: {
  store: TokenStore;
  sandboxProvider: SandboxProvider;
  engine: AgentRuntimeEngine;
  image: string;
  toolGatewayUrl: string;
  modelProviderUrls: string[];
  startCommand: string[];
  mcpGatewayUrl?: string | null;
  mcpAudience?: string | null;
  runtimeJwtIssuer?: RuntimeJwtIssuer | null;
  runtimeJwtTtlSeconds?: number;
  runtimeTokenSecret: string;
  fetch?: SandboxRuntimeFetch;
  openShellDialHost?: string | null;
  healthCheckAttempts?: number;
  healthCheckIntervalMs?: number;
  idleTtlMs?: number;
  buildManifest?: RuntimeManifestBuilder;
  buildPolicy?: SandboxRuntimeFactoryPolicyBuilder;
  buildCredentials?: SandboxRuntimeFactoryCredentialBuilder;
  env?: Record<string, string | undefined>;
}): RuntimeFactory {
  assertSandboxProviderCapabilities(input.sandboxProvider);
  assertSandboxStartCommand(input.startCommand);
  const requestFetch = routeRuntimeEndpointFetch(input.fetch ?? fetch, {
    openShellDialHost: input.openShellDialHost
  });
  const runtimeLocks = new Map<string, Promise<void>>();

  const stopRuntime = async (runtimeId: string): Promise<void> => {
    const runtime = input.store.getAgentRuntime(runtimeId);
    if (!runtime?.sandboxId) {
      return;
    }

    await input.sandboxProvider.terminate(runtime.sandboxId);
    input.store.updateAgentRuntimeStatus(runtimeId, { status: "stopped" });
    input.store.recordAgentRuntimeEvent({
      runtimeId,
      eventType: "runtime_stopped",
      summary: { reason: "idle_or_requested", sandboxId: runtime.sandboxId }
    });
  };

  const getOrCreateRuntimeLocked = async (
    principal: PrincipalId
  ): Promise<RuntimeHandle> => {
    const runtimeDataId = buildRuntimeDataId(principal, input.engine);
    const manifest = await input.buildManifest?.(principal);
    const token = deriveRuntimeToken({
      secret: input.runtimeTokenSecret,
      principal,
      engine: input.engine
    });
    const existing = input.store.getAgentRuntimeForPrincipal({
      workspaceId: principal.workspaceId,
      slackUserId: principal.slackUserId,
      engine: input.engine
    });

    if (
      existing?.sandboxId &&
      existing.status !== "stopped" &&
      existing.status !== "failed"
    ) {
      const attached = await input.sandboxProvider.attach(existing.sandboxId);
      const paths = sandboxRuntimePaths(attached.workspacePath, input.engine);
      const policy =
        (await input.buildPolicy?.({
          principal,
          engine: input.engine,
          runtimeId: existing.id,
          runtimeDataId,
          manifest
        })) ??
        buildDefaultSandboxPolicy(input, manifest);
      const policyHash = sandboxRuntimePolicyHash(manifest, policy);
      if (existing.policyHash !== policyHash) {
        await input.sandboxProvider.applyPolicy(attached.id, policy);
      }
      const updated = input.store.getOrCreateAgentRuntime({
        workspaceId: principal.workspaceId,
        slackUserId: principal.slackUserId,
        engine: input.engine,
        endpointUrl: attached.endpointUrl,
        authTokenHash: hashRuntimeToken(token),
        statePath: paths.statePath,
        configPath: paths.configPath,
        workspacePath: attached.workspacePath,
        sandboxId: attached.id,
        policyHash
      });
      await waitForSandboxRuntimeHealth({
        endpointUrl: attached.endpointUrl,
        fetch: requestFetch,
        attempts:
          input.healthCheckAttempts ??
          runtimeHealthCheckAttempts(input.engine),
        intervalMs: input.healthCheckIntervalMs ?? 1000
      });
      input.store.touchAgentRuntime(existing.id);
      if (existing.status === "provisioning") {
        input.store.updateAgentRuntimeStatus(existing.id, { status: "ready" });
      }
      return toRuntimeHandle(
        input.store.getAgentRuntime(existing.id) ?? updated,
        token,
        manifest
      );
    }

    const runtimeId = buildAgentRuntimeId(
      principal.workspaceId,
      principal.slackUserId,
      input.engine
    );
    const context = {
      principal,
      engine: input.engine,
      runtimeId,
      runtimeDataId,
      manifest
    };
    const runtimeJwt =
      input.runtimeJwtIssuer && input.mcpGatewayUrl
        ? input.runtimeJwtIssuer.issueRuntimeJwt({
            audience: input.mcpAudience ?? input.mcpGatewayUrl,
            runtimeId,
            workspaceId: principal.workspaceId,
            slackUserId: principal.slackUserId,
            ttlSeconds: input.runtimeJwtTtlSeconds
          })
        : null;

    const sandbox = await input.sandboxProvider.provision({
      principal: {
        workspaceId: principal.workspaceId,
        userId: principal.slackUserId
      },
      runtime: {
        engine: input.engine,
        image: input.image
      },
      labels: {
        runtimeDataId,
        engine: input.engine
      }
    });
    const paths = sandboxRuntimePaths(sandbox.workspacePath, input.engine);
    let runtime: AgentRuntimeRecord | null = null;

    try {
      const policy =
        (await input.buildPolicy?.(context)) ??
        buildDefaultSandboxPolicy(input, manifest);
      const policyHash = sandboxRuntimePolicyHash(manifest, policy);
      runtime = input.store.getOrCreateAgentRuntime({
        workspaceId: principal.workspaceId,
        slackUserId: principal.slackUserId,
        engine: input.engine,
        endpointUrl: sandbox.endpointUrl,
        authTokenHash: hashRuntimeToken(token),
        statePath: paths.statePath,
        configPath: paths.configPath,
        workspacePath: sandbox.workspacePath,
        sandboxId: sandbox.id,
        policyHash
      });
      const credentials = (await input.buildCredentials?.(context)) ?? [];

      input.store.recordAgentRuntimeEvent({
        runtimeId: runtime.id,
        eventType: "runtime_provision_requested",
        summary: {
          engine: input.engine,
          image: input.image,
          sandboxId: sandbox.id,
          policyHash
        }
      });
      input.store.updateAgentRuntimeStatus(runtime.id, {
        status: "provisioning"
      });
      await input.sandboxProvider.applyPolicy(sandbox.id, policy);
      if (credentials.length > 0) {
        await input.sandboxProvider.bindCredentials(sandbox.id, credentials);
      }
      const run = await input.sandboxProvider.run(sandbox.id, {
        argv: input.startCommand,
        env: buildSandboxRuntimeEnv({
          engine: input.engine,
          toolGatewayUrl: input.toolGatewayUrl,
          mcpGatewayUrl: input.mcpGatewayUrl ?? null,
          runtimeToken: token,
          runtimeId: runtime.id,
          runtimeJwt,
          manifest,
          env: input.env ?? {}
        })
      });
      if (run.status === "failed" || run.status === "finished") {
        throw new Error(formatSandboxRuntimeStartFailure(run));
      }
      await waitForSandboxRuntimeHealth({
        endpointUrl: sandbox.endpointUrl,
        fetch: requestFetch,
        attempts:
          input.healthCheckAttempts ??
          runtimeHealthCheckAttempts(input.engine),
        intervalMs: input.healthCheckIntervalMs ?? 1000
      });
      input.store.updateAgentRuntimeStatus(runtime.id, { status: "ready" });
      input.store.recordAgentRuntimeEvent({
        runtimeId: runtime.id,
        eventType: "runtime_provision_finished",
        summary: {
          endpointUrl: sandbox.endpointUrl,
          sandboxId: sandbox.id
        }
      });
      input.store.touchAgentRuntime(runtime.id);
    } catch (error) {
      const failureReason =
        error instanceof Error ? error.message : "unknown error";
      let cleanupError: string | undefined;
      try {
        await input.sandboxProvider.terminate(sandbox.id);
      } catch (terminateError) {
        cleanupError =
          terminateError instanceof Error
            ? terminateError.message
            : "unknown cleanup error";
      }
      if (runtime) {
        input.store.updateAgentRuntimeStatus(runtime.id, {
          status: "failed",
          failureReason
        });
        input.store.recordAgentRuntimeEvent({
          runtimeId: runtime.id,
          eventType: "runtime_provision_failed",
          summary: {
            failureReason,
            sandboxId: sandbox.id,
            ...(cleanupError ? { cleanupError } : {})
          }
        });
      }
      throw error;
    }

    return toRuntimeHandle(
      input.store.getAgentRuntime(runtime.id) ?? runtime,
      token,
      manifest
    );
  };

  return {
    async getOrCreateRuntime(principal) {
      return withRuntimeProvisionLock(runtimeLocks, principal, input.engine, () =>
        getOrCreateRuntimeLocked(principal)
      );
    },

    async syncRuntimeStatus(runtimeId) {
      const runtime = input.store.getAgentRuntime(runtimeId);
      if (!runtime?.sandboxId) {
        return runtime;
      }

      try {
        const sandbox = await input.sandboxProvider.attach(runtime.sandboxId);
        if (sandbox.status === "terminated") {
          input.store.updateAgentRuntimeStatus(runtime.id, {
            status: "stopped"
          });
          return input.store.getAgentRuntime(runtime.id);
        }
        if (sandbox.status === "failed") {
          input.store.updateAgentRuntimeStatus(runtime.id, {
            status: "failed",
            failureReason: "Sandbox runtime failed"
          });
          return input.store.getAgentRuntime(runtime.id);
        }
        const response = await requestFetch(`${runtime.endpointUrl}/healthz`);
        input.store.updateAgentRuntimeStatus(runtime.id, {
          status: response.ok ? "ready" : "failed",
          failureReason: response.ok
            ? null
            : `Runtime health check failed: HTTP ${response.status}`
        });
        return input.store.getAgentRuntime(runtime.id);
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
        .filter((runtime) => runtime.engine === input.engine && runtime.sandboxId);

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

function formatSandboxRuntimeStartFailure(run: SandboxRunHandle): string {
  const output = run.output?.trim();
  const outputPreview = output ? singleLinePreview(output) : "";
  return `Sandbox runtime start ${
    run.status === "finished" ? "exited" : "failed"
  }: ${run.id}${run.exitCode === undefined ? "" : ` (exit ${run.exitCode})`}${
    outputPreview ? `; output: ${outputPreview}` : ""
  }${output && output !== outputPreview ? `\n${output}` : ""}`;
}

function singleLinePreview(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

function assertSandboxProviderCapabilities(provider: SandboxProvider): void {
  const capabilities = provider.capabilities();
  if (!capabilities.supportsEgressAllowlist) {
    throw new Error(
      `Sandbox provider ${capabilities.provider} must support egress allowlists for runtime provisioning`
    );
  }
  if (!capabilities.supportsDurableSandboxes) {
    throw new Error(
      `Sandbox provider ${capabilities.provider} must support durable sandboxes for runtime provisioning`
    );
  }
}

function assertSandboxStartCommand(startCommand: string[]): void {
  if (
    startCommand.length === 0 ||
    startCommand.some((part) => part.trim() === "")
  ) {
    throw new Error("Sandbox runtime start command must be non-empty");
  }
}

async function withRuntimeProvisionLock<T>(
  locks: Map<string, Promise<void>>,
  principal: PrincipalId,
  engine: AgentRuntimeEngine,
  operation: () => Promise<T>
): Promise<T> {
  const key = `${principal.workspaceId}:${principal.slackUserId}:${engine}`;
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.catch(() => undefined).then(() => current);
  locks.set(key, chained);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(key) === chained) {
      locks.delete(key);
    }
  }
}

function buildDefaultSandboxPolicy(
  input: {
    toolGatewayUrl: string;
    mcpGatewayUrl?: string | null;
    modelProviderUrls: string[];
    env?: Record<string, string | undefined>;
  },
  manifest?: RuntimeManifest | null
): SandboxPolicy {
  const env = input.env ?? {};
  return buildBrokeredRuntimeSandboxPolicy({
    toolGatewayUrl: input.toolGatewayUrl,
    mcpGatewayUrl: input.mcpGatewayUrl ?? null,
    modelProviderUrls: manifest?.model
      ? modelProviderUrlsForRuntimeModel(manifest.model, env)
      : input.modelProviderUrls,
    extraAllowedUrls: runtimeExtraAllowedUrlsFromEnv(env)
  });
}

function sandboxRuntimePolicyHash(
  manifest: RuntimeManifest | null | undefined,
  policy: SandboxPolicy
): string {
  // Sandbox runtimes enforce egress outside the agent process, so env-derived
  // egress changes are part of the effective runtime policy. Scheduled
  // capabilities registered against an older hash fail closed and must
  // re-register after this changes.
  return createHash("sha256")
    .update(
      JSON.stringify(
        sortJson({
          manifestPolicyHash: manifest?.policyHash ?? null,
          sandboxPolicy: policy
        })
      )
    )
    .digest("hex");
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildSandboxRuntimeEnv(input: {
  engine: AgentRuntimeEngine;
  toolGatewayUrl: string;
  mcpGatewayUrl: string | null;
  runtimeToken: string;
  runtimeId: string;
  runtimeJwt: string | null;
  manifest?: RuntimeManifest | null;
  env: Record<string, string | undefined>;
}): Record<string, string> {
  const container = runtimeDescriptor(input.engine).container;
  const configPath = `${container.dataRootTarget}/config/${container.configFileName}`;
  const env: Record<string, string> = {
    BURBLE_TOOL_GATEWAY_URL: input.toolGatewayUrl,
    // Deliberate S3 backstop: the legacy tool gateway still uses this
    // symmetric runtime token in-env. MCP uses the scoped JWT below; moving
    // tool-gateway auth to that model is a separate credential-boundary step.
    BURBLE_INTERNAL_TOKEN: input.runtimeToken,
    BURBLE_RUNTIME_ID: input.runtimeId,
    AGENT_RUNTIME_ENGINE: input.engine,
    AGENT_RUNTIME_STATE_DIR: container.stateDir,
    AGENT_RUNTIME_CONFIG_PATH: configPath,
    AGENT_RUNTIME_WORKSPACE_DIR: container.workspaceDir
  };

  if (container.openClawCompatEnv) {
    Object.assign(env, {
      OPENCLAW_NEMOCLAW_ENGINE: input.engine,
      OPENCLAW_STATE_DIR: container.stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_WORKSPACE_DIR: container.workspaceDir
    });
  }

  if (container.hermesHome) {
    env.HERMES_HOME = container.hermesHome;
  }

  if (input.mcpGatewayUrl && input.runtimeJwt) {
    env.BURBLE_MCP_GATEWAY_URL = input.mcpGatewayUrl;
    env.BURBLE_RUNTIME_JWT = input.runtimeJwt;
  }

  Object.assign(env, collectApprovedRuntimeEnv(input.env));

  if (input.manifest?.model) {
    const modelId = `${input.manifest.model.provider}:${input.manifest.model.model}`;
    env.AI_MODEL = modelId;
    if (container.modelEnv === "hermes") {
      env.HERMES_INFERENCE_MODEL = modelId;
      env.HERMES_INFERENCE_PROVIDER = input.manifest.model.provider;
    }
  } else if (input.env.AI_MODEL?.trim()) {
    env.AI_MODEL = input.env.AI_MODEL.trim();
  }

  return env;
}

function sandboxRuntimePaths(
  workspacePath: string,
  engine: AgentRuntimeEngine
): { statePath: string; configPath: string } {
  return {
    statePath: `${workspacePath}/state`,
    configPath: `${workspacePath}/config/${nativeAgentConfigFileName(engine)}`
  };
}

async function waitForSandboxRuntimeHealth(input: {
  endpointUrl: string;
  fetch: SandboxRuntimeFetch;
  attempts: number;
  intervalMs: number;
}): Promise<void> {
  let lastError: unknown;
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
    if (attempt < input.attempts - 1 && input.intervalMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, input.intervalMs));
    }
  }
  throw new Error(
    `Runtime health check failed: ${
      lastError instanceof Error ? lastError.message : "unknown error"
    }`
  );
}

function toRuntimeHandle(
  runtime: {
    id: string;
    engine: AgentRuntimeEngine;
    endpointUrl: string;
    status: string;
    statePath: string;
    configPath: string;
    workspacePath: string;
  },
  authToken: string,
  manifest?: RuntimeManifest | null
): RuntimeHandle {
  return {
    id: runtime.id,
    engine: runtime.engine,
    endpointUrl: runtime.endpointUrl,
    authToken,
    status:
      runtime.status === "busy" || runtime.status === "idle"
        ? runtime.status
        : "ready",
    statePath: runtime.statePath,
    configPath: runtime.configPath,
    workspacePath: runtime.workspacePath,
    ...(manifest ? { manifest } : {})
  };
}
