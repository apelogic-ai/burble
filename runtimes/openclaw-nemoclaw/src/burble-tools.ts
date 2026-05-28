import type { RuntimeConfig } from "./config";
import { info } from "./logger";
import type {
  ConversationAttachment,
  RunRequest,
  ToolExecutor,
  ToolResult
} from "./types";

export function createBurbleToolExecutor(
  config: RuntimeConfig,
  runtimeId?: string,
  request?: RunRequest
): ToolExecutor {
  return createBurbleMcpToolExecutor(config, runtimeId, request);
}

function createBurbleMcpToolExecutor(
  config: RuntimeConfig,
  runtimeId?: string,
  request?: RunRequest
): ToolExecutor {
  let sessionIdPromise: Promise<string> | null = null;
  return async (toolName, body) => {
    if (toolName === "conversation.sendMessage") {
      return sendConversationMessage(config, runtimeId, request, body);
    }
    if (toolName === "conversation.getAttachment") {
      return getConversationAttachment(config, runtimeId, request, body);
    }
    if (!config.mcpGatewayUrl || !config.runtimeJwt) {
      throw new Error(
        "Burble MCP gateway URL and runtime JWT are required for provider tools"
      );
    }

    const mcpToolName = toMcpToolName(toolName);
    const args = toMcpToolArguments(toolName, body);
    sessionIdPromise ??= initializeMcpSession(config);
    const sessionId = await sessionIdPromise;
    info(`Burble MCP tool start tool=${mcpToolName}${summarizeLogObject("args", args)}`);

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
      `Burble MCP tool finish tool=${mcpToolName} classification=${result.classification}${summarizeLogObject("result", result.content)}`
    );
    return result;
  };
}

