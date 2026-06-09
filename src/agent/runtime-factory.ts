import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  AgentRuntimeEngine,
  AgentRuntimeEventType,
  AgentRuntimeRecord,
  TokenStore
} from "../db";
import { runtimeConfigFileName } from "./runtime-descriptors";
import type { RuntimeManifest } from "./runtime-manifest";

export type PrincipalId = {
  workspaceId: string;
  slackUserId: string;
};

export type RuntimeHandle = {
  id: string;
  engine: AgentRuntimeEngine;
  endpointUrl: string;
  authToken: string;
  status: "ready" | "busy" | "idle";
  statePath: string;
  configPath: string;
  workspacePath: string;
  manifest?: RuntimeManifest;
};

export type RuntimeConfigRead = {
  path: string;
  text: string;
};

export type RuntimeSelectionRequirements = {
  attachments?: boolean;
};

export type RuntimeFactory = {
  getOrCreateRuntime(
    principal: PrincipalId,
    requirements?: RuntimeSelectionRequirements
  ): Promise<RuntimeHandle>;
  syncRuntimeStatus?(runtimeId: string): Promise<AgentRuntimeRecord | null>;
  readRuntimeConfig?(runtimeId: string): Promise<RuntimeConfigRead>;
  stopRuntime(runtimeId: string): Promise<void>;
  reapIdleRuntimes(now: Date): Promise<void>;
  recordRuntimeEvent?: (
    runtimeId: string,
    input: {
      eventType: AgentRuntimeEventType;
      summary?: Record<string, unknown>;
    }
  ) => void;
};

export type RuntimeManifestBuilder = (
  principal: PrincipalId
) => RuntimeManifest | Promise<RuntimeManifest>;

export function createStaticRuntimeFactory(input: {
  store: TokenStore;
  engine: AgentRuntimeEngine;
  endpointUrl: string;
  authToken: string;
  dataRoot: string;
  configFileName?: string;
  buildManifest?: RuntimeManifestBuilder;
}): RuntimeFactory {
  return {
    async getOrCreateRuntime(principal) {
      const runtimeId = buildRuntimeDataId(principal, input.engine);
      const configFileName =
        input.configFileName ?? nativeAgentConfigFileName(input.engine);
      const manifest = await input.buildManifest?.(principal);
      const runtime = input.store.getOrCreateAgentRuntime({
        workspaceId: principal.workspaceId,
        slackUserId: principal.slackUserId,
        engine: input.engine,
        endpointUrl: input.endpointUrl,
        authTokenHash: hashRuntimeToken(input.authToken),
        statePath: `${input.dataRoot}/${runtimeId}/state`,
        configPath: `${input.dataRoot}/${runtimeId}/config/${configFileName}`,
        workspacePath: `${input.dataRoot}/${runtimeId}/workspace`,
        policyHash: manifest?.policyHash ?? null
      });
      input.store.touchAgentRuntime(runtime.id);

      return {
        id: runtime.id,
        engine: runtime.engine,
        endpointUrl: runtime.endpointUrl,
        authToken: input.authToken,
        status: toHandleStatus(runtime.status),
        statePath: runtime.statePath,
        configPath: runtime.configPath,
        workspacePath: runtime.workspacePath,
        ...(manifest ? { manifest } : {})
      };
    },

    async readRuntimeConfig(runtimeId) {
      const runtime = input.store.getAgentRuntime(runtimeId);
      if (!runtime) {
        throw new Error(`Runtime ${runtimeId} was not found`);
      }

      return readRuntimeConfigFromLocalFile(runtime);
    },

    async stopRuntime(runtimeId) {
      input.store.updateAgentRuntimeStatus(runtimeId, { status: "stopped" });
    },

    async reapIdleRuntimes(_now) {
      // The static factory does not own process/container lifecycle.
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

export async function readRuntimeConfigFromLocalFile(
  runtime: AgentRuntimeRecord
): Promise<RuntimeConfigRead> {
  return {
    path: runtime.configPath,
    text: await readFile(runtime.configPath, "utf8")
  };
}

export function nativeAgentConfigFileName(engine: AgentRuntimeEngine): string {
  return runtimeConfigFileName(engine);
}

function toHandleStatus(status: string): RuntimeHandle["status"] {
  return status === "busy" || status === "idle" ? status : "ready";
}

export function buildRuntimeDataId(
  principal: PrincipalId,
  engine: AgentRuntimeEngine
): string {
  return createHash("sha256")
    .update(`${principal.workspaceId}:${principal.slackUserId}:${engine}`)
    .digest("hex")
    .slice(0, 32);
}

export function hashRuntimeToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
