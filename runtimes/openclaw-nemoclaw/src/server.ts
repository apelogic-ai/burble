import type { RuntimeConfig } from "./config";
import { createRuntimeRunner } from "./runtime";
import type { RunEvent, RunRequest, RunResponse, ToolExecutor } from "./types";

type SharedRun = {
  events: RunEvent[];
  subscribers: Set<() => void>;
  completed: boolean;
  finalPromise: Promise<RunResponse>;
};

const sharedRuns = new Map<string, SharedRun>();

export async function handleRuntimeRequest(
  request: Request,
  config: RuntimeConfig,
  executeTool?: ToolExecutor
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/healthz") {
    return new Response("ok");
  }

  if (url.pathname !== "/runs") {
    return new Response("Not found", { status: 404 });
  }

  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const body = await readRunRequest(request);
  if (!body || !isRunRequest(body)) {
    return new Response("Invalid run request", { status: 400 });
  }

  const runner = createRuntimeRunner(config);
  const sharedRun = body.runId
    ? getOrStartSharedRun(body.runId, () =>
        runner.stream(body, executeTool)
      )
    : null;

  if (acceptsNdjson(request)) {
    return streamRunResponse(
      sharedRun ? subscribeSharedRun(sharedRun) : runner.stream(body, executeTool),
      body.runId
    );
  }

  const result = sharedRun
    ? await sharedRun.finalPromise
    : await runner.run(body, executeTool);
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
    queueMicrotask(() => {
      sharedRuns.delete(runId);
    });
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

function acceptsNdjson(request: Request): boolean {
  return (request.headers.get("accept") ?? "")
    .split(",")
    .some((value) => value.trim().toLowerCase().startsWith("application/x-ndjson"));
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

function enqueueNdjson(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  event: unknown,
  isCancelled: () => boolean
): boolean {
  if (isCancelled()) {
    return false;
  }

  try {
    controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
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
    return error.message;
  }

  return "unknown error";
}

async function readRunRequest(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
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
