import type { RuntimeConfig, RuntimeEngine } from "./config";
import { createBurbleToolExecutor } from "./burble-tools";
import { createBurbleConversationConnector } from "./burble-conversation-connector";
import { info } from "./logger";
import { createRuntimeRunner } from "./runtime";
import {
  authorizeRuntimeBearerOrHeaderToken,
  createRuntimeContractServer,
  type RuntimeEventWebSocket
} from "@burble/runtime-sdk/server";
import {
  runtimeConnectionSummarySchema,
  runtimeConversationAttachmentSchema,
  runtimeConversationSummarySchema,
  runtimeRequestContextSchema,
  runtimeToolGroupSelectionSchema,
  scheduledJobContextSchema
} from "@burble/runtime-sdk/runtime-contract";
import type {
  ConversationAttachment,
  RunEvent,
  RunRequest,
  RunResponse,
  ToolExecutor
} from "./types";

const localScheduledJobRegisterCapabilityToolName =
  "scheduled_job_register_capability";
const localSchedulerControlTools: Record<string, string> = {
  scheduled_job_register_capability: "scheduledJob.registerCapability",
  scheduled_job_list: "scheduledJob.list",
  scheduled_job_trigger: "scheduledJob.trigger",
  scheduled_job_latest_run_status: "scheduledJob.latestRunStatus"
};

type RuntimeServerContext = {
  config: RuntimeConfig;
  executeTool?: ToolExecutor;
  prepareNativeOpenClaw?: (config: RuntimeConfig) => Promise<void>;
};

const runtimeContractServer = createRuntimeContractServer<
  RuntimeServerContext,
  RunRequest,
  RunEvent,
  RunResponse
>({
  authorizeRequest: (request, { config }) =>
    authorizeRuntimeBearerOrHeaderToken(request, config.internalToken),
  getCapabilityManifest: ({ config }) => buildRuntimeCapabilityManifest(config),
  normalizeRunRequest(rawBody, runId) {
    const body = addRunId(rawBody, runId);
    return body && isRunRequest(body) ? body : null;
  },
  streamRun(body, context) {
    const runner = createRuntimeRunner(context.config, {
      ...(context.prepareNativeOpenClaw
        ? { prepareNativeOpenClaw: context.prepareNativeOpenClaw }
        : {})
    });
    return runner.stream(body, context.executeTool);
  },
  responseFromEvent(event) {
    return event.type === "final" ? { response: event.response } : null;
  },
  formatError: formatRuntimeError
});

export async function handleRuntimeRequest(
  request: Request,
  config: RuntimeConfig,
  executeTool?: ToolExecutor,
  options: {
    upgradeWebSocket?: (runId: string) => boolean;
    prepareNativeOpenClaw?: (config: RuntimeConfig) => Promise<void>;
  } = {}
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/internal/conversation/messages") {
    return handleLocalConversationMessageRequest(request, config);
  }

  if (url.pathname === "/internal/burble/mcp") {
    return handleLocalBurbleMcpRequest(request, config);
  }

  const burbleChannelMessageMatch =
    /^\/internal\/burble\/channel\/routes\/([^/]+)\/messages$/.exec(
      url.pathname
    );
  if (burbleChannelMessageMatch) {
    return handleLocalBurbleChannelMessageRequest(
      request,
      config,
      decodeURIComponent(burbleChannelMessageMatch[1] ?? "")
    );
  }

  const burbleChannelEventMatch =
    /^\/internal\/burble\/channel\/routes\/([^/]+)\/events$/.exec(
      url.pathname
    );
  if (burbleChannelEventMatch) {
    return handleLocalBurbleChannelEventRequest(
      request,
      config,
      decodeURIComponent(burbleChannelEventMatch[1] ?? "")
    );
  }

  const conversationWebhookMatch =
    /^\/internal\/conversation\/routes\/([^/]+)\/webhook$/.exec(url.pathname);
  if (conversationWebhookMatch) {
    return handleLocalBurbleChannelEventRequest(
      request,
      config,
      decodeURIComponent(conversationWebhookMatch[1] ?? "")
    );
  }

  const contractResponse = await runtimeContractServer.handleRequest(
    request,
    {
      config,
      ...(executeTool ? { executeTool } : {}),
      ...(options.prepareNativeOpenClaw
        ? { prepareNativeOpenClaw: options.prepareNativeOpenClaw }
        : {})
    },
    {
      ...(options.upgradeWebSocket
        ? { upgradeWebSocket: options.upgradeWebSocket }
        : {})
    }
  );
  if (contractResponse !== null) {
    return contractResponse;
  }

  return new Response("Not found", { status: 404 });
}

