import { createHash, randomUUID } from "node:crypto";

type ForwarderDeps = {
  apiKey: string;
  fetch?: (request: Request) => Promise<Response>;
  log?: (message: string) => void;
};

export async function forwardOpenAiRequest(
  request: Request,
  deps: ForwarderDeps
): Promise<Response> {
  const startedAt = Date.now();
  const body = request.method === "GET" || request.method === "HEAD"
    ? undefined
    : await request.arrayBuffer();
  const bodySummary = summarizeBody(body);
  const correlationId = bodySummary.correlationId;
  const callId = randomUUID();
  const log = deps.log ?? console.log;
  logBoundary(log, {
    event: "request_received",
    callId,
    correlationId,
    method: request.method,
    path: new URL(request.url).pathname,
    requestKeys: bodySummary.requestKeys,
    metadataKeys: bodySummary.metadataKeys
  });

  const target = new URL(request.url);
  target.protocol = "https:";
  target.host = "api.openai.com";
  target.port = "";
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("content-length");
  headers.set("authorization", `Bearer ${deps.apiKey}`);

  try {
    const upstream = await (deps.fetch ?? fetch)(
      new Request(target, {
        method: request.method,
        headers,
        body
      })
    );
    logBoundary(log, {
      event: upstream.ok ? "provider_success" : "provider_failure",
      callId,
      correlationId,
      status: upstream.status,
      elapsedMs: Date.now() - startedAt,
      providerRequestId: upstream.headers.get("x-request-id")
    });
    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.delete("content-length");
    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders
    });
  } catch (error) {
    logBoundary(log, {
      event: "transport_failure",
      callId,
      correlationId,
      elapsedMs: Date.now() - startedAt,
      errorType: error instanceof Error ? error.name : "UnknownError"
    });
    throw error;
  }
}

function summarizeBody(body: ArrayBuffer | undefined): {
  correlationId: string | null;
  requestKeys: string[];
  metadataKeys: string[];
} {
  if (!body) {
    return { correlationId: null, requestKeys: [], metadataKeys: [] };
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as Record<
      string,
      unknown
    > & {
      prompt_cache_key?: unknown;
      metadata?: { burble_correlation_id?: unknown };
    };
    const requestKeys = Object.keys(parsed).sort();
    const metadataKeys = parsed.metadata && typeof parsed.metadata === "object"
      ? Object.keys(parsed.metadata).sort()
      : [];
    const explicit = parsed.metadata?.burble_correlation_id;
    if (typeof explicit === "string" && /^[a-f0-9]{16}$/i.test(explicit)) {
      return {
        correlationId: explicit.toLowerCase(),
        requestKeys,
        metadataKeys
      };
    }
    if (typeof parsed.prompt_cache_key !== "string") {
      return { correlationId: null, requestKeys, metadataKeys };
    }
    const prefix = Array.from(parsed.prompt_cache_key).slice(0, 64).join("");
    return {
      correlationId: createHash("sha256")
        .update(prefix)
        .digest("hex")
        .slice(0, 16),
      requestKeys,
      metadataKeys
    };
  } catch {
    return { correlationId: null, requestKeys: [], metadataKeys: [] };
  }
}

function logBoundary(
  log: (message: string) => void,
  fields: Record<string, unknown>
): void {
  log(
    `burble_openai_direct_boundary ${JSON.stringify({
      schema: "burble.llm_boundary.v1",
      component: "openai-direct-forwarder",
      timestamp: new Date().toISOString(),
      ...fields
    })}`
  );
}

if (import.meta.main) {
  const apiKey = Bun.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required");
  }
  const port = Number.parseInt(Bun.env.PORT ?? "4100", 10);
  Bun.serve({
    port,
    fetch(request) {
      if (new URL(request.url).pathname === "/healthz") {
        return new Response("ok");
      }
      return forwardOpenAiRequest(request, { apiKey });
    }
  });
  console.log(`OpenAI direct forwarder listening on http://0.0.0.0:${port}`);
}
