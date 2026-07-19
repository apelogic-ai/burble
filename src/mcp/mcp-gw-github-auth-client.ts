export type McpGwGitHubAuthClientConfig = {
  mcpUrl: string;
  bearerToken: string;
  fetch?: McpGwGitHubAuthFetch;
  requestTimeoutMs?: number;
};

export type McpGwGitHubAuthFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type McpGwGitHubAuthStatus = {
  connected: boolean;
  email?: string;
  scopesRequired: string[];
  scopesGranted: string[];
  missingScopes: string[];
};

export class McpGwGitHubAuthError extends Error {
  readonly name = "McpGwGitHubAuthError";

  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const defaultRequestTimeoutMs = 10_000;

export async function startMcpGwGitHubAuth(
  config: McpGwGitHubAuthClientConfig,
  input: { redirectAfter?: string } = {},
): Promise<{ authorizationUrl: string }> {
  const url = githubAuthEndpoint(config.mcpUrl, "start");
  if (input.redirectAfter) {
    url.searchParams.set("redirect_after", input.redirectAfter);
  }
  const response = await requestMcpGwGitHubAuth(config, url, "start", "GET", {
    redirect: "manual",
  });
  const authorizationUrl = response.headers.get("location")?.trim();
  response.body?.cancel().catch(() => undefined);
  if (!authorizationUrl || !isSecureGitHubAuthorizationUrl(authorizationUrl)) {
    throw new McpGwGitHubAuthError(
      "MCP-GW did not return a secure GitHub authorization URL",
    );
  }
  return { authorizationUrl };
}

export async function getMcpGwGitHubAuthStatus(
  config: McpGwGitHubAuthClientConfig,
): Promise<McpGwGitHubAuthStatus> {
  const response = await requestMcpGwGitHubAuth(
    config,
    githubAuthEndpoint(config.mcpUrl, "status"),
    "status",
    "GET",
  );
  const parsed = await readJsonObject(response, "status");
  if (typeof parsed.connected !== "boolean") {
    throw new McpGwGitHubAuthError(
      "MCP-GW returned an invalid GitHub auth status response",
    );
  }
  return {
    connected: parsed.connected,
    ...(typeof parsed.email === "string" && parsed.email.trim()
      ? { email: parsed.email.trim() }
      : {}),
    scopesRequired: readStringArray(parsed.scopesRequired),
    scopesGranted: readStringArray(parsed.scopesGranted),
    missingScopes: readStringArray(parsed.missingScopes),
  };
}

export async function disconnectMcpGwGitHubAuth(
  config: McpGwGitHubAuthClientConfig,
): Promise<void> {
  const response = await requestMcpGwGitHubAuth(
    config,
    githubAuthEndpoint(config.mcpUrl, "disconnect"),
    "disconnect",
    "POST",
  );
  response.body?.cancel().catch(() => undefined);
}

async function requestMcpGwGitHubAuth(
  config: McpGwGitHubAuthClientConfig,
  url: URL,
  operation: "start" | "status" | "disconnect",
  method: "GET" | "POST",
  overrides: Pick<RequestInit, "redirect"> = {},
): Promise<Response> {
  const timeoutMs = config.requestTimeoutMs ?? defaultRequestTimeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );

  let response: Response;
  try {
    response = await (config.fetch ?? fetch)(url, {
      method,
      headers: { authorization: `Bearer ${config.bearerToken}` },
      signal: controller.signal,
      ...overrides,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new McpGwGitHubAuthError(
        `MCP-GW GitHub auth ${operation} request timed out after ${timeoutMs}ms`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok && !(operation === "start" && response.status === 302)) {
    response.body?.cancel().catch(() => undefined);
    throw new McpGwGitHubAuthError(
      `MCP-GW GitHub auth ${operation} request failed with HTTP ${response.status}`,
      response.status,
    );
  }
  return response;
}

async function readJsonObject(
  response: Response,
  operation: string,
): Promise<Record<string, unknown>> {
  try {
    const parsed = (await response.json()) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Report the contract failure without echoing an upstream response body.
  }
  throw new McpGwGitHubAuthError(
    `MCP-GW returned an invalid GitHub auth ${operation} response`,
  );
}

function githubAuthEndpoint(
  mcpUrl: string,
  operation: "start" | "status" | "disconnect",
): URL {
  const url = new URL(mcpUrl);
  url.pathname = `/oauth/github/${operation}`;
  url.search = "";
  url.hash = "";
  return url;
}

function isSecureGitHubAuthorizationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      url.pathname === "/login/oauth/authorize"
    );
  } catch {
    return false;
  }
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