function buildRuntimeCapabilityManifest(config: RuntimeConfig) {
  return {
    runtimeType: config.engine,
    version: "1",
    transports: ["http", "sse", "ndjson", "websocket"],
    streaming: true,
    cancellation: false,
    nativeScheduler: true,
    scheduledProviderCalls: true,
    toolCalls: true,
    toolBridgeModes: buildRuntimeToolBridgeModes(config),
    usageReporting: runtimeUsageReporting(config.engine),
    multimodalInput: true,
    multimodalOutput: false,
    memory: true,
    durableWorkflowState: true,
    attachments: true,
    conversationSend: true,
    jobScopedAuth: true
  };
}

function buildRuntimeToolBridgeModes(config: RuntimeConfig) {
  const modes = ["tool_gateway"];
  if (config.mcpGatewayUrl && config.runtimeJwt) {
    modes.push("mcp");
  }
  return modes;
}

function runtimeUsageReporting(engine: RuntimeEngine) {
  return engine === "deterministic" ? "none" : "exact";
}

async function handleLocalConversationMessageRequest(
  request: Request,
  config: RuntimeConfig
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const body = await readLocalConversationMessageBody(request);
  if (!body) {
    return new Response("Invalid conversation message input", { status: 400 });
  }
  if (!config.runtimeId) {
    return new Response("Runtime id is not configured", { status: 500 });
  }

  const connector = createBurbleConversationConnector(config, config.runtimeId);
  const result = await connector.sendMessage(body);
  return Response.json(result, {
    headers: {
      "cache-control": "no-store"
    }
  });
}

async function handleLocalBurbleMcpRequest(
  request: Request,
  config: RuntimeConfig
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  const bodyText = await request.text();
  const payload = readMcpJsonRpcPayload(bodyText);
  if (isMcpToolCall(payload)) {
    const localSchedulerToolName = readLocalSchedulerControlToolName(payload);
    if (localSchedulerToolName) {
      return handleLocalSchedulerControlMcpCall(
        payload,
        config,
        localSchedulerToolName
      );
    }
    const routeId = readMcpToolCallRouteId(payload);
    const jobId = readMcpToolCallJobId(payload);
    if (!routeId && !jobId) {
      return mcpJsonRpcErrorResponse(
        readMcpJsonRpcId(payload),
        -32602,
        "Burble provider tools require a routeId or jobId argument."
      );
    }
    if (routeId && !isBurbleConversationRouteId(routeId)) {
      return mcpJsonRpcErrorResponse(
        readMcpJsonRpcId(payload),
        -32602,
        "Burble provider tool routeId must be the active convrt_* conversation route, not a cron job id, run id, session id, or UUID."
      );
    }
  }
  if (!config.mcpGatewayUrl || !config.runtimeJwt) {
    return new Response("Burble MCP gateway is not configured", { status: 503 });
  }

  const upstreamResponse = await fetch(config.mcpGatewayUrl, {
    method: "POST",
    headers: buildBurbleMcpProxyHeaders(request, config.runtimeJwt),
    body: bodyText
  });
  const upstreamBody = await upstreamResponse.text();
  const body = isMcpToolsList(payload)
    ? addRouteIdToMcpToolsListResponse(upstreamBody)
    : upstreamBody;

  return new Response(body, {
    status: upstreamResponse.status,
    headers: buildBurbleMcpProxyResponseHeaders(upstreamResponse)
  });
}

