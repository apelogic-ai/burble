import type {
  SandboxCredentialBinding,
  SandboxPolicy
} from "../sandbox-provider";

export type OpenShellSandboxPolicyConfig = {
  version: 1;
  egress: {
    default: "allow" | "deny";
    allowHosts: string[];
  };
  filesystem: {
    readOnly: string[];
    readWrite: string[];
  };
  resources: {
    cpuCount?: number;
    memoryMb?: number;
    diskMb?: number;
    maxLifetimeMs?: number;
  };
  providers: OpenShellProviderBindingConfig[];
};

export type OpenShellProviderBindingConfig = {
  name: string;
  ref: string;
  kind: SandboxCredentialBinding["kind"];
  delivery: SandboxCredentialBinding["delivery"];
  materialized: boolean;
};

export function compileOpenShellSandboxPolicy(input: {
  policy: SandboxPolicy;
  credentials?: SandboxCredentialBinding[];
}): OpenShellSandboxPolicyConfig {
  return {
    version: 1,
    egress: compileEgress(input.policy),
    filesystem: {
      readOnly: normalizePaths(input.policy.filesystem?.readOnlyPaths ?? []),
      readWrite: normalizePaths(input.policy.filesystem?.readWritePaths ?? [])
    },
    resources: compileResources(input.policy),
    providers: (input.credentials ?? []).map((credential) => ({
      name: credential.name,
      ref: credential.ref,
      kind: credential.kind,
      delivery: credential.delivery,
      materialized: credential.delivery === "sandbox_reference"
    }))
  };
}

function compileEgress(
  policy: SandboxPolicy
): OpenShellSandboxPolicyConfig["egress"] {
  if (policy.network.egress === "open") {
    return { default: "allow", allowHosts: [] };
  }
  if (policy.network.egress === "deny") {
    return { default: "deny", allowHosts: [] };
  }
  return {
    default: "deny",
    allowHosts: normalizeHosts(policy.network.allowedHosts)
  };
}

function compileResources(
  policy: SandboxPolicy
): OpenShellSandboxPolicyConfig["resources"] {
  return {
    ...positiveIntegerField("cpuCount", policy.resources?.cpuCount),
    ...positiveIntegerField("memoryMb", policy.resources?.memoryMb),
    ...positiveIntegerField("diskMb", policy.resources?.diskMb),
    ...positiveIntegerField("maxLifetimeMs", policy.maxLifetimeMs)
  };
}

function normalizeHosts(hosts: string[]): string[] {
  return uniqueSorted(
    hosts.map((host) => {
      const normalized = host.trim().toLowerCase();
      if (!normalized) {
        throw new Error("Sandbox egress allowedHosts cannot include blank hosts");
      }
      return normalized;
    })
  );
}

function normalizePaths(paths: string[]): string[] {
  return uniqueSorted(
    paths.map((path) => {
      const normalized = path.trim();
      if (!normalized.startsWith("/")) {
        throw new Error(`Sandbox filesystem path must be absolute: ${path}`);
      }
      return normalized;
    })
  );
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function positiveIntegerField<T extends string>(
  key: T,
  value: number | undefined
): Partial<Record<T, number>> {
  if (value === undefined) {
    return {};
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Sandbox resource ${key} must be a positive integer`);
  }
  return { [key]: value } as Partial<Record<T, number>>;
}
