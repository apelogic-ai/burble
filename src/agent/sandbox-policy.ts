import type { SandboxEgressEndpoint, SandboxPolicy } from "./sandbox-provider";
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
  const endpoints = sandboxEgressEndpointsFromUrls([
    input.toolGatewayUrl,
    input.mcpGatewayUrl,
    ...(input.modelProviderUrls ?? []),
    ...(input.extraAllowedUrls ?? [])
  ]);
  return {
    network: {
      egress: "allowlist",
      allowedHosts: endpoints.map((endpoint) => endpoint.host),
      allowedEndpoints: endpoints
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
  return sandboxEgressEndpointsFromUrls(urls).map((endpoint) => endpoint.host);
}

export function sandboxEgressEndpointsFromUrls(
  urls: Array<string | null | undefined>
): SandboxEgressEndpoint[] {
  // A host is treated as TLS when any of its URLs uses a TLS scheme; mixing
  // plaintext and TLS on one host:port does not happen in practice, but if it
  // did the TLS (stricter, working) treatment wins.
  const tlsByHost = new Map<string, boolean>();
  for (const value of urls) {
    for (const endpoint of sandboxEndpointFromUrl(value)) {
      tlsByHost.set(
        endpoint.host,
        (tlsByHost.get(endpoint.host) ?? false) || endpoint.tls
      );
    }
  }
  return [...tlsByHost.entries()]
    .map(([host, tls]) => ({ host, tls }))
    .sort((left, right) => left.host.localeCompare(right.host));
}

function sandboxEndpointFromUrl(
  value: string | null | undefined
): SandboxEgressEndpoint[] {
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
  return [
    {
      host: url.host.toLowerCase(),
      tls: url.protocol === "https:" || url.protocol === "wss:"
    }
  ];
}

function assertRequiredUrls(
  name: string,
  urls: string[] | null | undefined
): void {
  if (!urls?.some((url) => url.trim())) {
    throw new Error(`Sandbox egress ${name} must include at least one URL`);
  }
}