async function handleLocalBurbleChannelMessageRequest(
  request: Request,
  config: RuntimeConfig,
  routeId: string
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  if (!routeId.trim()) {
    return new Response("Invalid conversation route", { status: 400 });
  }
  if (!config.runtimeId) {
    return new Response("Runtime id is not configured", { status: 500 });
  }

  const body = await readLocalBurbleChannelMessageBody(request, routeId);
  if (!body) {
    return new Response("Invalid Burble channel message input", { status: 400 });
  }
  if (!isBurbleConversationRouteId(routeId) && !body.jobId) {
    return unresolvedBurbleChannelRouteResponse();
  }

  const connector = createBurbleConversationConnector(config, config.runtimeId);
  const result = await connector.sendMessage(body);
  return Response.json(result, {
    headers: {
      "cache-control": "no-store"
    }
  });
}

async function handleLocalBurbleChannelEventRequest(
  request: Request,
  config: RuntimeConfig,
  routeId: string
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  if (!routeId.trim()) {
    return new Response("Invalid conversation route", { status: 400 });
  }
  if (!config.runtimeId) {
    return new Response("Runtime id is not configured", { status: 500 });
  }

  const payload = await readJsonBody(request);
  const jobId =
    readLocalBurbleChannelJobId(payload) ?? readLocalBurbleChannelUrlJobId(request);
  if (!isBurbleConversationRouteId(routeId) && !jobId) {
    return unresolvedBurbleChannelRouteResponse();
  }
  const connector = createBurbleConversationConnector(config, config.runtimeId);
  const result = await connector.deliverEvent({
    routeId,
    ...(jobId ? { jobId } : {}),
    payload
  });
  if (!result) {
    return new Response("Burble channel event did not contain deliverable text", {
      status: 202
    });
  }

  return Response.json(result, {
    headers: {
      "cache-control": "no-store"
    }
  });
}

export function attachRuntimeEventWebSocket(
  runId: string,
  ws: RuntimeEventWebSocket
): void {
  runtimeContractServer.attachEventWebSocket(runId, ws);
}

function formatRuntimeError(error: unknown): string {
  if (error instanceof Error && error.message) {
    if (isModelQuotaError(error.message)) {
      return "Agent model provider quota is exhausted. Update the selected provider key/billing or switch AI_MODEL to a provider/model with available quota.";
    }
    return error.message;
  }

  return "unknown error";
}

function isModelQuotaError(message: string): boolean {
  return /insufficient_quota|exceeded your current quota/i.test(message);
}

async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function readLocalConversationMessageBody(
  request: Request
): Promise<{
  routeId: string;
  jobId?: string;
  text: string;
  attachments?: ConversationAttachment[];
} | null> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }

  const record = body as Record<string, unknown>;
  const attachments = conversationAttachmentsFrom(record.attachments) ?? undefined;
  if (
    typeof record.routeId !== "string" ||
    record.routeId.trim().length === 0 ||
    typeof record.text !== "string" ||
    ("attachments" in record &&
      record.attachments !== undefined &&
      !attachments) ||
    (!hasVisibleText(record.text) && !attachments?.length) ||
    record.text.length > 4000
  ) {
    return null;
  }

  return {
    routeId: record.routeId,
    ...readOptionalJobId(record),
    text: record.text,
    ...(attachments?.length ? { attachments } : {})
  };
}

function buildBurbleMcpProxyHeaders(
  request: Request,
  runtimeJwt: string
): Headers {
  const headers = new Headers();
  const contentType = request.headers.get("content-type");
  headers.set("content-type", contentType ?? "application/json");
  headers.set(
    "accept",
    request.headers.get("accept") ?? "application/json, text/event-stream"
  );
  headers.set("authorization", `Bearer ${runtimeJwt}`);

  for (const name of ["mcp-protocol-version", "mcp-session-id"]) {
    const value = request.headers.get(name);
    if (value) {
      headers.set(name, value);
    }
  }

  return headers;
}

function buildBurbleMcpProxyResponseHeaders(response: Response): Headers {
  const headers = new Headers({
    "cache-control": "no-store"
  });
  for (const name of ["content-type", "mcp-session-id"]) {
    const value = response.headers.get(name);
    if (value) {
      headers.set(name, value);
    }
  }
  return headers;
}

function readMcpJsonRpcPayload(bodyText: string): unknown {
  try {
    return JSON.parse(bodyText);
  } catch {
    return null;
  }
}

