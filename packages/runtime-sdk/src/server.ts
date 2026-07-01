import { timingSafeEqual } from "node:crypto";

export type RuntimeEventWebSocket = {
  send: (message: string) => unknown;
  close: (code?: number, reason?: string) => unknown;
};

export type RuntimeContractEvent = {
  type: string;
  [key: string]: unknown;
};

export type RuntimeContractAuthorizer<TContext> =
  | "public"
  | ((
      request: Request,
      context: TContext
    ) => boolean | Promise<boolean>);

export type RuntimeContractServerOptions<
  TContext,
  TRequest,
  TEvent extends RuntimeContractEvent,
  TResponse
> = {
  authorizeRequest: RuntimeContractAuthorizer<TContext>;
  getCapabilityManifest: (context: TContext) => unknown | Promise<unknown>;
  normalizeRunRequest: (
    raw: unknown,
    runId: string,
    context: TContext
  ) => TRequest | null | Promise<TRequest | null>;
  streamRun: (
    request: TRequest,
    context: TContext
  ) => AsyncIterable<TEvent>;
  responseFromEvent: (
    event: TEvent,
    context: TContext
  ) => TResponse | null | undefined;
  errorMessageFromEvent?: (event: TEvent) => string | null | undefined;
  formatError?: (error: unknown) => string;
  completedRunTtlMs?: number;
  createRunId?: () => string;
};

export type RuntimeContractServer<
  TContext,
  TRequest,
  TEvent extends RuntimeContractEvent,
  TResponse
> = {
  handleRequest: (
    request: Request,
    context: TContext,
    options?: {
      upgradeWebSocket?: (runId: string) => boolean;
    }
  ) => Promise<Response | null>;
  attachEventWebSocket: (runId: string, ws: RuntimeEventWebSocket) => void;
};

type SharedRun<TEvent extends RuntimeContractEvent, TResponse> = {
  runId: string;
  events: TEvent[];
  subscribers: Set<() => void>;
  completed: boolean;
  finalPromise: Promise<TResponse>;
};

export function createRuntimeContractServer<
  TContext,
  TRequest,
  TEvent extends RuntimeContractEvent,
  TResponse
