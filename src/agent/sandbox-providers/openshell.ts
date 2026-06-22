import {
  cloneSandboxCredentialBinding,
  cloneSandboxHandle,
  cloneSandboxPolicy,
  isSandboxCredentialMaterialized,
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
import {
  compileOpenShellProviderBindings,
  compileOpenShellSandboxPolicy,
  type OpenShellProviderBindingConfig,
  type OpenShellSandboxPolicyConfig
} from "./openshell-policy";

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
    policy?: SandboxPolicy;
    compiledPolicy?: OpenShellSandboxPolicyConfig;
  }): Promise<OpenShellSandboxRecord>;
  applyPolicy(input: {
    sandboxId: string;
    policy: SandboxPolicy;
    compiledPolicy: OpenShellSandboxPolicyConfig;
  }): Promise<void>;
  bindCredentials(input: {
    sandboxId: string;
    credentialBindings: SandboxCredentialBinding[];
    materializedCredentials: SandboxCredentialBinding[];
    compiledProviders: OpenShellProviderBindingConfig[];
  }): Promise<void>;
  run(input: {
    sandboxId: string;
    request: SandboxRunRequest;
  }): Promise<{
    runId: string;
    status: SandboxRunHandle["status"];
    exitCode?: number;
    output?: string;
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
        labels: request.labels ?? {},
        // Policy is applied at creation (parity with the gRPC transport, which
        // compiles into the CreateSandbox spec). Send the compiled form so the
        // sandbox is born with its egress/filesystem policy instead of relying
        // on a follow-up applyPolicy call that fresh provisioning no longer makes.
        ...(request.policy
          ? {
              policy: request.policy,
              compiledPolicy: compileOpenShellSandboxPolicy({
                policy: request.policy
              })
            }
          : {})
      });
      const handle = handleFromRecord(record);
      return cloneHandle(handle);
    },

    async applyPolicy(
      sandboxId: string,
      policy: SandboxPolicy
    ): Promise<SandboxHandle> {
      await input.client.applyPolicy({
        sandboxId,
        policy,
        compiledPolicy: compileOpenShellSandboxPolicy({ policy })
      });
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
          isSandboxCredentialMaterialized
        ),
        compiledProviders: compileOpenShellProviderBindings(credentialBindings)
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
        ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
        ...(result.output === undefined ? {} : { output: result.output })
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
    principal: { ...record.principal },
    runtime: { ...record.runtime },
    labels: { ...record.labels },
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