function isMcpToolsList(payload: unknown): payload is { method: "tools/list" } {
  return (
    typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload) &&
    (payload as { method?: unknown }).method === "tools/list"
  );
}

function isMcpToolCall(
  payload: unknown
): payload is { id?: unknown; method: "tools/call"; params?: unknown } {
  return (
    typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload) &&
    (payload as { method?: unknown }).method === "tools/call"
  );
}

function readLocalSchedulerControlToolName(payload: {
  method: "tools/call";
  params?: unknown;
}): string | null {
  const name = readMcpToolCallName(payload);
  return name ? localSchedulerControlTools[name] ?? null : null;
}

function readMcpToolCallName(payload: {
  method: "tools/call";
  params?: unknown;
}): string | null {
  const params = payload.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return null;
  }
  const name = (params as Record<string, unknown>).name;
  return typeof name === "string" && name.trim().length > 0
    ? name.trim()
    : null;
}

function readMcpToolCallArguments(payload: {
  method: "tools/call";
  params?: unknown;
}): Record<string, unknown> {
  const params = payload.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return {};
  }
  const args = (params as Record<string, unknown>).arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return {};
  }
  return args as Record<string, unknown>;
}

function readMcpToolCallRouteId(payload: {
  method: "tools/call";
  params?: unknown;
}): string | null {
  const params = payload.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return null;
  }
  const args = (params as Record<string, unknown>).arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return null;
  }
  const routeId = (args as Record<string, unknown>).routeId;
  return typeof routeId === "string" && routeId.trim().length > 0
    ? routeId.trim()
    : null;
}

function readMcpToolCallJobId(payload: {
  method: "tools/call";
  params?: unknown;
}): string | null {
  const params = payload.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return null;
  }
  const args = (params as Record<string, unknown>).arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return null;
  }
  const jobId = (args as Record<string, unknown>).jobId;
  return typeof jobId === "string" && jobId.trim().length > 0
    ? jobId.trim()
    : null;
}

function isBurbleConversationRouteId(routeId: string): boolean {
  return /^convrt_[0-9a-f]{24}$/.test(routeId);
}

function readMcpJsonRpcId(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  return (payload as { id?: unknown }).id ?? null;
}

function addRouteIdToMcpToolsListResponse(responseText: string): string {
  return responseText
    .split("\n")
    .map((line) => {
      if (!line.startsWith("data: ")) {
        return line;
      }
      try {
        const payload = JSON.parse(line.slice("data: ".length));
        return `data: ${JSON.stringify(addRouteIdToMcpToolsListPayload(payload))}`;
      } catch {
        return line;
      }
    })
    .join("\n");
}

function addRouteIdToMcpToolsListPayload(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return payload;
  }
  const result = (payload as { result?: unknown }).result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return payload;
  }
  const tools = (result as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) {
    return payload;
  }

  return {
    ...payload,
    result: {
      ...result,
      tools: addLocalBurbleMcpTools(tools.map(addRouteIdToMcpToolSchema))
    }
  };
}

function addLocalBurbleMcpTools(tools: unknown[]): unknown[] {
  const names = new Set(
    tools
      .map((tool) =>
        typeof tool === "object" && tool !== null && !Array.isArray(tool)
          ? (tool as { name?: unknown }).name
          : null
      )
      .filter((name): name is string => typeof name === "string")
  );
  const localTools = [
    scheduledJobRegisterCapabilityMcpTool(),
    scheduledJobListMcpTool(),
    scheduledJobTriggerMcpTool(),
    scheduledJobLatestRunStatusMcpTool()
  ].filter((tool) => !names.has(String(tool.name)));
  return [...tools, ...localTools];
}

