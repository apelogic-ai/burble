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
    const bridgeCall = isBurbleProviderBridgeTool(toolName)
      ? readBurbleProviderBridgeCall(body)
      : null;
    const actualToolName = bridgeCall?.toolName ?? toolName;
    const actualBody = bridgeCall ? { input: bridgeCall.input } : body;

    if (actualToolName === "conversation.sendMessage") {
      return sendConversationMessage(config, runtimeId, request, actualBody);
    }
    if (actualToolName === "conversation.getAttachment") {
      return getConversationAttachment(config, runtimeId, request, actualBody);
    }
    if (actualToolName === "scheduledJob.registerCapability") {
      return registerScheduledJobCapability(config, runtimeId, actualBody);
    }
    if (!config.mcpGatewayUrl || !config.runtimeJwt) {
      throw new Error(
        "Burble MCP gateway URL and runtime JWT are required for provider tools"
      );
    }

    if (actualToolName === "burble.mcp.listTools") {
      sessionIdPromise ??= initializeMcpSession(config);
      const sessionId = await sessionIdPromise;
      return listBurbleMcpTools(config, sessionId);
    }

    const mcpToolName = toMcpToolName(actualToolName, request);
    const args = toMcpToolArguments(actualToolName, actualBody, request);
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

const BURBLE_PROVIDER_BRIDGE_TOOL = "burble_provider_call";
const BURBLE_PROVIDER_BRIDGE_COMPAT_TOOL = "burble.providerCall";

function isBurbleProviderBridgeTool(toolName: string): boolean {
  return toolName === BURBLE_PROVIDER_BRIDGE_TOOL ||
    toolName === BURBLE_PROVIDER_BRIDGE_COMPAT_TOOL;
}

function readBurbleProviderBridgeCall(body: unknown): {
  toolName: string;
  input: Record<string, unknown>;
} {
  const source = readRecordKey(body, "input");
  if (!source) {
    throw new Error("burble_provider_call requires input to be an object");
  }
  const toolName = readProviderBridgeToolName(source);
  const input =
    readRecordKey(source, "input") ??
    readRecordKey(source, "arguments") ??
    {};
  return { toolName, input };
}

function readProviderBridgeToolName(
  source: Record<string, unknown> | null
): string {
  const raw = source?.toolName;
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("burble_provider_call requires input.toolName");
  }
  return raw.trim();
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

