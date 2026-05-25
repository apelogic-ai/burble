import type { RuntimeConfig } from "./config";
import { createRuntimeRunner } from "./runtime";
import type { RunEvent, RunRequest, RunResponse, ToolExecutor } from "./types";

type SharedRun = {
  runId: string;
  events: RunEvent[];
  subscribers: Set<() => void>;
  completed: boolean;
  finalPromise: Promise<RunResponse>;
};

const sharedRuns = new Map<string, SharedRun>();
const completedRunTtlMs = 5 * 60 * 1000;

export async function handleRuntimeRequest(
  request: Request,
  config: RuntimeConfig,
  executeTool?: ToolExecutor,
  options: {
    upgradeWebSocket?: (runId: string) => boolean;
  } = {}
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/healthz") {
    return new Response("ok");
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

  const runner = createRuntimeRunner(config);
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
      return "OpenClaw model provider quota is exhausted. Update OPENAI_API_KEY billing/quota or switch the OpenClaw model config to a provider/model with available quota.";
    }
    return error.message;
  }

  return "unknown error";
}

function isModelQuotaError(message: string): boolean {
  return /insufficient_quota|exceeded your current quota/i.test(message);
}

async function readRunRequest(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
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
    input.text.trim().length === 0 ||
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
    "jira" in connections &&
    connections.jira !== undefined &&
    !isConnectionSummary(connections.jira)
  ) {
    return false;
  }

  return true;
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

function isRuntimeSummary(runtime: unknown): runtime is RunRequest["runtime"] {
  return (
    typeof runtime === "object" &&
    runtime !== null &&
    "id" in runtime &&
    typeof runtime.id === "string" &&
    runtime.id.trim().length > 0
  );
}
