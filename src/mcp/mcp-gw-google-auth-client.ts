export type McpGwGoogleAuthClientConfig = {
  mcpUrl: string;
  bearerToken: string;
  fetch?: McpGwGoogleAuthFetch;
  requestTimeoutMs?: number;
};

export type McpGwGoogleAuthFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type McpGwGoogleAuthStatus = {
  connected: boolean;
  email?: string;
  scopesRequired: string[];
  scopesGranted: string[];
  missingScopes: string[];
};

export class McpGwGoogleAuthError extends Error {
  readonly name = "McpGwGoogleAuthError";

  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const defaultRequestTimeoutMs = 10_000;

export async function startMcpGwGoogleAuth(
  config: McpGwGoogleAuthClientConfig,
  input: { redirectAfter?: string } = {},
): Promise<{ authorizationUrl: string }> {
  const body = input.redirectAfter
    ? { redirectAfter: input.redirectAfter }
    : {};
  const response = await requestMcpGwGoogleAuth(
    config,
    "start",
    "POST",
    body,
  );
  const parsed = await readJsonObject(response, "start");
  const authorizationUrl = parsed.authorizationUrl;
  if (
    typeof authorizationUrl !== "string" ||
    !isSecureGoogleAuthorizationUrl(authorizationUrl)
  ) {
    throw new McpGwGoogleAuthError(
      "MCP-GW did not return a secure Google authorization URL",
    );
  }
  return { authorizationUrl };
}

export async function getMcpGwGoogleAuthStatus(
  config: McpGwGoogleAuthClientConfig,
): Promise<McpGwGoogleAuthStatus> {
  const response = await requestMcpGwGoogleAuth(config, "status", "GET");
  const parsed = await readJsonObject(response, "status");
  if (typeof parsed.connected !== "boolean") {
    throw new McpGwGoogleAuthError(
      "MCP-GW returned an invalid Google auth status response",
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

export async function disconnectMcpGwGoogleAuth(
  config: McpGwGoogleAuthClientConfig,
): Promise<void> {
  await requestMcpGwGoogleAuth(config, "disconnect", "POST", {});
}

async function requestMcpGwGoogleAuth(
  config: McpGwGoogleAuthClientConfig,
  operation: "start" | "status" | "disconnect",
  method: "GET" | "POST",
  body?: Record<string, unknown>,
): Promise<Response> {
  const timeoutMs = config.requestTimeoutMs ?? defaultRequestTimeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );

  let response: Response;
  try {
    response = await (config.fetch ?? fetch)(
      googleAuthEndpoint(config.mcpUrl, operation),
      {
        method,
        headers: {
          authorization: `Bearer ${config.bearerToken}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      },
    );
  } catch (error) {
    if (controller.signal.aborted) {
      throw new McpGwGoogleAuthError(
        `MCP-GW Google auth ${operation} request timed out after ${timeoutMs}ms`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    response.body?.cancel().catch(() => undefined);
    throw new McpGwGoogleAuthError(
      `MCP-GW Google auth ${operation} request failed with HTTP ${response.status}`,
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
  throw new McpGwGoogleAuthError(
    `MCP-GW returned an invalid Google auth ${operation} response`,
  );
}

function googleAuthEndpoint(
  mcpUrl: string,
  operation: "start" | "status" | "disconnect",
): string {
  const url = new URL(mcpUrl);
  url.pathname = `/oauth/google/${operation}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function isSecureGoogleAuthorizationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "accounts.google.com";
  } catch {
    return false;
  }
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
