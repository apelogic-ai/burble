import { randomUUID } from "node:crypto";
import type {
  SandboxCredentialBinding,
  SandboxEvent,
  SandboxHandle,
  SandboxPolicy,
  SandboxProvider,
  SandboxProviderCapabilities,
  SandboxProvisionRequest,
  SandboxRunHandle,
  SandboxRunRequest
} from "../sandbox-provider";

export type LocalDevSandboxProvider = SandboxProvider;

type SandboxState = {
  handle: SandboxHandle;
  events: SandboxEvent[];
};

export function createLocalDevSandboxProvider(): LocalDevSandboxProvider {
  const sandboxes = new Map<string, SandboxState>();

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
      at: new Date(0).toISOString(),
      ...(detail ? { detail } : {})
    });
  };

  return {
    capabilities(): SandboxProviderCapabilities {
      return {
        provider: "local-dev",
        isolation: "container",
        supportsEgressAllowlist: true,
        supportsCredentialBinding: true,
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
      const state: SandboxState = { handle, events: [] };
      recordEvent(state, "provisioned", { image: request.runtime.image });
      sandboxes.set(id, state);
      return cloneHandle(handle);
    },

    async applyPolicy(
      sandboxId: string,
      policy: SandboxPolicy
    ): Promise<SandboxHandle> {
      const state = load(sandboxId);
      state.handle = {
        ...state.handle,
        policy: clonePolicy(policy)
      };
      recordEvent(state, "policy_applied", { egress: policy.network.egress });
      return cloneHandle(state.handle);
    },

    async bindCredentials(
      sandboxId: string,
      credentials: SandboxCredentialBinding[]
    ): Promise<SandboxHandle> {
      const state = load(sandboxId);
      state.handle = {
        ...state.handle,
        credentials: credentials.map((credential) => ({ ...credential }))
      };
      recordEvent(state, "credentials_bound", {
        names: credentials.map((credential) => credential.name)
      });
      return cloneHandle(state.handle);
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
      recordEvent(state, "run_finished", { exitCode: 0 });
      return {
        id: runId,
        sandboxId,
        status: "finished",
        exitCode: 0
      };
    },

    async attach(sandboxId: string): Promise<SandboxHandle> {
      return cloneHandle(load(sandboxId).handle);
    },

    async *streamEvents(sandboxId: string): AsyncIterable<SandboxEvent> {
      for (const event of load(sandboxId).events) {
        if (event.type !== "terminated") {
          yield { ...event, detail: cloneDetail(event.detail) };
        }
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

function cloneHandle(handle: SandboxHandle): SandboxHandle {
  return {
    ...handle,
    labels: { ...handle.labels },
    principal: { ...handle.principal },
    runtime: { ...handle.runtime },
    ...(handle.policy ? { policy: clonePolicy(handle.policy) } : {}),
    credentials: handle.credentials.map((credential) => ({ ...credential }))
  };
}

function clonePolicy(policy: SandboxPolicy): SandboxPolicy {
  if (policy.network.egress === "allowlist") {
    return {
      ...policy,
      network: {
        egress: "allowlist",
        allowedHosts: [...policy.network.allowedHosts]
      }
    };
  }
  return {
    ...policy,
    network: { egress: policy.network.egress }
  };
}

function cloneDetail(
  detail: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  return detail ? { ...detail } : undefined;
}
