import {
  parseRuntimeRunRequest,
  type RuntimeFinalResponse
} from "@burble/runtime-sdk/runtime-contract";
import {
  createRuntimeContractServer,
  type RuntimeEventWebSocket
} from "@burble/runtime-sdk/server";
import { createBurbleNativeToolExecutor } from "./tools";
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
type OpenAiInputItem = Record<string, unknown>;
type OpenAiFunctionToolCall = {
  callId: string;
  toolName: string;
  input: unknown;
};

const DEFAULT_PROVIDER_TIMEOUT_MS = 120_000;
const MIN_PROVIDER_TIMEOUT_MS = 1;
const MAX_PROVIDER_TIMEOUT_MS = 10 * 60_000;
const MAX_TOOL_LOOP_STEPS = 4;
const BURBLE_PROVIDER_TOOL_NAME = "burble_provider_call";

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
    if (event.type === "final") {
      finalResponse = event.response;
      continue;
    }
    if (event.type === "message_delta") {
      emittedMessageDelta = true;
      yield event;
      continue;
    }
    yield event;
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
): AsyncIterable<RunEvent> {
  if (readEnv(context.env, "BURBLE_RUNTIME_CONTRACT_PROBE") === "1") {
    if (request.input.text === "runtime contract tool capability probe") {
      yield {
        type: "tool_call",
        toolName: BURBLE_PROVIDER_TOOL_NAME,
        callId: "contract-tool-probe"
      };
      yield {
        type: "tool_result",
        toolName: BURBLE_PROVIDER_TOOL_NAME,
        callId: "contract-tool-probe",
        classification: "user_private"
      };
      yield {
        type: "final",
        response: {
          classification: "user_private",
          text: "Runtime contract tool capability response.",
          usage: nativeUsage()
        }
      };
      return;
    }
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
  let input = buildOpenAiInput(request);
  for (let step = 0; step < MAX_TOOL_LOOP_STEPS; step += 1) {
    const result = await collectOpenAiTurn(input, request, context);
    usage = mergeUsage(usage, result.usage);
    if (result.toolCalls.length === 0) {
      for (const delta of result.deltas) {
        responseText += delta;
        yield { type: "message_delta", text: delta };
      }
      responseText = result.text || responseText;
      break;
    }

    const toolOutputs: OpenAiInputItem[] = [];
    for (const toolCall of result.toolCalls) {
      yield {
        type: "tool_call",
        toolName: toolCall.toolName,
        callId: toolCall.callId
      };
      const toolResult = await executeBurbleProviderTool(toolCall, context);
      yield {
        type: "tool_result",
        toolName: toolCall.toolName,
        callId: toolCall.callId,
        classification: readToolResultClassification(toolResult)
      };
      toolOutputs.push({
        type: "function_call_output",
        call_id: toolCall.callId,
        output: JSON.stringify(toolResult)
      });
    }

    input = [...asOpenAiInputItems(input), ...result.outputItems, ...toolOutputs];
    if (step === MAX_TOOL_LOOP_STEPS - 1) {
      throw new Error(
        `Burble Native exceeded ${MAX_TOOL_LOOP_STEPS} tool-call steps`
      );
    }
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

async function collectOpenAiTurn(
  input: string | OpenAiInputItem[],
  request: RunRequest,
  context: RuntimeServerContext
): Promise<{
  deltas: string[];
  text: string;
  usage: RunUsage | undefined;
  outputItems: OpenAiInputItem[];
  toolCalls: OpenAiFunctionToolCall[];
}> {
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
        input,
        tools: buildOpenAiTools(request),
        stream: true
      })
    });
    if (!response.ok || !response.body) {
      throw new Error(`OpenAI Responses API returned HTTP ${response.status}`);
    }

    const deltas: string[] = [];
    let completedText = "";
    let completedUsage: RunUsage | undefined;
    let outputItems: OpenAiInputItem[] = [];
    let toolCalls: OpenAiFunctionToolCall[] = [];
    for await (const payload of readSseJsonPayloads(
      response.body,
      abortController.signal
    )) {
      throwIfProviderTimedOut(abortController.signal);
      const type = readString(payload, "type");
      if (type === "response.output_text.delta") {
        const delta = readString(payload, "delta");
        if (delta) {
          deltas.push(delta);
        }
        continue;
      }
      if (type === "response.completed") {
        const responsePayload = readRecord(payload, "response");
        completedText = extractOpenAiText(responsePayload) ?? completedText;
        completedUsage = normalizeOpenAiUsage(readRecord(responsePayload, "usage"));
        outputItems = readOpenAiOutputItems(responsePayload);
        toolCalls = outputItems.flatMap(readOpenAiFunctionToolCall);
      }
    }

    throwIfProviderTimedOut(abortController.signal);
    return {
      deltas,
      text: completedText,
      usage: completedUsage,
      outputItems,
      toolCalls
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

async function executeBurbleProviderTool(
  toolCall: OpenAiFunctionToolCall,
  context: RuntimeServerContext
): Promise<unknown> {
  const toolGatewayUrl = readEnv(context.env, "BURBLE_TOOL_GATEWAY_URL");
  const runtimeToken = readEnv(context.env, "BURBLE_INTERNAL_TOKEN");
  if (!toolGatewayUrl || !runtimeToken) {
    throw new Error(
      "BURBLE_TOOL_GATEWAY_URL and BURBLE_INTERNAL_TOKEN are required for Burble Native tool calls"
    );
  }
  const executeTool = createBurbleNativeToolExecutor({
    toolGatewayUrl,
    runtimeToken,
    ...(context.fetch ? { fetch: context.fetch } : {})
  });
  return executeTool(toolCall.toolName, toolCall.input);
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

function buildOpenAiInput(request: RunRequest): OpenAiInputItem[] {
  const recentMessages = request.input.context?.recentMessages ?? [];
  const history = recentMessages
    .map((message) => `${message.author}: ${message.text}`)
    .join("\n");
  const text = [
    "You are Burble, a concise Slack-native work assistant.",
    "Use the burble_provider_call tool when provider data or actions are needed. Pass the exact Burble tool name as toolName and its JSON input as input.",
    history ? `Recent conversation:\n${history}` : "",
    `User: ${request.input.text.trim()}`
  ]
    .filter(Boolean)
    .join("\n\n");
  return [{ role: "user", content: text }];
}

function buildOpenAiTools(request: RunRequest): OpenAiInputItem[] {
  const groups = request.input.toolGroups?.groups ?? [];
  if (groups.length === 0) {
    return [];
  }
  return [
    {
      type: "function",
      name: BURBLE_PROVIDER_TOOL_NAME,
      description:
        "Call a Burble provider or conversation tool through the Burble tool gateway.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          toolName: {
            type: "string",
            description:
              "The exact Burble tool name to execute, for example github.getAuthenticatedUser or conversation.sendMessage."
          },
          input: {
            type: "object",
            description: "The JSON input to pass to the Burble tool.",
            additionalProperties: true
          }
        },
        required: ["toolName", "input"]
      }
    }
  ];
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

