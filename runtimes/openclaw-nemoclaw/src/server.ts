import type { RuntimeConfig, RuntimeEngine } from "./config";
import { createBurbleConversationConnector } from "./burble-conversation-connector";
import { info } from "./logger";
import { createRuntimeRunner } from "./runtime";
import type {
  ConversationAttachment,
  RunEvent,
  RunRequest,
  RunResponse,
  ToolExecutor
} from "./types";

type SharedRun = {
  runId: string;
  events: RunEvent[];
  subscribers: Set<() => void>;
  completed: boolean;
  finalPromise: Promise<RunResponse>;
};

const sharedRuns = new Map<string, SharedRun>();
const completedRunTtlMs = 5 * 60 * 1000;
const runtimeToolGroups = new Set([
  "attachments",
  "conversation",
  "github",
  "google",
  "jira",
  "scheduler",
  "slack"
]);

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

  if (url.pathname === "/healthz") {
    return new Response("ok");
  }

  if (url.pathname === "/capabilities") {
    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405 });
    }

    return Response.json(buildRuntimeCapabilityManifest(config), {
      headers: {
        "cache-control": "no-store"
      }
    });
  }

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

  const runEventMatch = /^\/runs\/([^/]+)\/events$/.exec(url.pathname);
  if (runEventMatch) {
    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405 });
    }

    if (!options.upgradeWebSocket?.(decodeURIComponent(runEventMatch[1]))) {
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    return undefined as unknown as Response;
  }

  const runSnapshotMatch = /^\/runs\/([^/]+)$/.exec(url.pathname);
  if (runSnapshotMatch) {
    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405 });
    }

    const sharedRun = sharedRuns.get(decodeURIComponent(runSnapshotMatch[1]));
    if (!sharedRun) {
      return new Response("Run not found", { status: 404 });
    }

    const result = await sharedRun.finalPromise;
    return Response.json(result, {
      headers: {
        "cache-control": "no-store"
      }
    });
  }

  if (url.pathname !== "/runs") {
    return new Response("Not found", { status: 404 });
  }

  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const rawBody = await readRunRequest(request);
  const runId =
    isObjectWithRunId(rawBody) && typeof rawBody.runId === "string"
      ? rawBody.runId
      : crypto.randomUUID();
  const body = addRunId(rawBody, runId);
  if (!body || !isRunRequest(body)) {
    return new Response("Invalid run request", { status: 400 });
  }

  const runner = createRuntimeRunner(config, {
    ...(options.prepareNativeOpenClaw
      ? { prepareNativeOpenClaw: options.prepareNativeOpenClaw }
      : {})
  });
  const sharedRun = getOrStartSharedRun(runId, () =>
    runner.stream(body, executeTool)
  );

  if (prefersAsyncStart(request)) {
    return Response.json(
      { runId, eventsUrl: `/runs/${encodeURIComponent(runId)}/events` },
      {
        headers: {
          "cache-control": "no-store"
        }
      }
    );
  }

  if (acceptsEventStream(request)) {
    return streamSseRunResponse(
      subscribeSharedRun(sharedRun),
      runId
    );
  }

  if (acceptsNdjson(request)) {
    return streamRunResponse(
      subscribeSharedRun(sharedRun),
      runId
    );
  }

  const result = await sharedRun.finalPromise;
  return Response.json(result, {
    headers: {
      "cache-control": "no-store"
    }
  });
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
  if (!config.mcpGatewayUrl || !config.runtimeJwt) {
    return new Response("Burble MCP gateway is not configured", { status: 503 });
  }

  const bodyText = await request.text();
  const payload = readMcpJsonRpcPayload(bodyText);
  if (isMcpToolCall(payload)) {
    const routeId = readMcpToolCallRouteId(payload);
    if (!routeId) {
      return mcpJsonRpcErrorResponse(
        readMcpJsonRpcId(payload),
        -32602,
        "Burble provider tools require a routeId argument."
      );
    }
    if (!isBurbleConversationRouteId(routeId)) {
      return mcpJsonRpcErrorResponse(
        readMcpJsonRpcId(payload),
        -32602,
        "Burble provider tool routeId must be the active convrt_* conversation route, not a cron job id, run id, session id, or UUID."
      );
    }
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
  const connector = createBurbleConversationConnector(config, config.runtimeId);
  const result = await connector.deliverEvent({ routeId, payload });
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

function getOrStartSharedRun(
  runId: string,
  createEvents: () => AsyncIterable<RunEvent>
): SharedRun {
  const existing = sharedRuns.get(runId);
  if (existing) {
    return existing;
  }

  const sharedRun: SharedRun = {
    runId,
    events: [],
    subscribers: new Set(),
    completed: false,
    finalPromise: Promise.resolve({
      response: {
        classification: "user_private",
        text: ""
      }
    })
  };

  sharedRun.finalPromise = consumeSharedRun(runId, sharedRun, createEvents());
  sharedRun.finalPromise.catch(() => undefined);
  sharedRuns.set(runId, sharedRun);
  return sharedRun;
}

export type RuntimeEventWebSocket = {
  send: (message: string) => unknown;
  close: (code?: number, reason?: string) => unknown;
};

export function attachRuntimeEventWebSocket(
  runId: string,
  ws: RuntimeEventWebSocket
): void {
  const sharedRun = sharedRuns.get(runId);
  if (!sharedRun) {
    ws.send(
      JSON.stringify({
        type: "error",
        message: "Run not found"
      } satisfies RunEvent)
    );
    ws.close(1008, "Run not found");
    return;
  }

  void (async () => {
    try {
      for await (const event of subscribeSharedRun(sharedRun)) {
        ws.send(JSON.stringify(event));
      }
      ws.close(1000, "Run complete");
    } catch (error) {
      ws.send(
        JSON.stringify({
          type: "error",
          message: `Runtime run failed: ${formatRuntimeError(error)}`
        } satisfies RunEvent)
      );
      ws.close(1011, "Run failed");
    }
  })();
}

async function consumeSharedRun(
  runId: string,
  sharedRun: SharedRun,
  events: AsyncIterable<RunEvent>
): Promise<RunResponse> {
  try {
    for await (const event of events) {
      publishSharedRunEvent(sharedRun, event);
      if (event.type === "error") {
        throw new Error(event.message);
      }
      if (event.type === "final") {
        return { response: event.response };
      }
    }

    throw new Error("Runtime run finished without a final response");
  } catch (error) {
    const message = formatRuntimeError(error);
    console.error(
      `[ERROR] ${new Date().toISOString()} Runtime run failed runId=${runId} error=${message}`
    );
    publishSharedRunEvent(sharedRun, {
      type: "error",
      message: `Runtime run failed: ${message}`
    });
    throw error;
  } finally {
    sharedRun.completed = true;
    for (const subscriber of sharedRun.subscribers) {
      subscriber();
    }
    const cleanupTimer = setTimeout(() => {
      if (sharedRuns.get(runId) === sharedRun) {
        sharedRuns.delete(runId);
      }
    }, completedRunTtlMs);
    cleanupTimer.unref?.();
  }
}

function publishSharedRunEvent(sharedRun: SharedRun, event: RunEvent): void {
  sharedRun.events.push(event);
  for (const subscriber of sharedRun.subscribers) {
    subscriber();
  }
}

async function* subscribeSharedRun(
  sharedRun: SharedRun
): AsyncIterable<RunEvent> {
  let offset = 0;
  let wake: (() => void) | undefined;
  const subscriber = () => {
    wake?.();
  };

  sharedRun.subscribers.add(subscriber);
  try {
    while (true) {
      while (offset < sharedRun.events.length) {
        yield sharedRun.events[offset];
        offset += 1;
      }

      if (sharedRun.completed) {
        return;
      }

      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = undefined;
    }
  } finally {
    sharedRun.subscribers.delete(subscriber);
  }
}

function acceptsEventStream(request: Request): boolean {
  return (request.headers.get("accept") ?? "")
    .split(",")
    .some((value) => value.trim().toLowerCase().startsWith("text/event-stream"));
}

function acceptsNdjson(request: Request): boolean {
  return (request.headers.get("accept") ?? "")
    .split(",")
    .some((value) => value.trim().toLowerCase().startsWith("application/x-ndjson"));
}

function prefersAsyncStart(request: Request): boolean {
  return (request.headers.get("prefer") ?? "")
    .split(",")
    .some((value) => value.trim().toLowerCase() === "respond-async");
}

function streamSseRunResponse(
  events: AsyncIterable<RunEvent>,
  runId?: string
): Response {
  const encoder = new TextEncoder();
  let cancelled = false;

  return new Response(
    new ReadableStream({
      async start(controller) {
        enqueueSseComment(controller, encoder, "stream-start", () => cancelled);
        try {
          for await (const event of events) {
            if (
              !enqueueSseEvent(controller, encoder, event, () => cancelled)
            ) {
              return;
            }
          }
        } catch (error) {
          if (isClosedStreamError(error) || cancelled) {
            return;
          }

          const message = formatRuntimeError(error);
          console.error(
            `[ERROR] ${new Date().toISOString()} Runtime run failed runId=${runId ?? "unknown"} error=${message}`
          );
          enqueueSseEvent(
            controller,
            encoder,
            {
              type: "error",
              message: `Runtime run failed: ${message}`
            },
            () => cancelled
          );
        } finally {
          closeStream(controller);
        }
      },
      cancel() {
        cancelled = true;
      }
    }),
    {
      headers: {
        "cache-control": "no-store",
        "connection": "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no"
      }
    }
  );
}

function streamRunResponse(
  events: AsyncIterable<unknown>,
  runId?: string
): Response {
  const encoder = new TextEncoder();
  let cancelled = false;

  return new Response(
    new ReadableStream({
      async start(controller) {
        try {
          for await (const event of events) {
            if (
              !enqueueNdjson(controller, encoder, event, () => cancelled)
            ) {
              return;
            }
          }
        } catch (error) {
          if (isClosedStreamError(error) || cancelled) {
            return;
          }

          const message = formatRuntimeError(error);
          console.error(
            `[ERROR] ${new Date().toISOString()} Runtime run failed runId=${runId ?? "unknown"} error=${message}`
          );
          enqueueNdjson(
            controller,
            encoder,
            {
              type: "error",
              message: `Runtime run failed: ${message}`
            },
            () => cancelled
          );
        } finally {
          closeStream(controller);
        }
      },
      cancel() {
        cancelled = true;
      }
    }),
    {
      headers: {
        "cache-control": "no-store",
        "content-type": "application/x-ndjson; charset=utf-8"
      }
    }
  );
}

function enqueueSseEvent(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  event: RunEvent,
  isCancelled: () => boolean
): boolean {
  return enqueueText(
    controller,
    encoder,
    `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
    isCancelled
  );
}

function enqueueSseComment(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  comment: string,
  isCancelled: () => boolean
): boolean {
  return enqueueText(controller, encoder, `: ${comment}\n\n`, isCancelled);
}

function enqueueNdjson(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  event: unknown,
  isCancelled: () => boolean
): boolean {
  return enqueueText(
    controller,
    encoder,
    `${JSON.stringify(event)}\n`,
    isCancelled
  );
}

function enqueueText(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  text: string,
  isCancelled: () => boolean
): boolean {
  if (isCancelled()) {
    return false;
  }

  try {
    controller.enqueue(encoder.encode(text));
    return true;
  } catch (error) {
    if (isClosedStreamError(error)) {
      return false;
    }
    throw error;
  }
}

function closeStream(
  controller: ReadableStreamDefaultController<Uint8Array>
): void {
  try {
    controller.close();
  } catch (error) {
    if (!isClosedStreamError(error)) {
      throw error;
    }
  }
}

function isClosedStreamError(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    /controller is already closed|invalid state/i.test(error.message)
  );
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

async function readRunRequest(request: Request): Promise<unknown> {
  return readJsonBody(request);
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
  const attachments = isConversationAttachmentArray(record.attachments)
    ? record.attachments
    : undefined;
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

function isBurbleConversationRouteId(routeId: string): boolean {
  return /^convrt_[A-Za-z0-9_-]+$/.test(routeId);
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
      tools: tools.map(addRouteIdToMcpToolSchema)
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
          pattern: "^convrt_[A-Za-z0-9_-]+$",
          description:
            "Exact Burble convrt_* conversation route id for this Slack conversation. Never use a cron job id, run id, session id, or UUID."
        }
      },
      required: Array.from(new Set([...required, "routeId"]))
    }
  };
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

async function readLocalBurbleChannelMessageBody(
  request: Request,
  routeId: string
): Promise<{
  routeId: string;
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
  const attachments = isConversationAttachmentArray(record.attachments)
    ? record.attachments
    : undefined;
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

  return {
    routeId,
    text: record.text,
    ...(attachments?.length ? { attachments } : {})
  };
}

function addRunId(body: unknown, runId: string): unknown {
  if (typeof body !== "object" || body === null) {
    return body;
  }

  return {
    ...body,
    runId
  };
}

function isObjectWithRunId(body: unknown): body is { runId?: unknown } {
  return typeof body === "object" && body !== null && "runId" in body;
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
    body.executionMode !== "native-runtime" &&
    body.executionMode !== "openclaw-native"
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
  if (
    typeof connections !== "object" ||
    connections === null ||
    !("github" in connections)
  ) {
    return false;
  }

  const github = connections.github;
  if (!isConnectionSummary(github)) {
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
    "slack" in connections &&
    connections.slack !== undefined &&
    !isConnectionSummary(connections.slack)
  ) {
    return false;
  }

  return true;
}

const runtimeEngines = new Set([
  "deterministic",
  "openclaw",
  "openclaw-gateway",
  "burble-direct",
  "hermes"
]);

function isScheduledJobContext(
  value: unknown
): value is NonNullable<RunRequest["input"]["scheduledJob"]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.jobId === "string" &&
    record.jobId.trim().length > 0 &&
    typeof record.capabilityProfile === "string" &&
    record.capabilityProfile.trim().length > 0 &&
    Array.isArray(record.allowedTools) &&
    record.allowedTools.length > 0 &&
    record.allowedTools.every((toolName) => typeof toolName === "string") &&
    (!("routeId" in record) ||
      record.routeId === undefined ||
      (typeof record.routeId === "string" &&
        record.routeId.trim().length > 0)) &&
    (!("runtimeType" in record) ||
      record.runtimeType === undefined ||
      (typeof record.runtimeType === "string" &&
        runtimeEngines.has(record.runtimeType))) &&
    Array.isArray(record.stateRefs) &&
    record.stateRefs.every(isScheduledJobStateRef) &&
    isScheduledJobVisibilityPolicy(record.visibilityPolicy)
  );
}

function isScheduledJobStateRef(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.provider === "string" &&
    record.provider.trim().length > 0 &&
    typeof record.kind === "string" &&
    record.kind.trim().length > 0 &&
    optionalString(record.id) &&
    optionalString(record.name) &&
    optionalString(record.purpose)
  );
}

function isScheduledJobVisibilityPolicy(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    (!("maxOutputVisibility" in record) ||
      record.maxOutputVisibility === undefined ||
      record.maxOutputVisibility === "public" ||
      record.maxOutputVisibility === "user_private" ||
      record.maxOutputVisibility === "restricted") &&
    (!("allowPrivateToolDeclassification" in record) ||
      record.allowPrivateToolDeclassification === undefined ||
      typeof record.allowPrivateToolDeclassification === "boolean")
  );
}

function isRuntimeToolGroupSelection(
  value: unknown
): value is NonNullable<RunRequest["input"]["toolGroups"]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    Array.isArray(record.groups) &&
    record.groups.every(
      (group) => typeof group === "string" && runtimeToolGroups.has(group)
    ) &&
    Array.isArray(record.reasons) &&
    record.reasons.every((reason) => typeof reason === "string")
  );
}

function hasVisibleText(value: string): boolean {
  return value.replace(/[\s\p{Default_Ignorable_Code_Point}]/gu, "").length > 0;
}

function isConnectionSummary(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "connected" in value &&
    typeof value.connected === "boolean"
  );
}

function isConversationSummary(
  conversation: unknown
): conversation is RunRequest["input"]["conversation"] {
  return (
    typeof conversation === "object" &&
    conversation !== null &&
    "source" in conversation &&
    conversation.source === "slack" &&
    (!("routeId" in conversation) ||
      conversation.routeId === undefined ||
      (typeof conversation.routeId === "string" &&
        conversation.routeId.trim().length > 0)) &&
    "workspaceId" in conversation &&
    typeof conversation.workspaceId === "string" &&
    conversation.workspaceId.trim().length > 0 &&
    "channelId" in conversation &&
    typeof conversation.channelId === "string" &&
    conversation.channelId.trim().length > 0 &&
    "rootId" in conversation &&
    typeof conversation.rootId === "string" &&
    conversation.rootId.trim().length > 0 &&
    "isDirectMessage" in conversation &&
    typeof conversation.isDirectMessage === "boolean"
  );
}

function isRequestContext(context: unknown): context is RunRequest["input"]["context"] {
  if (
    typeof context !== "object" ||
    context === null ||
    !("recentMessages" in context) ||
    !Array.isArray(context.recentMessages)
  ) {
    return false;
  }

  if (
    "currentChannel" in context &&
    context.currentChannel !== undefined &&
    !isCurrentChannelContext(context.currentChannel)
  ) {
    return false;
  }

  return context.recentMessages.every(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      "author" in message &&
      (message.author === "user" || message.author === "assistant") &&
      (!("speaker" in message) ||
        message.speaker === undefined ||
        typeof message.speaker === "string") &&
      "text" in message &&
      typeof message.text === "string"
  );
}

function isCurrentChannelContext(channel: unknown): boolean {
  return (
    typeof channel === "object" &&
    channel !== null &&
    "id" in channel &&
    typeof channel.id === "string" &&
    "isDirectMessage" in channel &&
    typeof channel.isDirectMessage === "boolean" &&
    "historyAvailable" in channel &&
    typeof channel.historyAvailable === "boolean" &&
    (!("historyError" in channel) ||
      channel.historyError === undefined ||
      typeof channel.historyError === "string")
  );
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
  return (
    manifest.skills.every(isRuntimeManifestSkillSummary) &&
    typeof memory.userMemoryEnabled === "boolean" &&
    typeof memory.workspaceMemoryEnabled === "boolean" &&
    typeof memory.jobMemoryEnabled === "boolean" &&
    (!("memoryContext" in manifest) ||
      manifest.memoryContext === undefined ||
      (Array.isArray(manifest.memoryContext) &&
        manifest.memoryContext.every(isRuntimeMemoryContextEntry)))
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
