import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  AgentRuntimeEngine,
  AgentRuntimeEventType,
  AgentRuntimeRecord,
  TokenStore
} from "../db";

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
};

export type RuntimeConfigRead = {
  path: string;
  text: string;
};

export type RuntimeFactory = {
  getOrCreateRuntime(principal: PrincipalId): Promise<RuntimeHandle>;
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

export function createStaticRuntimeFactory(input: {
  store: TokenStore;
  engine: AgentRuntimeEngine;
  endpointUrl: string;
  authToken: string;
  dataRoot: string;
  configFileName?: string;
}): RuntimeFactory {
  return {
    async getOrCreateRuntime(principal) {
      const runtimeId = buildRuntimeDataId(principal, input.engine);
      const configFileName =
        input.configFileName ?? nativeAgentConfigFileName(input.engine);
      const runtime = input.store.getOrCreateAgentRuntime({
        workspaceId: principal.workspaceId,
        slackUserId: principal.slackUserId,
        engine: input.engine,
        endpointUrl: input.endpointUrl,
        authTokenHash: hashRuntimeToken(input.authToken),
        statePath: `${input.dataRoot}/${runtimeId}/state`,
        configPath: `${input.dataRoot}/${runtimeId}/config/${configFileName}`,
        workspacePath: `${input.dataRoot}/${runtimeId}/workspace`
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
        workspacePath: runtime.workspacePath
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
  return engine === "hermes" ? "hermes.json" : "openclaw.json";
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
