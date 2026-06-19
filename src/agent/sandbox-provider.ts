import type { AgentRuntimeEngine } from "../db";

export type SandboxPrincipal = {
  workspaceId: string;
  userId: string;
};

export type SandboxRuntimeRequest = {
  engine: AgentRuntimeEngine;
  image: string;
};

export type SandboxProvisionRequest = {
  principal: SandboxPrincipal;
  runtime: SandboxRuntimeRequest;
  labels?: Record<string, string>;
};

export type SandboxNetworkPolicy =
  | {
      egress: "deny";
      allowedHosts?: never;
    }
  | {
      egress: "allowlist";
      allowedHosts: string[];
    }
  | {
      egress: "open";
      allowedHosts?: never;
    };

export type SandboxPolicy = {
  network: SandboxNetworkPolicy;
  filesystem?: {
    readOnlyPaths?: string[];
    readWritePaths?: string[];
  };
  resources?: {
    cpuCount?: number;
    memoryMb?: number;
    diskMb?: number;
  };
  maxLifetimeMs?: number;
};

export type SandboxCredentialBinding = {
  name: string;
  kind: "provider-token" | "runtime-token" | "secret-ref";
  ref: string;
  delivery: "gateway_callback" | "sandbox_reference";
};

export type SandboxHandle = {
  id: string;
  provider: string;
  status: "provisioning" | "ready" | "running" | "terminated" | "failed";
  endpointUrl: string;
  workspacePath: string;
  principal: SandboxPrincipal;
  runtime: SandboxRuntimeRequest;
  labels: Record<string, string>;
  policy?: SandboxPolicy;
  credentials: SandboxCredentialBinding[];
};

export type SandboxRunRequest = {
  argv: string[];
  env?: Record<string, string>;
};

export type SandboxRunHandle = {
  id: string;
  sandboxId: string;
  status: "running" | "finished" | "failed";
  exitCode?: number;
};

export type SandboxEvent = {
  sandboxId: string;
  type:
    | "provisioned"
    | "policy_applied"
    | "credentials_bound"
    | "run_started"
    | "run_finished"
    | "terminated";
  at: string;
  detail?: Record<string, unknown>;
};

export type SandboxProviderCapabilities = {
  provider: string;
  isolation: "process" | "container" | "microvm" | "remote";
  supportsEgressAllowlist: boolean;
  supportsCredentialBinding: boolean;
  supportsDurableSandboxes: boolean;
};

export type SandboxProvider = {
  capabilities(): SandboxProviderCapabilities;
  provision(request: SandboxProvisionRequest): Promise<SandboxHandle>;
  applyPolicy(sandboxId: string, policy: SandboxPolicy): Promise<SandboxHandle>;
  bindCredentials(
    sandboxId: string,
    credentials: SandboxCredentialBinding[]
  ): Promise<SandboxHandle>;
  run(sandboxId: string, request: SandboxRunRequest): Promise<SandboxRunHandle>;
  attach(sandboxId: string): Promise<SandboxHandle>;
  streamEvents(sandboxId: string): AsyncIterable<SandboxEvent>;
  terminate(sandboxId: string): Promise<void>;
};

export function cloneSandboxHandle(handle: SandboxHandle): SandboxHandle {
  return {
    ...handle,
    labels: { ...handle.labels },
    principal: { ...handle.principal },
    runtime: { ...handle.runtime },
    ...(handle.policy ? { policy: cloneSandboxPolicy(handle.policy) } : {}),
    credentials: handle.credentials.map(cloneSandboxCredentialBinding)
  };
}

export function cloneSandboxPolicy(policy: SandboxPolicy): SandboxPolicy {
  const cloned: SandboxPolicy = {
    ...policy,
    network:
      policy.network.egress === "allowlist"
        ? {
            egress: "allowlist",
            allowedHosts: [...policy.network.allowedHosts]
          }
        : { egress: policy.network.egress }
  };
  if (policy.filesystem) {
    cloned.filesystem = {
      ...(policy.filesystem.readOnlyPaths
        ? { readOnlyPaths: [...policy.filesystem.readOnlyPaths] }
        : {}),
      ...(policy.filesystem.readWritePaths
        ? { readWritePaths: [...policy.filesystem.readWritePaths] }
        : {})
    };
  }
  if (policy.resources) {
    cloned.resources = { ...policy.resources };
  }
  return cloned;
}

export function cloneSandboxCredentialBinding(
  credential: SandboxCredentialBinding
): SandboxCredentialBinding {
  return { ...credential };
}

export function isSandboxCredentialMaterialized(
  credential: SandboxCredentialBinding
): boolean {
  return credential.delivery === "sandbox_reference";
}

export function cloneSandboxEvent(event: SandboxEvent): SandboxEvent {
  return {
    ...event,
    ...(event.detail ? { detail: cloneSandboxEventDetail(event.detail) } : {})
  };
}

export function cloneSandboxEventDetail(
  detail: Record<string, unknown>
): Record<string, unknown> {
  return structuredClone(detail);
}