function scheduledJobRegisterCapabilityMcpTool(): Record<string, unknown> {
  return {
    name: localScheduledJobRegisterCapabilityToolName,
    description:
      "Register a native scheduled/background job with Burble's scheduledJob.registerCapability control-plane tool before enabling or triggering provider-backed scheduled work or scheduled Slack destination delivery. Use the returned convrt_* route for native delivery; never use a Slack label as delivery.to.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: {
          type: "string",
          minLength: 1,
          description: "Stable native scheduler job id returned by the runtime scheduler."
        },
        requiredTools: {
          type: "array",
          items: { type: "string", minLength: 1 },
          minItems: 1,
          description:
            "Exact Burble provider tool names this scheduled job may call, for example google.getDriveFile."
        },
        routeId: {
          type: "string",
          minLength: 1,
          pattern: "^convrt_[0-9a-f]{24}$",
          description:
            "Optional durable Burble convrt_* conversation route for scheduled delivery. Never pass a Slack label, mention, channel id, run id, or guessed value here."
        },
        destination: {
          type: "string",
          minLength: 1,
          description:
            "Optional Slack destination label for scheduled delivery, such as #eng, <#C123|eng>, or a channel id. Pass named Slack channels here; Burble resolves it only when the user has already granted that channel with /agent grant here."
        },
        stateRefs: {
          type: "array",
          description:
            'Optional durable provider-backed state reference objects, never strings; each entry must include provider and kind strings, for example {"provider":"google","kind":"drive_file","id":"<fileId>"}.',
          items: {
            type: "object",
            properties: {
              provider: { type: "string", minLength: 1 },
              kind: { type: "string", minLength: 1 },
              id: { type: "string" },
              name: { type: "string" },
              purpose: { type: "string" }
            },
            required: ["provider", "kind"]
          }
        },
        visibilityPolicy: {
          type: "object",
          description:
            'Optional output visibility policy for scheduled delivery. Slack channel destinations require {"maxOutputVisibility":"public"} when the user explicitly asked to post public scheduled output to that channel. Do not set allowPrivateToolDeclassification automatically.',
          properties: {
            maxOutputVisibility: {
              type: "string",
              enum: ["public", "user_private", "restricted"],
              description:
                'Set to "public" only when the user explicitly asked public-source scheduled output to post to a Slack channel.'
            },
            allowPrivateToolDeclassification: {
              type: "boolean",
              description:
                "Do not set automatically. Reserved for an explicit declassification approval flow."
            }
          },
          additionalProperties: false
        }
      },
      required: ["jobId", "requiredTools"]
    }
  };
}

function scheduledJobListMcpTool(): Record<string, unknown> {
  return {
    name: "scheduled_job_list",
    description:
      "List Burble-controlled scheduled jobs for this workspace/user. Use this for questions like whether any cron jobs are configured.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  };
}

function scheduledJobTriggerMcpTool(): Record<string, unknown> {
  return {
    name: "scheduled_job_trigger",
    description:
      "Manually trigger one existing Burble-controlled scheduled job. Pass jobId when multiple jobs may exist.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: {
          type: "string",
          minLength: 1,
          description: "Optional scheduled job id to trigger."
        }
      }
    }
  };
}

function scheduledJobLatestRunStatusMcpTool(): Record<string, unknown> {
  return {
    name: "scheduled_job_latest_run_status",
    description:
      "Read the latest recorded run status for a Burble-controlled scheduled job. Pass jobId when checking a specific job.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: {
          type: "string",
          minLength: 1,
          description: "Optional scheduled job id whose latest run should be checked."
        }
      }
    }
  };
}

function addRouteIdToMcpToolSchema(tool: unknown): unknown {
  if (typeof tool !== "object" || tool === null || Array.isArray(tool)) {
    return tool;
  }
  const inputSchema =
    typeof (tool as { inputSchema?: unknown }).inputSchema === "object" &&
    (tool as { inputSchema?: unknown }).inputSchema !== null &&
    !Array.isArray((tool as { inputSchema?: unknown }).inputSchema)
      ? ((tool as { inputSchema: Record<string, unknown> }).inputSchema)
      : {};
  const properties =
    typeof inputSchema.properties === "object" &&
    inputSchema.properties !== null &&
    !Array.isArray(inputSchema.properties)
      ? (inputSchema.properties as Record<string, unknown>)
      : {};
  const required = Array.isArray(inputSchema.required)
    ? inputSchema.required.filter((value): value is string => typeof value === "string")
    : [];

  return {
    ...tool,
    inputSchema: {
      ...inputSchema,
      type: "object",
      properties: {
        ...properties,
        routeId: {
          type: "string",
          minLength: 1,
          pattern: "^convrt_[0-9a-f]{24}$",
          description:
            "Exact Burble convrt_* conversation route id for this Slack conversation. Never use a cron job id, run id, session id, or UUID."
        },
        jobId: {
          type: "string",
          minLength: 1,
          description:
            "Scheduled Burble job id. Use this instead of routeId for scheduled/background provider calls."
        }
      },
      required
    }
  };
}

