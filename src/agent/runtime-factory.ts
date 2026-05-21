import { createHash } from "node:crypto";
import type { AgentRuntimeEngine, AgentRuntimeEventType, TokenStore } from "../db";

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

export type RuntimeFactory = {
  getOrCreateRuntime(principal: PrincipalId): Promise<RuntimeHandle>;
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
}): RuntimeFactory {
  return {
    async getOrCreateRuntime(principal) {
      const runtimeId = buildRuntimeDataId(principal, input.engine);
      const runtime = input.store.getOrCreateAgentRuntime({
        workspaceId: principal.workspaceId,
        slackUserId: principal.slackUserId,
        engine: input.engine,
        endpointUrl: input.endpointUrl,
        authTokenHash: hashRuntimeToken(input.authToken),
        statePath: `${input.dataRoot}/${runtimeId}/state`,
        configPath: `${input.dataRoot}/${runtimeId}/config/openclaw.json`,
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
