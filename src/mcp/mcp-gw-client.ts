import {
  UpstreamMcpHttpError,
  UpstreamMcpJsonRpcError,
  callUpstreamMcpTool,
  listUpstreamMcpTools,
  type UpstreamMcpTool,
  type UpstreamMcpToolResult
} from "./upstream-http-client";

export type McpGwClientConfig = {
  url: string;
  bearerToken: string;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
};

export type McpGwToolCallResult =
  | {
      status: "ok";
      result: UpstreamMcpToolResult;
    }
  | {
      status: "needs_google_connect";
      message: string;
      connectUrl?: string;
    };

export class McpGwUnauthorizedError extends Error {
  readonly name = "McpGwUnauthorizedError";
  readonly status = 401;
  readonly wwwAuthenticate: string | null;
  readonly protectedResourceMetadataUrl: string | null;

  constructor(input: { wwwAuthenticate: string | null }) {
    super("MCP-GW rejected the Burble user assertion");
    this.wwwAuthenticate = input.wwwAuthenticate;
    this.protectedResourceMetadataUrl = parseProtectedResourceMetadataUrl(
      input.wwwAuthenticate
    );
  }
}

export async function listMcpGwTools(
  config: McpGwClientConfig
): Promise<UpstreamMcpTool[]> {
  try {
    return await listUpstreamMcpTools(toUpstreamConfig(config));
  } catch (error) {
    throw mapMcpGwError(error);
  }
}

export async function callMcpGwTool(
  config: McpGwClientConfig,
  input: { name: string; arguments?: Record<string, unknown> }
): Promise<McpGwToolCallResult> {
  try {
    const result = await callUpstreamMcpTool(toUpstreamConfig(config), input);
    const reauthResult = readToolResultReauth(result, config.url);
    if (reauthResult) {
      return reauthResult;
    }
    return { status: "ok", result };
  } catch (error) {
    if (error instanceof UpstreamMcpJsonRpcError && isReauthRequired(error)) {
      return {
        status: "needs_google_connect",
        message: cleanUpstreamMcpErrorMessage(error.message),
        ...readConnectUrl(error.data, config.url)
      };
    }
    throw mapMcpGwError(error);
  }
}

function toUpstreamConfig(config: McpGwClientConfig) {
  return {
    url: config.url,
    authorization: `Bearer ${config.bearerToken}`,
    ...(config.fetch ? { fetch: config.fetch } : {}),
    ...(config.requestTimeoutMs ? { requestTimeoutMs: config.requestTimeoutMs } : {}),
    clientName: "burble-mcp-gw-client",
    clientVersion: "0.1.0"
  };
}

function mapMcpGwError(error: unknown): never {
  if (error instanceof UpstreamMcpHttpError && error.status === 401) {
    throw new McpGwUnauthorizedError({
      wwwAuthenticate: error.wwwAuthenticate
    });
  }
  throw error;
}

function isReauthRequired(error: UpstreamMcpJsonRpcError): boolean {
  if (error.code === "reauth_required") {
    return true;
  }
  const data = error.data;
  return (
    Boolean(data) &&
    typeof data === "object" &&
    (data as Record<string, unknown>).code === "reauth_required"
  );
}

function readToolResultReauth(
  result: UpstreamMcpToolResult,
  mcpGwUrl: string
): McpGwToolCallResult | null {
  if (!result.isError) {
    return null;
  }
  for (const item of result.content ?? []) {
    const parsed = parseToolResultTextJson(item);
    if (parsed?.code === "reauth_required") {
      const message =
        typeof parsed.error === "string" && parsed.error.trim()
          ? parsed.error.trim()
          : "Google Workspace reauthorization required";
      return {
        status: "needs_google_connect",
        message,
        ...readConnectUrl(parsed, mcpGwUrl)
      };
    }
  }
  return null;
}

function parseToolResultTextJson(item: unknown): Record<string, unknown> | null {
  if (!item || typeof item !== "object") {
    return null;
  }
  const text = (item as Record<string, unknown>).text;
  if (typeof text !== "string" || !text.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readConnectUrl(
  data: unknown,
  mcpGwUrl: string
): { connectUrl?: string } {
  if (!data || typeof data !== "object") {
    return {};
  }
  const value = (data as Record<string, unknown>).connectUrl;
  if (typeof value !== "string" || !value.trim()) {
    return {};
  }
  const connectUrl = normalizeTrustedConnectUrl(value.trim(), mcpGwUrl);
  return connectUrl ? { connectUrl } : {};
}

function normalizeTrustedConnectUrl(
  value: string,
  mcpGwUrl: string
): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      return null;
    }
    if (url.origin === "https://accounts.google.com") {
      return url.toString();
    }
    if (mcpGwUrl) {
      const gateway = new URL(mcpGwUrl);
      if (url.origin === gateway.origin) {
        return url.toString();
      }
    }
    return null;
  } catch {
    return null;
  }
}

function cleanUpstreamMcpErrorMessage(message: string): string {
  return message.replace(/^Upstream MCP error:\s*/, "");
}

function parseProtectedResourceMetadataUrl(
  wwwAuthenticate: string | null
): string | null {
  if (!wwwAuthenticate) {
    return null;
  }
  const match = wwwAuthenticate.match(
    /\bresource_metadata=(?:"([^"]+)"|([^,\s]+))/i
  );
  return match?.[1] ?? match?.[2] ?? null;
}