>(
  input: RuntimeContractServerOptions<TContext, TRequest, TEvent, TResponse>
): RuntimeContractServer<TContext, TRequest, TEvent, TResponse> {
  const sharedRuns = new Map<string, SharedRun<TEvent, TResponse>>();
  const completedRunTtlMs = input.completedRunTtlMs ?? 5 * 60 * 1000;
  const createRunId = input.createRunId ?? (() => crypto.randomUUID());
  const formatError = input.formatError ?? defaultFormatRuntimeError;
  const errorMessageFromEvent =
    input.errorMessageFromEvent ?? defaultErrorMessageFromEvent;

  function getOrStartSharedRun(
    runId: string,
    context: TContext,
    createEvents: () => AsyncIterable<TEvent>
  ): SharedRun<TEvent, TResponse> {
    const existing = sharedRuns.get(runId);
    if (existing) {
      return existing;
    }

    const sharedRun: SharedRun<TEvent, TResponse> = {
      runId,
      events: [],
      subscribers: new Set(),
      completed: false,
      finalPromise: Promise.reject(
        new Error("Runtime run has not started")
      ) as Promise<TResponse>
    };

    sharedRun.finalPromise.catch(() => undefined);
    sharedRun.finalPromise = consumeSharedRun({
      runId,
      context,
      sharedRun,
      events: createEvents(),
      responseFromEvent: input.responseFromEvent,
      errorMessageFromEvent,
      formatError,
      completedRunTtlMs,
      sharedRuns
    });
    sharedRun.finalPromise.catch(() => undefined);
    sharedRuns.set(runId, sharedRun);
    return sharedRun;
  }

  return {
    async handleRequest(request, context, options = {}) {
      const url = new URL(request.url);

      if (url.pathname === "/healthz") {
        return new Response("ok");
      }

      if (
        protectedRuntimeContractPath(url.pathname) &&
        !(await isRuntimeContractRequestAuthorized({
          authorizer: input.authorizeRequest,
          request,
          context
        }))
      ) {
        return new Response("Unauthorized", {
          status: 401,
          headers: {
            "www-authenticate": "Bearer"
          }
        });
      }

      if (url.pathname === "/capabilities") {
        if (request.method !== "GET") {
          return new Response("Method not allowed", { status: 405 });
        }
        return Response.json(await input.getCapabilityManifest(context), {
          headers: noStoreHeaders()
        });
      }

      const runEventMatch = /^\/runs\/([^/]+)\/events$/.exec(url.pathname);
      if (runEventMatch) {
        if (request.method !== "GET") {
          return new Response("Method not allowed", { status: 405 });
        }
        if (!options.upgradeWebSocket?.(decodeURIComponent(runEventMatch[1] ?? ""))) {
          return new Response("WebSocket upgrade failed", { status: 400 });
        }
        return undefined as unknown as Response;
      }

      if (url.pathname === "/runs/validate") {
        if (request.method !== "POST") {
          return new Response("Method not allowed", { status: 405 });
        }
        const rawBody = await readJsonBody(request);
        const runId = readRunId(rawBody) ?? createRunId();
        const body = await input.normalizeRunRequest(rawBody, runId, context);
        if (!body) {
          return new Response("Invalid run request", { status: 400 });
        }
        return Response.json({ ok: true, runId }, { headers: noStoreHeaders() });
      }

      const runSnapshotMatch = /^\/runs\/([^/]+)$/.exec(url.pathname);
      if (runSnapshotMatch) {
        if (request.method !== "GET") {
          return new Response("Method not allowed", { status: 405 });
        }
        const sharedRun = sharedRuns.get(
          decodeURIComponent(runSnapshotMatch[1] ?? "")
        );
        if (!sharedRun) {
          return new Response("Run not found", { status: 404 });
        }
        return Response.json(await sharedRun.finalPromise, {
          headers: noStoreHeaders()
        });
      }

      if (url.pathname !== "/runs") {
        return null;
      }

      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }

      const rawBody = await readJsonBody(request);
      const runId = readRunId(rawBody) ?? createRunId();
      const body = await input.normalizeRunRequest(rawBody, runId, context);
      if (!body) {
        return new Response("Invalid run request", { status: 400 });
      }

      const sharedRun = getOrStartSharedRun(runId, context, () =>
        input.streamRun(body, context)
      );

      if (prefersAsyncStart(request)) {
        return Response.json(
          { runId, eventsUrl: `/runs/${encodeURIComponent(runId)}/events` },
          { headers: noStoreHeaders() }
        );
      }

      if (acceptsEventStream(request)) {
        return streamSseRunResponse(
          subscribeSharedRun(sharedRun),
          runId,
          formatError
        );
      }

      if (acceptsNdjson(request)) {
        return streamNdjsonRunResponse(
          subscribeSharedRun(sharedRun),
          runId,
          formatError
        );
      }

      return Response.json(await sharedRun.finalPromise, {
        headers: noStoreHeaders()
      });
    },

    attachEventWebSocket(runId, ws) {
      const sharedRun = sharedRuns.get(runId);
      if (!sharedRun) {
        ws.send(
          JSON.stringify({
            type: "error",
            message: "Run not found"
          })
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
              message: `Runtime run failed: ${formatError(error)}`
            })
          );
          ws.close(1011, "Run failed");
        }
      })();
    }
  };
}

export function authorizeRuntimeBearerToken(
  request: Request,
  expectedToken: string | null | undefined
): boolean {
  if (!expectedToken) {
    return false;
  }
  const actualToken = readBearerToken(request);
  if (!actualToken) {
    return false;
  }
  return timingSafeTokenEqual(actualToken, expectedToken);
}

export function authorizeRuntimeBearerOrHeaderToken(
  request: Request,
  expectedToken: string | null | undefined,
  headerName = "x-burble-runtime-token"
): boolean {
  if (authorizeRuntimeBearerToken(request, expectedToken)) {
    return true;
  }
  if (!expectedToken) {
    return false;
  }
  const actualToken = request.headers.get(headerName)?.trim();
  if (!actualToken) {
    return false;
  }
  return timingSafeTokenEqual(actualToken, expectedToken);
}