async function registerScheduledJobCapability(
  config: RuntimeConfig,
  runtimeId: string | undefined,
  body: unknown
): Promise<ToolResult> {
  if (!runtimeId) {
    throw new Error("scheduledJob.registerCapability requires a runtime id");
  }
  const input = readNestedObject(body, "input");
  if (!input) {
    throw new Error("scheduledJob.registerCapability requires input");
  }
  info(
    `Burble scheduled job tool start tool=scheduledJob.registerCapability${summarizeLogObject("input", input)}`
  );

  const response = await fetch(
    `${config.toolGatewayUrl}/${encodeURIComponent("scheduledJob.registerCapability")}/execute`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.internalToken}`,
        "x-burble-runtime-id": runtimeId
      },
      body: JSON.stringify({ input })
    }
  );

  if (!response.ok) {
    const errorResult = await readToolGatewayErrorResult(response.clone());
    if (errorResult) {
      info(
        `Burble scheduled job tool finish tool=scheduledJob.registerCapability status=${response.status} classification=${errorResult.classification}${summarizeLogObject("result", errorResult.content)}`
      );
      return errorResult;
    }
    throw new Error(
      `Burble scheduled job gateway returned HTTP ${response.status}${await readErrorDetail(response)}`
    );
  }

  const result = (await response.json()) as unknown;
  if (!isToolResult(result)) {
    throw new Error("Burble scheduled job gateway returned invalid tool result");
  }

  info(
    `Burble scheduled job tool finish tool=scheduledJob.registerCapability classification=${result.classification}${summarizeLogObject("result", result.content)}`
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
        ...(request?.runId ? { runId: request.runId } : {}),
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

async function listBurbleMcpTools(
  config: RuntimeConfig,
  sessionId: string
): Promise<ToolResult> {
  info("Burble MCP tools/list start");
  const response = await fetch(config.mcpGatewayUrl!, {
    method: "POST",
    headers: {
      ...mcpHeaders(config),
      "mcp-session-id": sessionId
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/list"
    })
  });

  if (!response.ok) {
    throw new Error(
      `Burble MCP tools/list returned HTTP ${response.status}${await readErrorDetail(response)}`
    );
  }

  const tools = await readMcpToolsListResult(response);
  info(`Burble MCP tools/list finish count=${tools.length}`);
  return {
    classification: "user_private",
    content: tools
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

function toMcpToolName(
  toolName: string,
  request: RunRequest | undefined
): string {
  const manifestToolName = manifestToolNameToMcpToolName(toolName, request);
  if (manifestToolName) {
    return manifestToolName;
  }

  throw new Error(`Unsupported Burble MCP tool: ${toolName}`);
}

function manifestToolNameToMcpToolName(
  toolName: string,
  request: RunRequest | undefined
): string | null {
  const tools = request?.runtime?.manifest?.tools;
  if (!tools) {
    return null;
  }

  const tool = tools.find(
    (entry) =>
      entry.enabled !== false &&
      (entry.name === toolName || entry.alias === toolName)
  );
  return tool?.name ?? null;
}

export const __openClawBurbleToolMappingTestHooks = {
  manifestToolNameToMcpToolName,
  toMcpToolName
};

export function probeBurbleProviderToolReachability(
  toolName: string,
  request: RunRequest
): { toolName: string; input: Record<string, unknown> } {
  const tool = findManifestTool(toolName, request);
  if (!tool) {
    throw new Error(`Unsupported Burble MCP tool: ${toolName}`);
  }
  const input = sampleManifestToolInput(tool);
  return {
    toolName: toMcpToolName(toolName, request),
    input: toMcpToolArguments(toolName, { input }, request)
  };
}

type RuntimeManifestToolSummary = NonNullable<
  NonNullable<NonNullable<RunRequest["runtime"]>["manifest"]>["tools"]
>[number];

type RuntimeManifestToolInputSummary = NonNullable<
  RuntimeManifestToolSummary["input"]
>[number];

function toMcpToolArguments(
  toolName: string,
  body: unknown,
  request: RunRequest | undefined
): Record<string, unknown> {
  return withScheduledJobIdentity(
    toMcpToolArgumentsWithoutScheduledJobIdentity(toolName, body, request),
    readRecordKey(body, "input")
  );
}

function toMcpToolArgumentsWithoutScheduledJobIdentity(
  toolName: string,
  body: unknown,
  request: RunRequest | undefined
): Record<string, unknown> {
  const input = readProviderToolInput(body);
  const tool = findManifestTool(toolName, request);
  if (!tool) {
    throw new Error(`Unsupported Burble MCP tool: ${toolName}`);
  }
  return coerceManifestToolInput(toolName, input, tool);
}

function findManifestTool(
  toolName: string,
  request: RunRequest | undefined
): RuntimeManifestToolSummary | null {
  return request?.runtime?.manifest?.tools?.find(
    (entry) =>
      entry.enabled !== false &&
      (entry.name === toolName || entry.alias === toolName)
  ) ?? null;
}

function readProviderToolInput(body: unknown): Record<string, unknown> | null {
  const input = readRecordKey(body, "input");
  if (!input) {
    return null;
  }
  const keys = Object.keys(input);
  if (
    keys.length === 1 &&
    (keys[0] === "input" || keys[0] === "arguments" || keys[0] === "params")
  ) {
    return readNestedRecord(body, "input", keys[0]) ?? input;
  }
  return input;
}

function coerceManifestToolInput(
  toolName: string,
  input: Record<string, unknown> | null,
  tool: RuntimeManifestToolSummary
): Record<string, unknown> {
  if (!tool.input?.length) {
    return input ?? {};
  }

  const output: Record<string, unknown> = {};
  for (const field of tool.input ?? []) {
    const result = readManifestInputField(input, field);
    if (result.value === undefined) {
      if (field.required) {
        throw new Error(
          `${toolName} requires input.${field.name}${
            result.invalid ? ` to be ${field.type}` : ""
          }`
        );
      }
      continue;
    }
    output[field.name] = result.value;
  }
  return output;
}

function readManifestInputField(
  input: Record<string, unknown> | null,
  field: RuntimeManifestToolInputSummary
): { value: unknown; invalid: boolean } {
  if (!input) {
    return { value: undefined, invalid: false };
  }
  let invalid = false;
  for (const key of [field.name, ...(field.aliases ?? [])]) {
    if (Object.hasOwn(input, key)) {
      const value = coerceManifestInputValue(input[key], field);
      if (value !== undefined) {
        return { value, invalid: false };
      }
      invalid = true;
    }
  }
  return { value: undefined, invalid };
}

function coerceManifestInputValue(
  value: unknown,
  field: RuntimeManifestToolInputSummary
): unknown {
  if (value === null) {
    return field.nullable ? null : undefined;
  }
  if (value === undefined) {
    return undefined;
  }
  switch (field.type) {
    case "string":
      return typeof value === "string" && value.trim() ? value : undefined;
    case "number":
      if (typeof value === "number" && Number.isFinite(value)) {
        return value;
      }
      if (typeof value === "string" && value.trim()) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
      }
      return undefined;
    case "boolean":
      if (typeof value === "boolean") {
        return value;
      }
      if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (normalized === "true") {
          return true;
        }
        if (normalized === "false") {
          return false;
        }
      }
      return undefined;
    case "enum":
      return typeof value === "string" && value.trim()
        ? !field.values?.length || field.values.includes(value.trim())
          ? value.trim()
          : undefined
        : undefined;
    case "string[]":
      return Array.isArray(value) ? value : undefined;
    case "object":
      return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
    default:
      return isCompactManifestValue(value) ? value : undefined;
  }
}

function sampleManifestToolInput(
  tool: RuntimeManifestToolSummary
): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const field of tool.input ?? []) {
    if (!field.required) {
      continue;
    }
    input[field.name] = sampleManifestInputValue(field);
  }
  return input;
}

function sampleManifestInputValue(field: RuntimeManifestToolInputSummary): unknown {
  switch (field.type) {
    case "string":
      return `contract-${field.name}`;
    case "number":
      return 1;
    case "boolean":
      return true;
    case "enum":
      return field.values?.[0] ?? "contract";
    case "string[]":
      return ["contract"];
    case "object":
      return { contract: true };
    default:
      return `contract-${field.name}`;
  }
}

function isCompactManifestValue(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === "string" && value.trim().length > 0) ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    Array.isArray(value) ||
    (value !== null && typeof value === "object")
  );
}

function withScheduledJobIdentity(
  args: Record<string, unknown>,
  input: Record<string, unknown> | null
): Record<string, unknown> {
  const jobId = readScheduledJobIdFromInput(input);
  return jobId ? { ...args, jobId } : args;
}

function readScheduledJobIdFromInput(
  input: Record<string, unknown> | null
): string | null {
  const raw = input?.jobId;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
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

function readNestedObject(
  value: unknown,
  outerKey: string
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const outer = (value as Record<string, unknown>)[outerKey];
  if (!outer || typeof outer !== "object" || Array.isArray(outer)) {
    return null;
  }
  return outer as Record<string, unknown>;
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

function readRecordNumber(
  value: Record<string, unknown> | null,
  key: string
): number | null {
  const number = value?.[key];
  return typeof number === "number" && Number.isInteger(number) && number > 0
    ? number
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
      typeof value === "number" ||
      Array.isArray(value)
    ) {
      output[key] = value;
    }
  }
  return output;
}

function compactRecordField(
  input: Record<string, unknown>,
  key: string
): Record<string, unknown> {
  const value = input[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? { [key]: value }
    : {};
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

async function readMcpToolsListResult(response: Response): Promise<unknown[]> {
  const body = await response.text();
  const payload = parseMcpResponsePayload(body);
  const error = payload.error;
  if (error && typeof error === "object" && "message" in error) {
    throw new Error(`Burble MCP tools/list failed: ${String(error.message)}`);
  }

  const tools = payload.result?.tools;
  if (!Array.isArray(tools)) {
    throw new Error("Burble MCP tools/list returned malformed result");
  }

  return tools
    .filter((tool) => tool && typeof tool === "object" && !Array.isArray(tool))
    .map((tool) => sanitizeMcpToolMetadata(tool as Record<string, unknown>));
}

function sanitizeMcpToolMetadata(
  tool: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...(typeof tool.name === "string" ? { name: tool.name } : {}),
    ...(typeof tool.title === "string" ? { title: tool.title } : {}),
    ...(typeof tool.description === "string"
      ? { description: tool.description }
      : {}),
    ...(tool.inputSchema && typeof tool.inputSchema === "object"
      ? { inputSchema: tool.inputSchema }
      : {})
  };
}

function parseMcpResponsePayload(body: string): {
  result?: { content?: unknown; tools?: unknown };
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

async function readToolGatewayErrorResult(
  response: Response
): Promise<ToolResult | null> {
  try {
    const parsed = (await response.json()) as unknown;
    return isToolResult(parsed) ? parsed : null;
  } catch {
    return null;
  }
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
