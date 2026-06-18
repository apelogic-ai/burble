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

export type OpenShellSandboxStatus =
  | "provisioning"
  | "ready"
  | "running"
  | "terminated"
  | "failed";

export type OpenShellSandboxRecord = {
  sandboxId: string;
  endpoint: string;
  workspacePath: string;
  status: OpenShellSandboxStatus;
};

export type OpenShellSandboxClient = {
  createSandbox(input: {
    principal: SandboxProvisionRequest["principal"];
    runtime: SandboxProvisionRequest["runtime"];
    labels: Record<string, string>;
  }): Promise<OpenShellSandboxRecord>;
  applyPolicy(input: {
    sandboxId: string;
    policy: SandboxPolicy;
  }): Promise<void>;
  bindCredentials(input: {
    sandboxId: string;
    credentials: SandboxCredentialBinding[];
  }): Promise<void>;
  run(input: {
    sandboxId: string;
    request: SandboxRunRequest;
  }): Promise<{
    runId: string;
    status: SandboxRunHandle["status"];
    exitCode?: number;
  }>;
  getSandbox(input: { sandboxId: string }): Promise<OpenShellSandboxRecord>;
  events(input: { sandboxId: string }): AsyncIterable<SandboxEvent>;
  terminate(input: { sandboxId: string }): Promise<void>;
};

export function createOpenShellSandboxProvider(input: {
  client: OpenShellSandboxClient;
}): SandboxProvider {
  const cache = new Map<string, SandboxHandle>();

  return {
    capabilities(): SandboxProviderCapabilities {
      return {
        provider: "openshell",
        isolation: "microvm",
        supportsEgressAllowlist: true,
        supportsCredentialBinding: true,
        supportsDurableSandboxes: true
      };
    },

    async provision(request: SandboxProvisionRequest): Promise<SandboxHandle> {
      const record = await input.client.createSandbox({
        principal: request.principal,
        runtime: request.runtime,
        labels: request.labels ?? {}
      });
      const handle: SandboxHandle = {
        id: record.sandboxId,
        provider: "openshell",
        status: record.status,
        endpointUrl: record.endpoint,
        workspacePath: record.workspacePath,
        principal: request.principal,
        runtime: request.runtime,
        labels: request.labels ?? {},
        credentials: []
      };
      cache.set(handle.id, cloneHandle(handle));
      return cloneHandle(handle);
    },

    async applyPolicy(
      sandboxId: string,
      policy: SandboxPolicy
    ): Promise<SandboxHandle> {
      await input.client.applyPolicy({ sandboxId, policy });
      const handle = requireCachedHandle(cache, sandboxId);
      const updated = {
        ...handle,
        policy: clonePolicy(policy)
      };
      cache.set(sandboxId, cloneHandle(updated));
      return cloneHandle(updated);
    },

    async bindCredentials(
      sandboxId: string,
      credentials: SandboxCredentialBinding[]
    ): Promise<SandboxHandle> {
      await input.client.bindCredentials({ sandboxId, credentials });
      const handle = requireCachedHandle(cache, sandboxId);
      const updated = {
        ...handle,
        credentials: credentials.map((credential) => ({ ...credential }))
      };
      cache.set(sandboxId, cloneHandle(updated));
      return cloneHandle(updated);
    },

    async run(
      sandboxId: string,
      request: SandboxRunRequest
    ): Promise<SandboxRunHandle> {
      const result = await input.client.run({ sandboxId, request });
      const handle = requireCachedHandle(cache, sandboxId);
      cache.set(sandboxId, cloneHandle({ ...handle, status: "running" }));
      return {
        id: result.runId,
        sandboxId,
        status: result.status,
        ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode })
      };
    },

    async attach(sandboxId: string): Promise<SandboxHandle> {
      const record = await input.client.getSandbox({ sandboxId });
      const handle = requireCachedHandle(cache, sandboxId);
      const updated = {
        ...handle,
        status: record.status,
        endpointUrl: record.endpoint,
        workspacePath: record.workspacePath
      };
      cache.set(sandboxId, cloneHandle(updated));
      return cloneHandle(updated);
    },

    streamEvents(sandboxId: string): AsyncIterable<SandboxEvent> {
      return input.client.events({ sandboxId });
    },

    async terminate(sandboxId: string): Promise<void> {
      await input.client.terminate({ sandboxId });
      const handle = requireCachedHandle(cache, sandboxId);
      cache.set(sandboxId, cloneHandle({ ...handle, status: "terminated" }));
    }
  };
}

function requireCachedHandle(
  cache: Map<string, SandboxHandle>,
  sandboxId: string
): SandboxHandle {
  const handle = cache.get(sandboxId);
  if (!handle) {
    throw new Error(`Sandbox ${sandboxId} has not been provisioned`);
  }
  return cloneHandle(handle);
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
