import {
  parseRuntimeRunRequest,
  type RuntimeFinalResponse
} from "@burble/runtime-sdk/runtime-contract";
import {
  createRuntimeContractServer,
  type RuntimeEventWebSocket
} from "@burble/runtime-sdk/server";
import type {
  CapabilityManifest,
  RunEvent,
  RunRequest,
  RunResponse,
  RunUsage
} from "./types";

type RuntimeServerContext = {
  env?: Record<string, string | undefined>;
  fetch?: RuntimeFetch;
};

type RuntimeRequestOptions = RuntimeServerContext;
type RuntimeFetch = (url: string, init?: RequestInit) => Promise<Response>;
type StreamReadResult = Awaited<
  ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>
>;

const DEFAULT_PROVIDER_TIMEOUT_MS = 120_000;
const MIN_PROVIDER_TIMEOUT_MS = 1;
const MAX_PROVIDER_TIMEOUT_MS = 10 * 60_000;

const runtimeContractServer = createRuntimeContractServer<
  RuntimeServerContext,
  RunRequest,
  RunEvent,
  RunResponse
>({
  getCapabilityManifest: buildRuntimeCapabilityManifest,
  normalizeRunRequest(rawBody, runId) {
    try {
      return {
        ...parseRuntimeRunRequest(addRunId(rawBody, runId)),
        runId
      };
    } catch {
      return null;
    }
  },
  streamRun: streamNativeRun,
  responseFromEvent(event) {
    return event.type === "final" ? { response: event.response } : null;
  },
  formatError(error) {
    return error instanceof Error ? error.message : String(error);
  }
});

export async function handleRuntimeRequest(
  request: Request,
  context: RuntimeRequestOptions = {},
  options: {
    upgradeWebSocket?: (runId: string) => boolean;
  } = {}
): Promise<Response> {
  const response = await runtimeContractServer.handleRequest(
    request,
    context,
    options
  );
  return response ?? new Response("Not found", { status: 404 });
}

export function attachRuntimeEventWebSocket(
  runId: string,
  ws: RuntimeEventWebSocket
): void {
  runtimeContractServer.attachEventWebSocket(runId, ws);
}

export function buildRuntimeCapabilityManifest(): CapabilityManifest {
  return {
    runtimeType: "burble-native",
    version: "1",
    transports: ["http", "sse", "ndjson", "websocket"],
    streaming: true,
    cancellation: false,
    nativeScheduler: false,
    scheduledProviderCalls: false,
    toolCalls: false,
    toolBridgeModes: ["tool_gateway"],
    usageReporting: "exact",
    multimodalInput: false,
    multimodalOutput: false,
    memory: false,
    durableWorkflowState: false,
    attachments: false,
    conversationSend: true,
    jobScopedAuth: true
  };
}

async function* streamNativeRun(
  request: RunRequest,
  context: RuntimeServerContext
): AsyncIterable<RunEvent> {
  yield { type: "status", text: "Burble Native accepted the turn." };
  let finalResponse: RuntimeFinalResponse | null = null;
  let emittedMessageDelta = false;
  for await (const event of runNativeTurn(request, context)) {
    if (event.type === "message_delta") {
      emittedMessageDelta = true;
      yield event;
      continue;
    }
    finalResponse = event.response;
  }
  if (!finalResponse) {
    throw new Error("Burble Native turn did not produce a final response");
  }
  if (!emittedMessageDelta && finalResponse.text) {
    yield { type: "message_delta", text: finalResponse.text };
  }
  yield { type: "final", response: finalResponse };
}

async function* runNativeTurn(
  request: RunRequest,
  context: RuntimeServerContext
): AsyncIterable<
  | Extract<RunEvent, { type: "message_delta" }>
  | Extract<RunEvent, { type: "final" }>
> {
  if (readEnv(context.env, "BURBLE_RUNTIME_CONTRACT_PROBE") === "1") {
    yield {
      type: "final",
      response: {
        classification: "user_private",
        text: "Runtime contract probe response.",
        usage: nativeUsage()
      }
    };
    return;
  }
  let responseText = "";
  let usage: RunUsage | undefined;
  for await (const event of streamOpenAiTurn(request, context)) {
    if (event.type === "message_delta") {
      responseText += event.text;
      yield event;
      continue;
    }
    responseText = event.text || responseText;
    usage = event.usage;
  }
  yield {
    type: "final",
    response: {
      classification: "user_private",
      text: responseText,
      usage
    }
  };
}

