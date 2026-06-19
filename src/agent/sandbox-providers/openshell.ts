import {
  cloneSandboxCredentialBinding,
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

export type OpenShellSandboxStatus = SandboxHandle["status"];

export type OpenShellSandboxRecord = {
  sandboxId: string;
  endpoint: string;
  workspacePath: string;
  status: OpenShellSandboxStatus;
  principal: SandboxProvisionRequest["principal"];
  runtime: SandboxProvisionRequest["runtime"];
  labels: Record<string, string>;
  policy?: SandboxPolicy;
  credentials: SandboxCredentialBinding[];
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
    credentialBindings: SandboxCredentialBinding[];
    materializedCredentials: SandboxCredentialBinding[];
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
      const handle = handleFromRecord(record);
      return cloneHandle(handle);
    },

    async applyPolicy(
      sandboxId: string,
      policy: SandboxPolicy
    ): Promise<SandboxHandle> {
      await input.client.applyPolicy({ sandboxId, policy });
      const updated = handleFromRecord(
        await input.client.getSandbox({ sandboxId })
      );
      return cloneHandle(updated);
    },

    async bindCredentials(
      sandboxId: string,
      credentials: SandboxCredentialBinding[]
    ): Promise<SandboxHandle> {
      const credentialBindings = credentials.map(cloneSandboxCredentialBinding);
      await input.client.bindCredentials({
        sandboxId,
        credentialBindings,
        materializedCredentials: credentialBindings.filter(
          (credential) => credential.delivery === "sandbox_reference"
        )
      });
      const updated = handleFromRecord(
        await input.client.getSandbox({ sandboxId })
      );
      return cloneHandle(updated);
    },

    async run(
      sandboxId: string,
      request: SandboxRunRequest
    ): Promise<SandboxRunHandle> {
      const result = await input.client.run({ sandboxId, request });
      return {
        id: result.runId,
        sandboxId,
        status: result.status,
        ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode })
      };
    },

    async attach(sandboxId: string): Promise<SandboxHandle> {
      const record = await input.client.getSandbox({ sandboxId });
      const updated = handleFromRecord(record);
      return cloneHandle(updated);
    },

    streamEvents(sandboxId: string): AsyncIterable<SandboxEvent> {
      return input.client.events({ sandboxId });
    },

    async terminate(sandboxId: string): Promise<void> {
      await input.client.terminate({ sandboxId });
    }
  };
}

function handleFromRecord(record: OpenShellSandboxRecord): SandboxHandle {
  return {
    id: record.sandboxId,
    provider: "openshell",
    status: record.status,
    endpointUrl: record.endpoint,
    workspacePath: record.workspacePath,
    principal: record.principal,
    runtime: record.runtime,
    labels: record.labels,
    ...(record.policy ? { policy: clonePolicy(record.policy) } : {}),
    credentials: record.credentials.map(cloneSandboxCredentialBinding)
  };
}

function cloneHandle(handle: SandboxHandle): SandboxHandle {
  return cloneSandboxHandle(handle);
}

function clonePolicy(policy: SandboxPolicy): SandboxPolicy {
  return cloneSandboxPolicy(policy);
}
