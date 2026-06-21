export type RuntimeEndpointFetch = (
  input: string,
  init?: RequestInit
) => Promise<Response>;

export type RuntimeEndpointWebSocketOptions = {
  headers?: HeadersInit;
};

export type RuntimeEndpointRouteOptions = {
  openShellDialHost?: string | null;
};

export function routeRuntimeEndpointFetch(
  fetchImpl: RuntimeEndpointFetch,
  options: RuntimeEndpointRouteOptions
): RuntimeEndpointFetch {
  return (input, init) => {
    const routed = routeRuntimeEndpointRequest(input, init, options);
    return fetchImpl(routed.url, routed.init);
  };
}

export function routeRuntimeEndpointWebSocket(
  url: string,
  options: RuntimeEndpointWebSocketOptions | undefined,
  routeOptions: RuntimeEndpointRouteOptions
): { url: string; options?: RuntimeEndpointWebSocketOptions } {
  if (!isOpenShellVirtualEndpoint(url)) {
    return { url, ...(options ? { options } : {}) };
  }

  throw new Error(
    "OpenShell WebSocket virtual-host routing is not supported because Bun cannot replace the Host header; use runtime snapshot polling for OpenShell endpoints"
  );
}

export function isOpenShellVirtualEndpoint(url: string): boolean {
  const target = parseUrl(url);
  return Boolean(target && isOpenShellVirtualHost(target.hostname));
}

function routeRuntimeEndpointRequest(
  url: string,
  init: RequestInit | undefined,
  options: RuntimeEndpointRouteOptions
): { url: string; init?: RequestInit } {
  const routed = routeOpenShellVirtualHost(url, options.openShellDialHost);
  if (!routed) {
    return { url, ...(init ? { init } : {}) };
  }
  return {
    url: routed.url,
    init: {
      ...init,
      headers: withHostHeader(init?.headers, routed.hostHeader)
    }
  };
}

function routeOpenShellVirtualHost(
  url: string,
  dialHost: string | null | undefined
): { url: string; hostHeader: string } | null {
  const target = parseUrl(url);
  if (!target || !isOpenShellVirtualHost(target.hostname)) {
    return null;
  }
  const dial = parseDialHost(dialHost, target.protocol, target.port);
  if (!dial) {
    throw new Error(
      "AGENT_RUNTIME_OPENSHELL_DIAL_HOST is required for OpenShell virtual-host runtime endpoints"
    );
  }

  const originalHost = target.host;
  target.protocol = dial.protocol;
  target.host = dial.host;
  return {
    url: target.toString(),
    hostHeader: originalHost
  };
}

function parseDialHost(
  value: string | null | undefined,
  fallbackProtocol: string,
  fallbackPort: string
): URL | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `${fallbackProtocol}//${trimmed}`;
  const parsed = parseUrl(withProtocol);
  if (!parsed) {
    return null;
  }
  if (!parsed.port && fallbackPort) {
    parsed.port = fallbackPort;
  }
  return parsed;
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isOpenShellVirtualHost(hostname: string): boolean {
  return hostname.toLowerCase().endsWith(".openshell.localhost");
}

function withHostHeader(
  headers: HeadersInit | undefined,
  host: string
): Headers {
  const next = new Headers(headers);
  next.set("host", host);
  return next;
}