async function handleLocalSchedulerControlMcpCall(
  payload: { id?: unknown; method: "tools/call"; params?: unknown },
  config: RuntimeConfig,
  toolName: string
): Promise<Response> {
  if (!config.runtimeId) {
    return mcpJsonRpcErrorResponse(
      readMcpJsonRpcId(payload),
      -32000,
      "Runtime id is not configured."
    );
  }
  const executor = createBurbleToolExecutor(config, config.runtimeId);
  try {
    const result = await executor(toolName, {
      input: readMcpToolCallArguments(payload)
    });
    return mcpJsonRpcResultResponse(readMcpJsonRpcId(payload), {
      content: [
        {
          type: "text",
          text: JSON.stringify(result)
        }
      ]
    });
  } catch (error) {
    return mcpJsonRpcErrorResponse(
      readMcpJsonRpcId(payload),
      -32000,
      error instanceof Error ? error.message : String(error)
    );
  }
}

function mcpJsonRpcErrorResponse(
  id: unknown,
  code: number,
  message: string
): Response {
  const payload = {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message
    }
  };
  return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store"
    }
  });
}

function mcpJsonRpcResultResponse(id: unknown, result: unknown): Response {
  const payload = {
    jsonrpc: "2.0",
    id,
    result
  };
  return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store"
    }
  });
}

async function readLocalBurbleChannelMessageBody(
  request: Request,
  routeId: string
): Promise<{
  routeId: string;
  jobId?: string;
  text: string;
  attachments?: ConversationAttachment[];
} | null> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }

  const record = body as Record<string, unknown>;
  const attachments = conversationAttachmentsFrom(record.attachments) ?? undefined;
  if (
    typeof record.text !== "string" ||
    ("attachments" in record &&
      record.attachments !== undefined &&
      !attachments) ||
    (!hasVisibleText(record.text) && !attachments?.length) ||
    record.text.length > 4000
  ) {
    return null;
  }

  const bodyJobId = readOptionalJobId(record);

  return {
    routeId,
    ...(bodyJobId.jobId ? bodyJobId : readOptionalJobIdFromUrl(request)),
    text: record.text,
    ...(attachments?.length ? { attachments } : {})
  };
}

function readLocalBurbleChannelJobId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  return (
    readOptionalJobId(payload as Record<string, unknown>).jobId ?? null
  );
}

function readLocalBurbleChannelUrlJobId(request: Request): string | null {
  return readOptionalJobIdFromUrl(request).jobId ?? null;
}

function readOptionalJobId(record: Record<string, unknown>): { jobId?: string } {
  const names = ["jobId", "job_id"];
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value.trim().length > 0) {
      return { jobId: value.trim() };
    }
  }
  return {};
}

function readOptionalJobIdFromUrl(request: Request): { jobId?: string } {
  const url = new URL(request.url);
  for (const name of ["jobId", "job_id"]) {
    const value = url.searchParams.get(name);
    if (value?.trim()) {
      return { jobId: value.trim() };
    }
  }
  return {};
}

function unresolvedBurbleChannelRouteResponse(): Response {
  return new Response(
    "Burble channel delivery requires a resolved convrt_* route id unless the scheduled job identity is present for grant lookup.",
    { status: 400 }
  );
}

function addRunId(body: unknown, runId: string): unknown {
  if (typeof body !== "object" || body === null) {
    return body;
  }

  const record = body as Record<string, unknown>;
  return {
    ...record,
    ...(record.executionMode === "openclaw-native"
      ? { executionMode: "native-runtime" }
      : {}),
    runId
  };
}

