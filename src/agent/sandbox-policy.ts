import type { SandboxPolicy } from "./sandbox-provider";
import type { Config } from "../config";

export type BrokeredRuntimeSandboxPolicyInput = {
  toolGatewayUrl: string;
  mcpGatewayUrl?: string | null;
  modelProviderUrls: string[];
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
  assertRequiredUrls("modelProviderUrls", input.modelProviderUrls);
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
  >
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
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(
      `Sandbox egress URL must be an absolute http/https/ws/wss URL: ${value}`
    );
  }
  if (
    url.protocol !== "http:" &&
    url.protocol !== "https:" &&
    url.protocol !== "ws:" &&
    url.protocol !== "wss:"
  ) {
    throw new Error(`Sandbox egress URL must use http, https, ws, or wss: ${value}`);
  }
  return [url.host.toLowerCase()];
}

function assertRequiredUrls(
  name: string,
  urls: string[] | null | undefined
): void {
  if (!urls?.some((url) => url.trim())) {
    throw new Error(`Sandbox egress ${name} must include at least one URL`);
  }
}
