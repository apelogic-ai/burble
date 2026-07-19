export type UpstreamMcpClientConfig = {
  url: string;
  authorization: string;
  fetch?: typeof fetch;
  clientName?: string;
  clientVersion?: string;
  requestTimeoutMs?: number;
};

export type UpstreamMcpTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
};

export type UpstreamMcpToolResult = {
  content?: unknown[];
  isError?: boolean;
};

type JsonRpcResponse = {
  id?: unknown;
  result?: unknown;
  error?: {
    code?: number | string;
    message?: string;
    data?: unknown;
  };
};

type UpstreamSession = {
  sessionId: string | null;
};

const defaultUpstreamMcpRequestTimeoutMs = 30_000;

export class UpstreamMcpHttpError extends Error {
  readonly name = "UpstreamMcpHttpError";
  readonly status: number;
  readonly detail: string;
  readonly wwwAuthenticate: string | null;

  constructor(input: {
    status: number;
    detail: string;
    wwwAuthenticate: string | null;
  }) {
    super(`Upstream MCP returned HTTP ${input.status}${input.detail}`);
    this.status = input.status;
    this.detail = input.detail;
    this.wwwAuthenticate = input.wwwAuthenticate;
  }
}

export class UpstreamMcpJsonRpcError extends Error {
  readonly name = "UpstreamMcpJsonRpcError";
  readonly code: number | string | undefined;
  readonly data: unknown;

  constructor(input: {
    code?: number | string;
    message?: string;
    data?: unknown;
  }) {
    super(`Upstream MCP error: ${input.message ?? "unknown error"}`);
    this.code = input.code;
    this.data = input.data;
  }
}

export async function listUpstreamMcpTools(
  config: UpstreamMcpClientConfig
): Promise<UpstreamMcpTool[]> {
  return withUpstreamSession(config, async (session) => {
    const id = crypto.randomUUID();
    const payload = await sendUpstreamMcpRequest(config, session, {
      jsonrpc: "2.0",
      id,
      method: "tools/list"
    }, id);
    const result = payload.result;
    if (!isRecord(result) || !Array.isArray(result.tools)) {
      throw new Error("Upstream MCP tools/list returned malformed result");
    }

    return result.tools.flatMap((tool) => {
      if (!isRecord(tool) || typeof tool.name !== "string") {
        return [];
      }

      return [
        {
          name: tool.name,
          ...(typeof tool.title === "string" ? { title: tool.title } : {}),
          ...(typeof tool.description === "string"
            ? { description: tool.description }
            : {}),
          ...("inputSchema" in tool ? { inputSchema: tool.inputSchema } : {})
        }
      ];
    });
  });
}

export async function callUpstreamMcpTool(
  config: UpstreamMcpClientConfig,
  input: { name: string; arguments?: Record<string, unknown> }
): Promise<UpstreamMcpToolResult> {
  return withUpstreamSession(config, async (session) => {
    const id = crypto.randomUUID();
    const payload = await sendUpstreamMcpRequest(config, session, {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: input.name,
        arguments: input.arguments ?? {}
      }
    }, id);
    const result = payload.result;
    if (!isRecord(result)) {
      throw new Error("Upstream MCP tools/call returned malformed result");
    }

    return {
      ...(Array.isArray(result.content) ? { content: result.content } : {}),
      ...(typeof result.isError === "boolean" ? { isError: result.isError } : {})
    };
  });
}

async function withUpstreamSession<T>(
  config: UpstreamMcpClientConfig,
  callback: (session: UpstreamSession) => Promise<T>
): Promise<T> {
  const session = await initializeUpstreamMcpSession(config);
  await sendUpstreamMcpNotification(config, session, {
    jsonrpc: "2.0",
    method: "notifications/initialized"
  });
  return callback(session);
}

async function initializeUpstreamMcpSession(
  config: UpstreamMcpClientConfig
): Promise<UpstreamSession> {
  const id = crypto.randomUUID();
  const response = await sendRawUpstreamMcpRequest(config, null, {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: {
        name: config.clientName ?? "burble-mcp-upstream-client",
        version: config.clientVersion ?? "0.1.0"
      }
    }
  });

  const payload = await readJsonRpcResponse(response, id, requestTimeoutMs(config));
  throwIfJsonRpcError(payload);

  return {
    sessionId: response.headers.get("mcp-session-id")?.trim() || null
  };
}

