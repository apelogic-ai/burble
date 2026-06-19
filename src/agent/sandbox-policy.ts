import type { SandboxPolicy } from "./sandbox-provider";
import type { Config } from "../config";

export type BrokeredRuntimeSandboxPolicyInput = {
  toolGatewayUrl: string;
  mcpGatewayUrl?: string | null;
  modelProviderUrls?: string[];
  extraAllowedUrls?: string[];
  filesystem?: SandboxPolicy["filesystem"];
  resources?: SandboxPolicy["resources"];
  maxLifetimeMs?: number;
};

export type RuntimeSandboxPolicyConfig = Pick<
  Config,
  "agentRuntimeToolGatewayUrl" | "agentRuntimeMcpGatewayUrl"
>;

export function buildBrokeredRuntimeSandboxPolicy(
  input: BrokeredRuntimeSandboxPolicyInput
): SandboxPolicy {
  return {
    network: {
      egress: "allowlist",
      allowedHosts: sandboxAllowedHostsFromUrls([
        input.toolGatewayUrl,
        input.mcpGatewayUrl,
        ...(input.modelProviderUrls ?? []),
        ...(input.extraAllowedUrls ?? [])
      ])
    },
    ...(input.filesystem ? { filesystem: input.filesystem } : {}),
    ...(input.resources ? { resources: input.resources } : {}),
    ...(input.maxLifetimeMs ? { maxLifetimeMs: input.maxLifetimeMs } : {})
  };
}

export function buildRuntimeSandboxPolicyFromConfig(
  config: RuntimeSandboxPolicyConfig,
  options: Omit<
    BrokeredRuntimeSandboxPolicyInput,
    "toolGatewayUrl" | "mcpGatewayUrl"
  > = {}
): SandboxPolicy {
  return buildBrokeredRuntimeSandboxPolicy({
    ...options,
    toolGatewayUrl: config.agentRuntimeToolGatewayUrl,
    mcpGatewayUrl: config.agentRuntimeMcpGatewayUrl
  });
}

export function sandboxAllowedHostsFromUrls(
  urls: Array<string | null | undefined>
): string[] {
  return [...new Set(urls.flatMap(sandboxHostFromUrl))].sort();
}

function sandboxHostFromUrl(value: string | null | undefined): string[] {
  const trimmed = value?.trim();
  if (!trimmed) {
    return [];
  }
  const url = new URL(trimmed);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Sandbox egress URL must use http or https: ${value}`);
  }
  return [url.host.toLowerCase()];
}