async function sendConversationMessage(
  config: RuntimeConfig,
  runtimeId: string | undefined,
  request: RunRequest | undefined,
  body: unknown
): Promise<ToolResult> {
  if (!runtimeId) {
    throw new Error("conversation.sendMessage requires a runtime id");
  }
  const text = readNestedText(body, "input", "text");
  const attachments = readNestedAttachments(body, "input", "attachments");
  if (!text && !attachments?.length) {
    throw new Error("conversation.sendMessage requires input.text or input.attachments");
  }
  const routeId =
    readNestedString(body, "input", "routeId") ??
    request?.input.conversation?.routeId;
  if (!routeId && !request?.input.conversation) {
    throw new Error("conversation.sendMessage requires a route id or active conversation");
  }

  const input = {
    text: text ?? "",
    ...(routeId ? { routeId } : {}),
    ...(attachments ? { attachments } : {})
  };
  info(
    `Burble conversation tool start tool=conversation.sendMessage${summarizeLogObject("input", input)}`
  );

  const response = await fetch(
    `${config.toolGatewayUrl}/${encodeURIComponent("conversation.sendMessage")}/execute`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.internalToken}`,
        "x-burble-runtime-id": runtimeId
      },
      body: JSON.stringify({
        input,
        ...(request?.input.conversation
          ? { conversation: request.input.conversation }
          : {})
      })
    }
  );

  if (!response.ok) {
    throw new Error(
      `Burble conversation gateway returned HTTP ${response.status}${await readErrorDetail(response)}`
    );
  }

  const result = (await response.json()) as unknown;
  if (!isToolResult(result)) {
    throw new Error("Burble conversation gateway returned invalid tool result");
  }

  info(
    `Burble conversation tool finish tool=conversation.sendMessage classification=${result.classification}${summarizeLogObject("result", result.content)}`
  );
  return result;
}

async function getConversationAttachment(
  config: RuntimeConfig,
  runtimeId: string | undefined,
  request: RunRequest | undefined,
  body: unknown
): Promise<ToolResult> {
  if (!runtimeId) {
    throw new Error("conversation.getAttachment requires a runtime id");
  }
  const attachmentId = readNestedString(body, "input", "attachmentId");
  if (!attachmentId) {
    throw new Error("conversation.getAttachment requires input.attachmentId");
  }

  const input = { attachmentId };
  info(
    `Burble conversation tool start tool=conversation.getAttachment${summarizeLogObject("input", input)}`
  );

  const response = await fetch(
    `${config.toolGatewayUrl}/${encodeURIComponent("conversation.getAttachment")}/execute`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.internalToken}`,
        "x-burble-runtime-id": runtimeId
      },
      body: JSON.stringify({
        input,
        ...(request?.input.attachments
          ? { attachments: request.input.attachments }
          : {}),
        ...(request?.input.conversation
          ? { conversation: request.input.conversation }
          : {})
      })
    }
  );

  if (!response.ok) {
    throw new Error(
      `Burble conversation gateway returned HTTP ${response.status}${await readErrorDetail(response)}`
    );
  }

  const result = (await response.json()) as unknown;
  if (!isToolResult(result)) {
    throw new Error("Burble conversation gateway returned invalid tool result");
  }

  info(
    `Burble conversation tool finish tool=conversation.getAttachment classification=${result.classification}${summarizeLogObject("result", result.content)}`
  );
  return result;
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
    case "google.getAuthenticatedUser":
      return "google_get_authenticated_user";
    case "google.searchDriveFiles":
      return "google_search_drive_files";
    case "google.searchCalendarEvents":
      return "google_search_calendar_events";
    case "google.searchMailMessages":
      return "google_search_mail_messages";
    case "jira.getAuthenticatedUser":
      return "jira_get_authenticated_user";
    case "jira.listAccessibleResources":
      return "jira_list_accessible_resources";
    case "jira.listVisibleProjects":
      return "jira_list_visible_projects";
    case "jira.searchUsers":
      return "jira_search_users";
    case "jira.createIssue":
      return "jira_create_issue";
    case "jira.editIssue":
      return "jira_edit_issue";
    case "jira.listAssignedIssues":
      return "jira_list_assigned_issues";
    case "jira.searchIssues":
      return "jira_search_issues";
    case "slack.searchUsers":
      return "slack_search_users";
    case "slack.searchMessages":
      return "slack_search_messages";
    case "atlassian.listMcpTools":
      return "atlassian_list_mcp_tools";
    case "atlassian.callMcpTool":
      return "atlassian_call_mcp_tool";
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

  if (toolName === "google.searchDriveFiles") {
    return compactToolInput(readRecordKey(body, "input"), [
      "query",
      "limit"
    ]);
  }

  if (toolName === "google.searchCalendarEvents") {
    return compactToolInput(readRecordKey(body, "input"), [
      "query",
      "timeMin",
      "timeMax",
      "limit"
    ]);
  }

  if (toolName === "google.searchMailMessages") {
    const query = readNestedString(body, "input", "query");
    if (!query) {
      throw new Error("google.searchMailMessages requires input.query");
    }
    return {
      query,
      ...compactToolInput(readRecordKey(body, "input"), ["limit"])
    };
  }

  if (toolName === "jira.listVisibleProjects") {
    const input = readNestedRecord(body, "input", "input") ??
      readNestedRecord(body, "input", "arguments") ??
      readNestedRecord(body, "input", "params") ??
      readRecordKey(body, "input");
    if (!input) {
      return {};
    }

    return {
      ...(typeof input.query === "string" && input.query.trim()
        ? { query: input.query }
        : {}),
      ...(typeof input.action === "string" && input.action.trim()
        ? { action: input.action }
        : {}),
      ...(typeof input.expandIssueTypes === "boolean"
        ? { expandIssueTypes: input.expandIssueTypes }
        : {})
    };
  }

  if (toolName === "jira.searchUsers") {
    const query = readNestedString(body, "input", "query");
    if (!query) {
      throw new Error("jira.searchUsers requires input.query");
    }
    return { query };
  }

  if (toolName === "slack.searchUsers") {
    const query = readNestedString(body, "input", "query");
    if (!query) {
      throw new Error("slack.searchUsers requires input.query");
    }
    return { query };
  }

  if (toolName === "slack.searchMessages") {
    return compactToolInput(readRecordKey(body, "input"), [
      "query",
      "fromUserId",
      "inChannel",
      "limit"
    ]);
  }

  if (toolName === "jira.createIssue") {
    return compactToolInput(readRecordKey(body, "input"), [
      "projectKey",
      "issueTypeName",
      "issueTypeId",
      "summary",
      "description",
      "assigneeAccountId"
    ]);
  }

  if (toolName === "jira.editIssue") {
    return compactToolInput(readRecordKey(body, "input"), [
      "issueKey",
      "summary",
      "description",
      "assigneeAccountId"
    ]);
  }

  if (toolName === "atlassian.callMcpTool") {
    const name = readNestedString(body, "input", "name");
    if (!name) {
      throw new Error("atlassian.callMcpTool requires input.name");
    }

    return {
      name,
      arguments: readNestedRecord(body, "input", "arguments") ?? {}
    };
  }

  return {};
}