async function sendUpstreamMcpRequest(
  config: UpstreamMcpClientConfig,
  session: UpstreamSession,
  body: Record<string, unknown>,
  expectedId: string
): Promise<JsonRpcResponse> {
  const response = await sendRawUpstreamMcpRequest(config, session.sessionId, body);
  const payload = await readJsonRpcResponse(
    response,
    expectedId,
    requestTimeoutMs(config)
  );
  throwIfJsonRpcError(payload);
  return payload;
}

async function sendUpstreamMcpNotification(
  config: UpstreamMcpClientConfig,
  session: UpstreamSession,
  body: Record<string, unknown>
): Promise<void> {
  const response = await sendRawUpstreamMcpRequest(config, session.sessionId, body);
  if (!response.ok) {
    throw new Error(
      `Upstream MCP notification returned HTTP ${response.status}${await readErrorDetail(response, requestTimeoutMs(config))}`
    );
  }
}

async function sendRawUpstreamMcpRequest(
  config: UpstreamMcpClientConfig,
  sessionId: string | null,
  body: Record<string, unknown>
): Promise<Response> {
  const headers = new Headers({
    accept: "application/json, text/event-stream",
    authorization: config.authorization,
    "content-type": "application/json",
    "mcp-protocol-version": "2025-06-18"
  });
  if (sessionId) {
    headers.set("mcp-session-id", sessionId);
  }

  const response = await fetchWithTimeout(config, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new UpstreamMcpHttpError({
      status: response.status,
      detail: await readErrorDetail(response, requestTimeoutMs(config)),
      wwwAuthenticate: response.headers.get("www-authenticate")
    });
  }

  return response;
}

async function fetchWithTimeout(
  config: UpstreamMcpClientConfig,
  init: RequestInit
): Promise<Response> {
  const timeoutMs = requestTimeoutMs(config);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await (config.fetch ?? fetch)(config.url, {
      ...init,
      signal: controller.signal
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Upstream MCP request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readJsonRpcResponse(
  response: Response,
  expectedId: unknown,
  timeoutMs: number
): Promise<JsonRpcResponse> {
  const text = await readResponseTextWithTimeout(response, timeoutMs);
  if (!text.trim()) {
    return {};
  }

  const rawResponses = response.headers
    .get("content-type")
    ?.toLowerCase()
    .includes("text/event-stream")
    ? readSseJsonRpcResponses(text)
    : [text];

  for (const raw of rawResponses) {
    try {
      const parsed = JSON.parse(raw);
      if (!isRecord(parsed)) {
        continue;
      }
      if (parsed.id === expectedId) {
        return parsed;
      }
    } catch {
      throw new Error("Upstream MCP returned invalid JSON");
    }
  }

  throw new Error("Upstream MCP returned no matching JSON-RPC response");
}

function readSseJsonRpcResponses(text: string): string[] {
  const responses: string[] = [];
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n")
      .trim();
    if (data) {
      responses.push(data);
    }
  }

  if (!responses.length) {
    throw new Error("Upstream MCP returned no SSE data");
  }
  return responses;
}

function throwIfJsonRpcError(payload: JsonRpcResponse): void {
  if (payload.error) {
    throw new UpstreamMcpJsonRpcError(payload.error);
  }
}

async function readErrorDetail(
  response: Response,
  timeoutMs: number
): Promise<string> {
  const text = (await readResponseTextWithTimeout(response, timeoutMs))
    .trim()
    .replace(/\s+/g, " ");
  return text ? `: ${text.slice(0, 300)}` : "";
}

function requestTimeoutMs(config: UpstreamMcpClientConfig): number {
  return typeof config.requestTimeoutMs === "number" && config.requestTimeoutMs > 0
    ? config.requestTimeoutMs
    : defaultUpstreamMcpRequestTimeoutMs;
}

async function readResponseTextWithTimeout(
  response: Response,
  timeoutMs: number
): Promise<string> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      response.text(),
      new Promise<string>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Upstream MCP response timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