function isRunRequest(body: unknown): body is RunRequest {
  if (typeof body !== "object" || body === null || !("input" in body)) {
    return false;
  }

  const input = body.input;
  if (
    "runId" in body &&
    body.runId !== undefined &&
    (typeof body.runId !== "string" || body.runId.trim().length === 0)
  ) {
    return false;
  }

  if (
    "executionMode" in body &&
    body.executionMode !== undefined &&
    body.executionMode !== "default" &&
    body.executionMode !== "native-runtime"
  ) {
    return false;
  }

  if (
    "runtime" in body &&
    body.runtime !== undefined &&
    !isRuntimeSummary(body.runtime)
  ) {
    return false;
  }

  if (
    typeof input !== "object" ||
    input === null ||
    !("text" in input) ||
    typeof input.text !== "string" ||
    !hasVisibleText(input.text) ||
    !("connections" in input)
  ) {
    return false;
  }

  if (
    "conversation" in input &&
    input.conversation !== undefined &&
    !isConversationSummary(input.conversation)
  ) {
    return false;
  }

  if (
    "context" in input &&
    input.context !== undefined &&
    !isRequestContext(input.context)
  ) {
    return false;
  }

  if (
    "attachments" in input &&
    input.attachments !== undefined &&
    !isConversationAttachmentArray(input.attachments)
  ) {
    return false;
  }

  if (
    "toolGroups" in input &&
    input.toolGroups !== undefined &&
    !isRuntimeToolGroupSelection(input.toolGroups)
  ) {
    return false;
  }

  if (
    "scheduledJob" in input &&
    input.scheduledJob !== undefined &&
    !isScheduledJobContext(input.scheduledJob)
  ) {
    return false;
  }

  const connections = input.connections;
  if (typeof connections !== "object" || connections === null) {
    return false;
  }

  if (
    "github" in connections &&
    connections.github !== undefined &&
    !isConnectionSummary(connections.github)
  ) {
    return false;
  }

  if (
    "google" in connections &&
    connections.google !== undefined &&
    !isConnectionSummary(connections.google)
  ) {
    return false;
  }

  if (
    "jira" in connections &&
    connections.jira !== undefined &&
    !isConnectionSummary(connections.jira)
  ) {
    return false;
  }

  if (
    "hubspot" in connections &&
    connections.hubspot !== undefined &&
    !isConnectionSummary(connections.hubspot)
  ) {
    return false;
  }

  if (
    "slack" in connections &&
    connections.slack !== undefined &&
    !isConnectionSummary(connections.slack)
  ) {
    return false;
  }

  return true;
}

function isScheduledJobContext(
  value: unknown
): value is NonNullable<RunRequest["input"]["scheduledJob"]> {
  return scheduledJobContextSchema.safeParse(value).success;
}

function isRuntimeToolGroupSelection(
  value: unknown
): value is NonNullable<RunRequest["input"]["toolGroups"]> {
  return runtimeToolGroupSelectionSchema.safeParse(value).success;
}

function hasVisibleText(value: string): boolean {
  return value.replace(/[\s\p{Default_Ignorable_Code_Point}]/gu, "").length > 0;
}

function isConnectionSummary(value: unknown): boolean {
  return runtimeConnectionSummarySchema.safeParse(value).success;
}

function isConversationSummary(
  conversation: unknown
): conversation is RunRequest["input"]["conversation"] {
  return runtimeConversationSummarySchema.safeParse(conversation).success;
}

function isRequestContext(context: unknown): context is RunRequest["input"]["context"] {
  return runtimeRequestContextSchema.safeParse(context).success;
}

function isConversationAttachmentArray(
  value: unknown
): value is ConversationAttachment[] {
  return (
    Array.isArray(value) &&
    value.every((attachment) =>
      runtimeConversationAttachmentSchema.safeParse(attachment).success
    )
  );
}

