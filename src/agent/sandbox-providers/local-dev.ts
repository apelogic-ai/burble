import { randomUUID } from "node:crypto";
import {
  cloneSandboxEvent,
  cloneSandboxEventDetail,
  cloneSandboxHandle,
  cloneSandboxPolicy,
  type SandboxCredentialBinding,
  type SandboxEvent,
  type SandboxHandle,
  type SandboxPolicy,
  type SandboxProvider,
  type SandboxProviderCapabilities,
  type SandboxProvisionRequest,
  type SandboxRunHandle,
  type SandboxRunRequest
} from "../sandbox-provider";

export type LocalDevSandboxProvider = SandboxProvider;

type SandboxState = {
  handle: SandboxHandle;
  events: SandboxEvent[];
};

export function createLocalDevSandboxProvider(): LocalDevSandboxProvider {
  const sandboxes = new Map<string, SandboxState>();
  let eventSequence = 0;

  const load = (sandboxId: string): SandboxState => {
    const state = sandboxes.get(sandboxId);
    if (!state) {
      throw new Error(`Sandbox ${sandboxId} was not found`);
    }
    return state;
  };

  const recordEvent = (
    state: SandboxState,
    type: SandboxEvent["type"],
    detail?: Record<string, unknown>
  ): void => {
    state.events.push({
      sandboxId: state.handle.id,
      type,
      at: new Date(eventSequence++).toISOString(),
      ...(detail ? { detail: cloneSandboxEventDetail(detail) } : {})
    });
  };

  return {
    capabilities(): SandboxProviderCapabilities {
      return {
        provider: "local-dev",
        isolation: "process",
        supportsEgressAllowlist: false,
        supportsCredentialBinding: false,
        supportsDurableSandboxes: false
      };
    },

    async provision(request: SandboxProvisionRequest): Promise<SandboxHandle> {
      const id = `sandbox-${nextSandboxId()}`;
      const handle: SandboxHandle = {
        id,
        provider: "local-dev",
        status: "ready",
        endpointUrl: `http://${id}.local`,
        workspacePath: `/tmp/burble-sandboxes/${id}/workspace`,
        principal: request.principal,
        runtime: request.runtime,
        labels: request.labels ?? {},
        credentials: []
      };
      const state: SandboxState = {
        handle: cloneSandboxHandle(handle),
        events: []
      };
      recordEvent(state, "provisioned", { image: request.runtime.image });
      sandboxes.set(id, state);
      return cloneSandboxHandle(handle);
    },

    async applyPolicy(
      sandboxId: string,
      policy: SandboxPolicy
    ): Promise<SandboxHandle> {
      const state = load(sandboxId);
      if (policy.network.egress !== "open") {
        throw new Error(
          "local-dev does not support enforced egress policies"
        );
      }
      state.handle = {
        ...state.handle,
        policy: cloneSandboxPolicy(policy)
      };
      recordEvent(state, "policy_applied", { egress: policy.network.egress });
      return cloneSandboxHandle(state.handle);
    },

    async bindCredentials(
      sandboxId: string,
      _credentials: SandboxCredentialBinding[]
    ): Promise<SandboxHandle> {
      load(sandboxId);
      throw new Error("local-dev does not support credential binding");
    },

    async run(
      sandboxId: string,
      request: SandboxRunRequest
    ): Promise<SandboxRunHandle> {
      const state = load(sandboxId);
      const runId = `${sandboxId}-run-${state.events.length}`;
      state.handle = {
        ...state.handle,
        status: "running"
      };
      recordEvent(state, "run_started", { argv: request.argv });
      state.handle = {
        ...state.handle,
        status: "ready"
      };
      recordEvent(state, "run_finished", { exitCode: 0 });
      return {
        id: runId,
        sandboxId,
        status: "finished",
        exitCode: 0
      };
    },

    async attach(sandboxId: string): Promise<SandboxHandle> {
      return cloneSandboxHandle(load(sandboxId).handle);
    },

    async *streamEvents(sandboxId: string): AsyncIterable<SandboxEvent> {
      for (const event of load(sandboxId).events) {
        yield cloneSandboxEvent(event);
      }
    },

    async terminate(sandboxId: string): Promise<void> {
      const state = load(sandboxId);
      state.handle = {
        ...state.handle,
        status: "terminated"
      };
      recordEvent(state, "terminated");
    }
  };
}

function nextSandboxId(): string {
  return randomUUID().replaceAll("-", "").slice(0, 16);
}
