import type { RuntimeConfig } from "./config";
import { info } from "./logger";
import type { ToolExecutor, ToolResult } from "./types";

export function createBurbleToolExecutor(
  config: RuntimeConfig,
  runtimeId?: string
): ToolExecutor {
  if (config.mcpGatewayUrl && config.runtimeJwt) {
    return createBurbleMcpToolExecutor(config);
  }

  return async (toolName, body) => {
    info(`Burble HTTP tool start tool=${toolName}`);
    const headers = new Headers({
      "content-type": "application/json",
      authorization: `Bearer ${config.internalToken}`
    });
    if (runtimeId) {
      headers.set("x-burble-runtime-id", runtimeId);
    }

    const response = await fetch(
      `${config.toolGatewayUrl}/${encodeURIComponent(toolName)}/execute`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body)
      }
    );

    if (!response.ok) {
      throw new Error(`Burble tool gateway returned HTTP ${response.status}`);
    }

    const result = (await response.json()) as ToolResult;
    info(
      `Burble HTTP tool finish tool=${toolName} classification=${result.classification}`
    );
    return result;
  };
}

function createBurbleMcpToolExecutor(config: RuntimeConfig): ToolExecutor {
  let sessionIdPromise: Promise<string> | null = null;
  return async (toolName, body) => {
    const mcpToolName = toMcpToolName(toolName);
    const args = toMcpToolArguments(toolName, body);
    sessionIdPromise ??= initializeMcpSession(config);
    const sessionId = await sessionIdPromise;
    info(`Burble MCP tool start tool=${mcpToolName}`);

    const response = await fetch(config.mcpGatewayUrl!, {
      method: "POST",
      headers: {
        ...mcpHeaders(config),
        "mcp-session-id": sessionId
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "tools/call",
        params: {
          name: mcpToolName,
          arguments: args
        }
      })
    });

    if (!response.ok) {
      throw new Error(
        `Burble MCP gateway returned HTTP ${response.status}${await readErrorDetail(response)}`
      );
    }

    const result = await readMcpToolResult(response);
    info(
      `Burble MCP tool finish tool=${mcpToolName} classification=${result.classification}`
    );
    return result;
  };
}

async function initializeMcpSession(config: RuntimeConfig): Promise<string> {
  info("Burble MCP session initialize start");
  const response = await fetch(config.mcpGatewayUrl!, {
    method: "POST",
    headers: mcpHeaders(config),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: {
          name: "burble-openclaw-nemoclaw-runtime",
          version: "0.1.0"
        }
      }
    })
  });

  if (!response.ok) {
    throw new Error(
      `Burble MCP initialize returned HTTP ${response.status}${await readErrorDetail(response)}`
    );
  }

  const sessionId = response.headers.get("mcp-session-id")?.trim();
  if (!sessionId) {
    throw new Error("Burble MCP initialize did not return mcp-session-id");
  }

  await sendMcpInitializedNotification(config, sessionId);
  info("Burble MCP session initialize finish");
  return sessionId;
}

async function sendMcpInitializedNotification(
  config: RuntimeConfig,
  sessionId: string
): Promise<void> {
  const response = await fetch(config.mcpGatewayUrl!, {
    method: "POST",
    headers: {
      ...mcpHeaders(config),
      "mcp-session-id": sessionId
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized"
    })
  });

  if (!response.ok) {
    throw new Error(
      `Burble MCP initialized notification returned HTTP ${response.status}${await readErrorDetail(response)}`
    );
  }
}

function mcpHeaders(config: RuntimeConfig): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-06-18",
    authorization: `Bearer ${config.runtimeJwt}`
  };
}

function toMcpToolName(toolName: string): string {
  switch (toolName) {
    case "github.getAuthenticatedUser":
      return "github_get_authenticated_user";
    case "github.listAssignedIssues":
      return "github_list_assigned_issues";
    case "github.searchIssues":
      return "github_search_issues";
    case "github.listMyPullRequests":
      return "github_list_my_pull_requests";
    case "jira.getAuthenticatedUser":
      return "jira_get_authenticated_user";
    case "jira.listAssignedIssues":
      return "jira_list_assigned_issues";
    case "jira.searchIssues":
      return "jira_search_issues";
    default:
      throw new Error(`Unsupported Burble MCP tool: ${toolName}`);
  }
}

function toMcpToolArguments(
  toolName: string,
  body: unknown
): Record<string, unknown> {
  if (toolName === "github.searchIssues") {
    const query = readNestedString(body, "input", "query");
    if (!query) {
      throw new Error("github.searchIssues requires input.query");
    }
    return { query };
  }

  if (toolName === "jira.searchIssues") {
    const jql = readNestedString(body, "input", "jql");
    if (!jql) {
      throw new Error("jira.searchIssues requires input.jql");
    }
    return { jql };
  }

  return {};
}

function readNestedString(
  value: unknown,
  outerKey: string,
  innerKey: string
): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const outer = (value as Record<string, unknown>)[outerKey];
  if (!outer || typeof outer !== "object") {
    return null;
  }
  const inner = (outer as Record<string, unknown>)[innerKey];
  return typeof inner === "string" && inner.trim() ? inner : null;
}

async function readMcpToolResult(response: Response): Promise<ToolResult> {
  const body = await response.text();
  const payload = parseMcpResponsePayload(body);
  const error = payload.error;
  if (error && typeof error === "object" && "message" in error) {
    throw new Error(`Burble MCP tool failed: ${String(error.message)}`);
  }

  const content = payload.result?.content;
  if (!Array.isArray(content)) {
    throw new Error("Burble MCP gateway returned malformed tool result");
  }

  const text = content
    .map((item) =>
      item &&
      typeof item === "object" &&
      "type" in item &&
      item.type === "text" &&
      "text" in item &&
      typeof item.text === "string"
        ? item.text
        : null
    )
    .find((item): item is string => item !== null);
  if (!text) {
    throw new Error("Burble MCP gateway returned no text tool result");
  }

  const parsed = JSON.parse(text);
  if (!isToolResult(parsed)) {
    throw new Error("Burble MCP gateway returned invalid Burble tool result");
  }

  return parsed;
}

function parseMcpResponsePayload(body: string): {
  result?: { content?: unknown };
  error?: unknown;
} {
  const eventData = body
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice("data: ".length);
  const raw = eventData ?? body;

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    throw new Error("Burble MCP gateway returned invalid JSON");
  }
}

async function readErrorDetail(response: Response): Promise<string> {
  const text = (await response.text()).trim().replace(/\s+/g, " ");
  return text ? `: ${text.slice(0, 300)}` : "";
}

function isToolResult(value: unknown): value is ToolResult {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    (record.classification === "public" ||
      record.classification === "user_private" ||
      record.classification === "restricted") &&
    "content" in record
  );
}
