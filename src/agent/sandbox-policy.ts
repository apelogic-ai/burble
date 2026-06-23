import type { SandboxEgressEndpoint, SandboxPolicy } from "./sandbox-provider";
import type { Config } from "../config";

export const dockerInternalAllowedIps = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16"
];

export const openShellHostAllowedIps = [
  "10.200.0.1/32",
  "172.17.0.1/32",
  "172.18.0.1/32",
  "172.19.0.1/32"
];

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
  const endpointsByHost = new Map<
    string,
    { tls: boolean; allowedIps: Set<string> }
  >();
  for (const value of urls) {
    for (const endpoint of sandboxEndpointFromUrl(value)) {
      const existing = endpointsByHost.get(endpoint.host) ?? {
        tls: false,
        allowedIps: new Set<string>()
      };
      existing.tls = existing.tls || endpoint.tls;
      for (const ip of endpoint.allowedIps ?? []) {
        existing.allowedIps.add(ip);
      }
      endpointsByHost.set(endpoint.host, existing);
    }
  }
  return [...endpointsByHost.entries()]
    .map(([host, endpoint]) => ({
      host,
      tls: endpoint.tls,
      ...(endpoint.allowedIps.size
        ? { allowedIps: [...endpoint.allowedIps].sort() }
        : {})
    }))
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
  const allowedIps = sandboxAllowedIpsForHostname(url.hostname);
  return [
    {
      host: url.host.toLowerCase(),
      tls: url.protocol === "https:" || url.protocol === "wss:",
      ...(allowedIps.length ? { allowedIps } : {})
    }
  ];
}

function sandboxAllowedIpsForHostname(hostname: string): string[] {
  const normalized = hostname.trim().toLowerCase();
  if (normalized === "host.openshell.internal") {
    return openShellHostAllowedIps;
  }
  return isInternalSandboxHostname(normalized) ? dockerInternalAllowedIps : [];
}

function isInternalSandboxHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized.endsWith(".internal") ||
    (!normalized.includes(".") && normalized !== "localhost")
  );
}

function assertRequiredUrls(
  name: string,
  urls: string[] | null | undefined
): void {
  if (!urls?.some((url) => url.trim())) {
    throw new Error(`Sandbox egress ${name} must include at least one URL`);
  }
}