function nativeUsage(): RunUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    usageSource: "burble-native"
  };
}

async function* streamOpenAiTurn(
  request: RunRequest,
  context: RuntimeServerContext
): AsyncIterable<
  | Extract<RunEvent, { type: "message_delta" }>
  | { type: "completed"; text: string; usage: RunUsage | undefined }
> {
  const model = readOpenAiModel(context.env);
  const apiKey = readEnv(context.env, "OPENAI_API_KEY");
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for Burble Native model calls");
  }
  const requestFetch = context.fetch ?? fetch;
  const timeoutMs = readProviderTimeoutMs(context.env);
  const responsesUrl = readOpenAiResponsesUrl(context.env);
  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort(new ProviderTimeoutError(timeoutMs));
  }, timeoutMs);

  try {
    const response = await requestFetch(responsesUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      signal: abortController.signal,
      body: JSON.stringify({
        model,
        input: buildOpenAiInput(request),
        stream: true
      })
    });
    if (!response.ok || !response.body) {
      throw new Error(`OpenAI Responses API returned HTTP ${response.status}`);
    }

    let completedText = "";
    let completedUsage: RunUsage | undefined;
    for await (const payload of readSseJsonPayloads(
      response.body,
      abortController.signal
    )) {
      throwIfProviderTimedOut(abortController.signal);
      const type = readString(payload, "type");
      if (type === "response.output_text.delta") {
        const delta = readString(payload, "delta");
        if (delta) {
          yield { type: "message_delta", text: delta };
        }
        continue;
      }
      if (type === "response.completed") {
        const responsePayload = readRecord(payload, "response");
        completedText = extractOpenAiText(responsePayload) ?? completedText;
        completedUsage = normalizeOpenAiUsage(readRecord(responsePayload, "usage"));
      }
    }

    throwIfProviderTimedOut(abortController.signal);
    yield {
      type: "completed",
      text: completedText,
      usage: completedUsage
    };
  } catch (error) {
    throwIfProviderTimedOut(abortController.signal, error);
    throw error;
  } finally {
    clearTimeout(timeout);
    try {
      abortController.abort();
    } catch {
      // Ignore abort failures after the provider stream has already completed.
    }
  }
}

function readOpenAiModel(env: Record<string, string | undefined> | undefined): string {
  const raw = readEnv(env, "AI_MODEL") ?? "openai:gpt-5.4";
  const separator = raw.indexOf(":");
  if (separator <= 0) {
    throw new Error("AI_MODEL must use provider:model format");
  }
  const provider = raw.slice(0, separator);
  const model = raw.slice(separator + 1).trim();
  if (provider !== "openai" || !model) {
    throw new Error("Burble Native Increment 1 supports AI_MODEL=openai:<model>");
  }
  return model;
}

function readOpenAiResponsesUrl(
  env: Record<string, string | undefined> | undefined
): string {
  const baseUrl = readEnv(env, "OPENAI_BASE_URL") ?? "https://api.openai.com/v1";
  try {
    return new URL("responses", withTrailingSlash(baseUrl)).toString();
  } catch {
    throw new Error("OPENAI_BASE_URL must be a valid URL");
  }
}

function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function readProviderTimeoutMs(
  env: Record<string, string | undefined> | undefined
): number {
  const raw = readEnv(env, "BURBLE_NATIVE_PROVIDER_TIMEOUT_MS");
  if (!raw) {
    return DEFAULT_PROVIDER_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_PROVIDER_TIMEOUT_MS;
  }
  return Math.min(Math.max(parsed, MIN_PROVIDER_TIMEOUT_MS), MAX_PROVIDER_TIMEOUT_MS);
}

class ProviderTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`OpenAI Responses API timed out after ${timeoutMs}ms`);
  }
}

function throwIfProviderTimedOut(signal: AbortSignal, error?: unknown): void {
  const reason = signal.reason;
  if (signal.aborted && reason instanceof ProviderTimeoutError) {
    throw reason;
  }
  if (error instanceof ProviderTimeoutError) {
    throw error;
  }
}