function conversationAttachmentsFrom(
  value: unknown
): ConversationAttachment[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.filter((attachment): attachment is ConversationAttachment =>
    runtimeConversationAttachmentSchema.safeParse(attachment).success
  );
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isRuntimeSummary(runtime: unknown): runtime is RunRequest["runtime"] {
  return (
    typeof runtime === "object" &&
    runtime !== null &&
    "id" in runtime &&
    typeof runtime.id === "string" &&
    runtime.id.trim().length > 0 &&
    (!("policyHash" in runtime) ||
      runtime.policyHash === undefined ||
      (typeof runtime.policyHash === "string" &&
        runtime.policyHash.trim().length > 0)) &&
    (!("manifest" in runtime) ||
      runtime.manifest === undefined ||
      isRuntimeManifestSummary(runtime.manifest))
  );
}

function isRuntimeManifestSummary(
  manifest: unknown
): manifest is NonNullable<RunRequest["runtime"]>["manifest"] {
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("version" in manifest) ||
    typeof manifest.version !== "string" ||
    !("policyHash" in manifest) ||
    typeof manifest.policyHash !== "string" ||
    !("skills" in manifest) ||
    !Array.isArray(manifest.skills) ||
    !("memory" in manifest) ||
    typeof manifest.memory !== "object" ||
    manifest.memory === null
  ) {
    return false;
  }

  const memory = manifest.memory as Record<string, unknown>;
  const streaming =
    "streaming" in manifest ? manifest.streaming : undefined;
  return (
    manifest.skills.every(isRuntimeManifestSkillSummary) &&
    typeof memory.userMemoryEnabled === "boolean" &&
    typeof memory.workspaceMemoryEnabled === "boolean" &&
    typeof memory.jobMemoryEnabled === "boolean" &&
    (streaming === undefined ||
      (typeof streaming === "object" &&
        streaming !== null &&
        typeof (streaming as Record<string, unknown>).messageDeltasEnabled ===
          "boolean")) &&
    (!("tools" in manifest) ||
      manifest.tools === undefined ||
      (Array.isArray(manifest.tools) &&
        manifest.tools.every(isRuntimeManifestToolSummary))) &&
    (!("memoryContext" in manifest) ||
      manifest.memoryContext === undefined ||
      (Array.isArray(manifest.memoryContext) &&
        manifest.memoryContext.every(isRuntimeMemoryContextEntry)))
  );
}

function isRuntimeManifestToolSummary(tool: unknown): boolean {
  if (typeof tool !== "object" || tool === null) {
    return false;
  }
  const record = tool as Record<string, unknown>;
  return (
    typeof record.name === "string" &&
    typeof record.alias === "string" &&
    typeof record.provider === "string" &&
    typeof record.title === "string" &&
    typeof record.description === "string" &&
    typeof record.enabled === "boolean" &&
    typeof record.risk === "string" &&
    typeof record.routeRequired === "boolean" &&
    typeof record.confirmation === "string" &&
    (record.retrySafe === undefined || typeof record.retrySafe === "boolean") &&
    Array.isArray(record.input) &&
    record.input.every(isRuntimeManifestToolInputSummary)
  );
}

function isRuntimeManifestToolInputSummary(input: unknown): boolean {
  if (typeof input !== "object" || input === null) {
    return false;
  }
  const record = input as Record<string, unknown>;
  return (
    typeof record.name === "string" &&
    typeof record.type === "string" &&
    typeof record.required === "boolean" &&
    optionalString(record.description) &&
    (!("values" in record) ||
      record.values === undefined ||
      (Array.isArray(record.values) &&
        record.values.every((value) => typeof value === "string")))
  );
}

function isRuntimeManifestSkillSummary(skill: unknown): boolean {
  return (
    typeof skill === "object" &&
    skill !== null &&
    "id" in skill &&
    typeof skill.id === "string" &&
    skill.id.trim().length > 0 &&
    "version" in skill &&
    typeof skill.version === "string" &&
    skill.version.trim().length > 0 &&
    "enabled" in skill &&
    typeof skill.enabled === "boolean"
  );
}

function isRuntimeMemoryContextEntry(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "scope" in value &&
    (value.scope === "user" ||
      value.scope === "workspace" ||
      value.scope === "job") &&
    "ownerId" in value &&
    typeof value.ownerId === "string" &&
    "key" in value &&
    typeof value.key === "string" &&
    "valuePreview" in value &&
    typeof value.valuePreview === "string" &&
    "updatedAt" in value &&
    typeof value.updatedAt === "string"
  );
}