function readNestedString(
  value: unknown,
  outerKey: string,
  innerKey: string
): string | null {
  const inner = readNestedValue(value, outerKey, innerKey);
  return typeof inner === "string" && inner.trim() ? inner : null;
}

function readNestedText(
  value: unknown,
  outerKey: string,
  innerKey: string
): string | null {
  const inner = readNestedValue(value, outerKey, innerKey);
  return typeof inner === "string" &&
    inner.replace(/[\s\p{Default_Ignorable_Code_Point}]/gu, "").length > 0
    ? inner
    : null;
}

function readNestedValue(
  value: unknown,
  outerKey: string,
  innerKey: string
): unknown {
  if (!value || typeof value !== "object") {
    return null;
  }
  const outer = (value as Record<string, unknown>)[outerKey];
  if (!outer || typeof outer !== "object") {
    return null;
  }
  return (outer as Record<string, unknown>)[innerKey];
}

function readNestedAttachments(
  value: unknown,
  outerKey: string,
  innerKey: string
): ConversationAttachment[] | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const outer = (value as Record<string, unknown>)[outerKey];
  if (!outer || typeof outer !== "object") {
    return null;
  }
  const inner = (outer as Record<string, unknown>)[innerKey];
  return isConversationAttachmentArray(inner) ? inner : null;
}

function isConversationAttachmentArray(
  value: unknown
): value is ConversationAttachment[] {
  return Array.isArray(value) && value.every(isConversationAttachment);
}

function isConversationAttachment(value: unknown): value is ConversationAttachment {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    record.id.trim().length > 0 &&
    (record.kind === "file" ||
      record.kind === "image" ||
      record.kind === "audio" ||
      record.kind === "video") &&
    typeof record.mimeType === "string" &&
    record.mimeType.trim().length > 0 &&
    (record.source === "slack" ||
      record.source === "burble" ||
      record.source === "agent") &&
    optionalString(record.name) &&
    (record.sizeBytes === undefined ||
      (typeof record.sizeBytes === "number" &&
        Number.isFinite(record.sizeBytes) &&
        record.sizeBytes >= 0)) &&
    optionalString(record.externalId)
  );
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function readNestedRecord(
  value: unknown,
  outerKey: string,
  innerKey: string
): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const outer = (value as Record<string, unknown>)[outerKey];
  if (!outer || typeof outer !== "object") {
    return null;
  }
  const inner = (outer as Record<string, unknown>)[innerKey];
  return inner && typeof inner === "object" && !Array.isArray(inner)
    ? (inner as Record<string, unknown>)
    : null;
}

function readRecordKey(
  value: unknown,
  key: string
): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const inner = (value as Record<string, unknown>)[key];
  return inner && typeof inner === "object" && !Array.isArray(inner)
    ? (inner as Record<string, unknown>)
    : null;
}

function compactToolInput(
  input: Record<string, unknown> | null,
  keys: string[]
): Record<string, unknown> {
  if (!input) {
    return {};
  }

  const output: Record<string, unknown> = {};
  for (const key of keys) {
    const value = input[key];
    if (
      value === null ||
      (typeof value === "string" && value.trim()) ||
      typeof value === "boolean" ||
      typeof value === "number"
    ) {
      output[key] = value;
    }
  }
  return output;
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      classification: "user_private",
      content: text
    };
  }

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

function summarizeLogObject(label: string, value: unknown): string {
  return ` ${label}=${JSON.stringify(sanitizeLogValue(value, 0))}`;
}

function sanitizeLogValue(value: unknown, depth: number): unknown {
  if (depth > 3) {
    return "[depth-limit]";
  }

  if (typeof value === "string") {
    return sanitizeLogString(value);
  }

  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 10).map((item) => sanitizeLogValue(item, depth + 1));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 30)
        .map(([key, item]) => [
          key,
          shouldRedactLogKey(key) ? "[redacted]" : sanitizeLogValue(item, depth + 1)
        ])
    );
  }

  return String(value);
}

function sanitizeLogString(value: string): string {
  return truncateLogValue(
    value.replace(
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
      (email) => redactEmail(email)
    ),
    300
  );
}

function shouldRedactLogKey(key: string): boolean {
  return /(authorization|token|secret|password|credential|jwt|cookie)/i.test(key);
}

function redactEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) {
    return "[redacted-email]";
  }

  return `${local.slice(0, 2)}***@${domain}`;
}

function truncateLogValue(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength - 3)}...`;
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