function protectedRuntimeContractPath(pathname: string): boolean {
  return (
    pathname === "/runs" ||
    pathname === "/runs/validate" ||
    /^\/runs\/[^/]+(?:\/events)?$/.test(pathname)
  );
}

async function isRuntimeContractRequestAuthorized<TContext>(input: {
  authorizer: RuntimeContractAuthorizer<TContext>;
  request: Request;
  context: TContext;
}): Promise<boolean> {
  if (input.authorizer === "public") {
    return true;
  }
  try {
    return await input.authorizer(input.request, input.context);
  } catch {
    return false;
  }
}

function readBearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    const token = authorization.slice("Bearer ".length).trim();
    return token.length > 0 ? token : null;
  }
  return null;
}

function timingSafeTokenEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

async function consumeSharedRun<
  TContext,
  TEvent extends RuntimeContractEvent,
  TResponse
>(input: {
  runId: string;
  context: TContext;
  sharedRun: SharedRun<TEvent, TResponse>;
  events: AsyncIterable<TEvent>;
  responseFromEvent: (
    event: TEvent,
    context: TContext
  ) => TResponse | null | undefined;
  errorMessageFromEvent: (event: TEvent) => string | null | undefined;
  formatError: (error: unknown) => string;
  completedRunTtlMs: number;
  sharedRuns: Map<string, SharedRun<TEvent, TResponse>>;
}): Promise<TResponse> {
  try {
    for await (const event of input.events) {
      publishSharedRunEvent(input.sharedRun, event);
      const errorMessage = input.errorMessageFromEvent(event);
      if (errorMessage) {
        throw new Error(errorMessage);
      }
      const response = input.responseFromEvent(event, input.context);
      if (response) {
        return response;
      }
    }

    throw new Error("Runtime run finished without a final response");
  } catch (error) {
    const message = input.formatError(error);
    console.error(
      `[ERROR] ${new Date().toISOString()} Runtime run failed runId=${input.runId} error=${message}`
    );
    publishSharedRunEvent(input.sharedRun, {
      type: "error",
      message: `Runtime run failed: ${message}`
    } as unknown as TEvent);
    throw error;
  } finally {
    input.sharedRun.completed = true;
    for (const subscriber of input.sharedRun.subscribers) {
      subscriber();
    }
    const cleanupTimer = setTimeout(() => {
      if (input.sharedRuns.get(input.runId) === input.sharedRun) {
        input.sharedRuns.delete(input.runId);
      }
    }, input.completedRunTtlMs);
    cleanupTimer.unref?.();
  }
}

function publishSharedRunEvent<TEvent extends RuntimeContractEvent>(
  sharedRun: SharedRun<TEvent, unknown>,
  event: TEvent
): void {
  sharedRun.events.push(event);
  for (const subscriber of sharedRun.subscribers) {
    subscriber();
  }
}

async function* subscribeSharedRun<TEvent extends RuntimeContractEvent>(
  sharedRun: SharedRun<TEvent, unknown>
): AsyncIterable<TEvent> {
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

function streamSseRunResponse<TEvent extends RuntimeContractEvent>(
  events: AsyncIterable<TEvent>,
  runId: string,
  formatError: (error: unknown) => string
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

          const message = formatError(error);
          console.error(
            `[ERROR] ${new Date().toISOString()} Runtime run failed runId=${runId} error=${message}`
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

function streamNdjsonRunResponse<TEvent extends RuntimeContractEvent>(
  events: AsyncIterable<TEvent>,
  runId: string,
  formatError: (error: unknown) => string
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

          const message = formatError(error);
          console.error(
            `[ERROR] ${new Date().toISOString()} Runtime run failed runId=${runId} error=${message}`
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
  event: RuntimeContractEvent,
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

async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function readRunId(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const runId = (body as { runId?: unknown }).runId;
  return typeof runId === "string" && runId.trim().length > 0 ? runId : null;
}

function noStoreHeaders(): Headers {
  return new Headers({
    "cache-control": "no-store"
  });
}

function defaultErrorMessageFromEvent(event: RuntimeContractEvent): string | null {
  const message = (event as { message?: unknown }).message;
  return event.type === "error" && typeof message === "string" ? message : null;
}

function defaultFormatRuntimeError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "unknown error";
}