function buildOpenAiInput(request: RunRequest): string {
  const recentMessages = request.input.context?.recentMessages ?? [];
  const history = recentMessages
    .map((message) => `${message.author}: ${message.text}`)
    .join("\n");
  return [
    "You are Burble, a concise Slack-native work assistant.",
    "Answer the user directly. Do not claim to have tools in this runtime.",
    history ? `Recent conversation:\n${history}` : "",
    `User: ${request.input.text.trim()}`
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function* readSseJsonPayloads(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal
): AsyncIterable<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await readStreamChunkWithAbort(reader, signal);
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const payload = parseSseJsonPayload(part);
      if (payload) {
        yield payload;
      }
    }
  }
  buffer += decoder.decode();
  const payload = parseSseJsonPayload(buffer);
  if (payload) {
    yield payload;
  }
}

async function readStreamChunkWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal
): Promise<StreamReadResult> {
  throwIfProviderTimedOut(signal);
  if (!signal.aborted) {
    return new Promise((resolve, reject) => {
      const abort = () => {
        signal.removeEventListener("abort", abort);
        try {
          reader.cancel(signal.reason).catch(() => {});
        } catch {
          // Ignore reader cancellation failures; the timeout error is enough.
        }
        reject(signal.reason ?? new Error("Provider stream aborted"));
      };
      signal.addEventListener("abort", abort, { once: true });
      reader.read().then(
        (result) => {
          signal.removeEventListener("abort", abort);
          resolve(result);
        },
        (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        }
      );
    });
  }
  throw signal.reason ?? new Error("Provider stream aborted");
}

function parseSseJsonPayload(chunk: string): Record<string, unknown> | null {
  const data = chunk
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .join("\n")
    .trim();
  if (!data || data === "[DONE]") {
    return null;
  }
  try {
    const payload = JSON.parse(data) as unknown;
    return isRecord(payload) ? payload : null;
  } catch {
    return null;
  }
}

function extractOpenAiText(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const outputText = value.output_text;
  if (typeof outputText === "string") {
    return outputText;
  }
  const output = value.output;
  if (!Array.isArray(output)) {
    return null;
  }
  const texts: string[] = [];
  for (const item of output) {
    if (!isRecord(item) || !Array.isArray(item.content)) {
      continue;
    }
    for (const content of item.content) {
      if (!isRecord(content)) {
        continue;
      }
      const text = content.text;
      if (typeof text === "string") {
        texts.push(text);
      }
    }
  }
  return texts.length > 0 ? texts.join("") : null;
}

function normalizeOpenAiUsage(value: unknown): RunUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const usage: RunUsage = {
    usageSource: "provider-output"
  };
  setOptionalInt(usage, "inputTokens", readInt(value, "input_tokens"));
  setOptionalInt(usage, "outputTokens", readInt(value, "output_tokens"));
  setOptionalInt(usage, "totalTokens", readInt(value, "total_tokens"));
  setOptionalInt(
    usage,
    "cachedInputTokens",
    readNestedInt(value, "input_tokens_details", "cached_tokens")
  );
  setOptionalInt(
    usage,
    "reasoningTokens",
    readNestedInt(value, "output_tokens_details", "reasoning_tokens")
  );
  return usage;
}

function setOptionalInt<K extends keyof RunUsage>(
  target: RunUsage,
  key: K,
  value: number | undefined
): void {
  if (typeof value === "number") {
    target[key] = value as RunUsage[K];
  }
}

function readInt(value: Record<string, unknown>, key: string): number | undefined {
  const raw = value[key];
  return Number.isInteger(raw) && Number(raw) >= 0 ? Number(raw) : undefined;
}

function readNestedInt(
  value: Record<string, unknown>,
  objectKey: string,
  key: string
): number | undefined {
  const nested = value[objectKey];
  return isRecord(nested) ? readInt(nested, key) : undefined;
}

function readString(value: unknown, key: string): string | null {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : null;
}

function readRecord(value: unknown, key: string): Record<string, unknown> | null {
  return isRecord(value) && isRecord(value[key]) ? value[key] : null;
}

function readEnv(
  env: Record<string, string | undefined> | undefined,
  name: string
): string | undefined {
  return (env?.[name] ?? Bun.env[name])?.trim() || undefined;
}

function addRunId(rawBody: unknown, runId: string): unknown {
  return isRecord(rawBody) ? { ...rawBody, runId } : rawBody;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