function readOpenAiOutputItems(value: unknown): OpenAiInputItem[] {
  if (!isRecord(value) || !Array.isArray(value.output)) {
    return [];
  }
  return value.output.filter(isRecord);
}

function readOpenAiFunctionToolCall(
  item: OpenAiInputItem
): OpenAiFunctionToolCall[] {
  if (item.type !== "function_call") {
    return [];
  }
  const name = typeof item.name === "string" ? item.name : "";
  const callId = typeof item.call_id === "string" ? item.call_id : "";
  if (name !== BURBLE_PROVIDER_TOOL_NAME || !callId) {
    return [];
  }
  const parsed = parseFunctionArguments(item.arguments);
  const toolName =
    isRecord(parsed) && typeof parsed.toolName === "string"
      ? parsed.toolName.trim()
      : "";
  if (!toolName) {
    return [];
  }
  return [
    {
      callId,
      toolName,
      input: isRecord(parsed) && "input" in parsed ? parsed.input : {}
    }
  ];
}

function parseFunctionArguments(value: unknown): unknown {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return {};
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function asOpenAiInputItems(input: string | OpenAiInputItem[]): OpenAiInputItem[] {
  return typeof input === "string" ? [{ role: "user", content: input }] : input;
}

function readToolResultClassification(
  value: unknown
): Extract<RunEvent, { type: "tool_result" }>["classification"] {
  if (
    isRecord(value) &&
    (value.classification === "public" ||
      value.classification === "user_private" ||
      value.classification === "restricted")
  ) {
    return value.classification;
  }
  return "user_private";
}

function mergeUsage(
  current: RunUsage | undefined,
  next: RunUsage | undefined
): RunUsage | undefined {
  if (!current) {
    return next;
  }
  if (!next) {
    return current;
  }
  return {
    inputTokens: addOptional(current.inputTokens, next.inputTokens),
    outputTokens: addOptional(current.outputTokens, next.outputTokens),
    totalTokens: addOptional(current.totalTokens, next.totalTokens),
    cachedInputTokens: addOptional(
      current.cachedInputTokens,
      next.cachedInputTokens
    ),
    reasoningTokens: addOptional(current.reasoningTokens, next.reasoningTokens),
    usageSource: next.usageSource || current.usageSource
  };
}

function addOptional(
  left: number | undefined,
  right: number | undefined
): number | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }
  return left + right;
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
