import {
  readRuntimeToolErrorDiagnostic,
  parseRuntimeRunRequest,
  type RuntimeFinalResponse
} from "@burble/runtime-sdk/runtime-contract";
import {
  formatRuntimeScheduledJobContext,
  withTrustedScheduledJobId
} from "@burble/runtime-sdk/scheduled-job-context";
import {
  authorizeRuntimeBearerOrHeaderToken,
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
  logInfo?: (message: string) => void;
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
export const DEFAULT_TURN_TIMEOUT_MS = 150_000;
const MIN_TURN_TIMEOUT_MS = 1;
const MAX_TURN_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_PROVIDER_MAX_ATTEMPTS = 3;
const DEFAULT_PROVIDER_RETRY_BASE_DELAY_MS = 250;
const DEFAULT_MAX_TOOL_LOOP_STEPS = 8;
const MIN_TOOL_LOOP_STEPS = 1;
const MAX_TOOL_LOOP_STEPS = 32;
const MAX_PROMPT_TOOLS = 24;
const MAX_MODEL_TOOL_OUTPUT_CHARS = 12_000;
const TRUNCATED_TOOL_OUTPUT_EDGE_CHARS = 4_000;
const MAX_RUNTIME_TOOL_EVENT_INPUT_CHARS = 2_048;
const MAX_ATTACHMENT_NAME_CHARS = 120;
const BURBLE_PROVIDER_TOOL_NAME = "burble_provider_call";

const runtimeContractServer = createRuntimeContractServer<
  RuntimeServerContext,
  RunRequest,
  RunEvent,
  RunResponse
>({
  authorizeRequest: (request, context) =>
    authorizeRuntimeBearerOrHeaderToken(
      request,
      readEnv(context.env, "BURBLE_INTERNAL_TOKEN")
    ),
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
    version: "2",
    transports: ["http", "sse", "ndjson", "websocket"],
    streaming: true,
    cancellation: false,
    nativeScheduler: false,
    scheduledProviderCalls: true,
    toolCalls: true,
    toolBridgeModes: ["tool_gateway"],
    usageReporting: "exact",
    multimodalInput: false,
    multimodalOutput: false,
    memory: false,
    durableWorkflowState: false,
    attachments: true,
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
    if (request.input.text === "runtime contract tool reachability probe") {
      for (const [index, tool] of reachableManifestTools(request).entries()) {
        const callId = `contract-tool-reachability-${index}`;
        const probed = await probeBurbleProviderToolReachability(tool, request);
        yield {
          type: "tool_call",
          toolName: tool.alias,
          callId,
          input: probed.input
        };
        yield {
          type: "tool_result",
          toolName: tool.alias,
          callId,
          classification: "user_private",
          content: probed.content
        };
      }
      yield {
        type: "final",
        response: {
          classification: "user_private",
          text: "Runtime contract tool reachability response.",
          usage: nativeUsage()
        }
      };
      return;
    }
    if (request.input.text === "runtime contract attachment capability probe") {
      const attachmentId =
        request.input.attachments?.[0]?.id ?? "attcap_contract_probe";
      yield {
        type: "tool_call",
        toolName: "conversation.getAttachment",
        callId: "contract-attachment-probe",
        input: { attachmentId }
      };
      yield {
        type: "tool_result",
        toolName: "conversation.getAttachment",
        callId: "contract-attachment-probe",
        classification: "user_private",
        content: { text: "contract attachment content" }
      };
      yield {
        type: "final",
        response: {
          classification: "user_private",
          text: "Runtime contract attachment capability response.",
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
  const turnDeadline = createTurnDeadline(context.env);
  const maxToolLoopSteps = readMaxToolLoopSteps(context.env);
  let toolCallSteps = 0;
  while (true) {
    const result = await collectOpenAiTurn(input, request, context, turnDeadline);
    usage = mergeUsage(usage, result.usage);
    if (result.toolCalls.length === 0) {
      for (const delta of result.deltas) {
        responseText += delta;
        yield { type: "message_delta", text: delta };
      }
      responseText = result.text || responseText;
      break;
    }
    if (toolCallSteps >= maxToolLoopSteps) {
      throw new Error(
        `Burble Native exceeded ${maxToolLoopSteps} tool-call steps`
      );
    }

    const toolOutputs: OpenAiInputItem[] = [];
    for (const toolCall of result.toolCalls) {
      const effectiveToolCall = {
        ...toolCall,
        input: withTrustedScheduledJobId(
          toolCall.input,
          request.input.scheduledJob
        )
      };
      yield {
        type: "tool_call",
        toolName: effectiveToolCall.toolName,
        callId: effectiveToolCall.callId,
        ...runtimeToolEventInput(effectiveToolCall.input)
      };
      const toolResult = await executeBurbleProviderToolForModel(
        effectiveToolCall,
        request,
        context
      );
      const toolError = readRuntimeToolErrorDiagnostic(toolResult);
      yield {
        type: "tool_result",
        toolName: toolCall.toolName,
        callId: toolCall.callId,
        classification: readToolResultClassification(toolResult),
        status: toolResultHasError(toolResult) ? "error" : "ok",
        ...(toolError ?? {})
      };
      toolOutputs.push({
        type: "function_call_output",
        call_id: toolCall.callId,
        output: serializeToolOutputForModel(toolResult)
      });
    }

    toolCallSteps += 1;
    input = [
      ...asOpenAiInputItems(input),
      ...result.outputItems,
      ...toolOutputs,
      {
        role: "developer",
        content: formatToolLoopBudget(maxToolLoopSteps - toolCallSteps)
      }
    ];
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

type ReachableRuntimeTool = NonNullable<
  NonNullable<RunRequest["runtime"]["manifest"]>["tools"]
>[number];

function reachableManifestTools(request: RunRequest): ReachableRuntimeTool[] {
  return (request.runtime.manifest?.tools ?? [])
    .filter((tool) => tool.enabled === true && tool.alias.length > 0);
}

async function probeBurbleProviderToolReachability(
  tool: ReachableRuntimeTool,
  request: RunRequest
): Promise<{ input: Record<string, unknown>; content: unknown }> {
  const input = sampleRuntimeToolInput(tool);
  const executeTool = createBurbleNativeToolExecutor({
    toolGatewayUrl: "http://burble-contract-probe/internal/tools",
    runtimeToken: "contract-probe-token",
    runtimeId: request.runtime.id,
    tools: request.runtime.manifest?.tools ?? [],
    maxAttempts: 1,
    fetch: async (url, init) => {
      const parsed = new URL(url);
      const toolName = decodeURIComponent(
        parsed.pathname
          .replace(/^\/internal\/tools\//, "")
          .replace(/\/execute$/, "")
      );
      const body = parseJsonRecord(init?.body);
      if (!toolName || !isRecord(body.input)) {
        return Response.json({ message: "invalid contract probe call" }, { status: 400 });
      }
      return Response.json({
        classification: "user_private",
        content: {
          ok: true,
          toolName,
          input: body.input
        }
      });
    }
  });
  const result = await executeTool(tool.alias, { input });
  return {
    input,
    content: isRecord(result) && "content" in result ? result.content : result
  };
}

function sampleRuntimeToolInput(tool: ReachableRuntimeTool): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const field of tool.input ?? []) {
    if (!field.required) {
      continue;
    }
    input[field.name] = sampleRuntimeToolInputValue(field);
  }
  return input;
}

function sampleRuntimeToolInputValue(
  field: NonNullable<ReachableRuntimeTool["input"]>[number]
): unknown {
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

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function nativeUsage(): RunUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    usageSource: "burble-native"
  };
}

type TurnDeadline = {
  expiresAtMs: number;
  timeoutMs: number;
};

async function collectOpenAiTurn(
  input: string | OpenAiInputItem[],
  request: RunRequest,
  context: RuntimeServerContext,
  turnDeadline: TurnDeadline
): Promise<{
  deltas: string[];
  text: string;
  usage: RunUsage | undefined;
  outputItems: OpenAiInputItem[];
  toolCalls: OpenAiFunctionToolCall[];
}> {
  const maxAttempts = readProviderMaxAttempts(context.env);
  const retryBaseDelayMs = readProviderRetryBaseDelayMs(context.env);
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    throwIfTurnTimedOut(turnDeadline);
    try {
      return await collectOpenAiTurnAttempt(
        input,
        request,
        context,
        turnDeadline,
        attempt + 1
      );
    } catch (error) {
      if (!shouldRetryProviderError(error) || attempt === maxAttempts - 1) {
        throw error;
      }
      lastError = error;
      await sleep(Math.min(retryDelayMs(attempt, retryBaseDelayMs), remainingTurnMs(turnDeadline)));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("OpenAI Responses API request failed");
}

async function collectOpenAiTurnAttempt(
  input: string | OpenAiInputItem[],
  request: RunRequest,
  context: RuntimeServerContext,
  turnDeadline: TurnDeadline,
  attempt: number
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
  const providerTimeoutMs = readProviderTimeoutMs(context.env);
  const turnRemainingMs = remainingTurnMs(turnDeadline);
  if (turnRemainingMs <= 0) {
    throw new TurnTimeoutError(turnDeadline.timeoutMs);
  }
  const timeoutMs = Math.min(providerTimeoutMs, turnRemainingMs);
  const timeoutError =
    timeoutMs < providerTimeoutMs
      ? new TurnTimeoutError(turnDeadline.timeoutMs)
      : new ProviderTimeoutError(providerTimeoutMs);
  const responsesUrl = readOpenAiResponsesUrl(context.env);
  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort(timeoutError);
  }, timeoutMs);
  const startedAt = Date.now();
  logNativeProviderLifecycle(context, request, "request_started", {
    attempt,
    timeoutMs
  });
  const stream = request.input.scheduledJob === undefined;

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
        stream
      })
    });
    if (!response.ok) {
      throw new ProviderHttpError(response.status);
    }
    if (!stream) {
      const responsePayload: unknown = await response.json();
      throwIfProviderTimedOut(abortController.signal);
      throwIfTurnTimedOut(turnDeadline);
      logNativeProviderLifecycle(context, request, "terminal_received", {
        attempt,
        elapsedMs: Date.now() - startedAt,
        terminalType: "response"
      });
      const outputItems = readOpenAiOutputItems(responsePayload);
      return {
        deltas: [],
        text: extractOpenAiText(responsePayload) ?? "",
        usage: normalizeOpenAiUsage(readRecord(responsePayload, "usage")),
        outputItems,
        toolCalls: outputItems.flatMap(readOpenAiFunctionToolCall)
      };
    }
    if (!response.body) {
      throw new ProviderStreamIncompleteError();
    }

    const deltas: string[] = [];
    let completedText = "";
    let completedUsage: RunUsage | undefined;
    let outputItems: OpenAiInputItem[] = [];
    let toolCalls: OpenAiFunctionToolCall[] = [];
    let completed = false;
    for await (const payload of readSseJsonPayloads(
      response.body,
      abortController.signal,
      (reason) =>
        logNativeProviderLifecycle(context, request, "stream_closed", {
          attempt,
          elapsedMs: Date.now() - startedAt,
          reason
        })
    )) {
      throwIfProviderTimedOut(abortController.signal);
      throwIfTurnTimedOut(turnDeadline);
      const type = readString(payload, "type");
      if (type === "response.output_text.delta") {
        const delta = readString(payload, "delta");
        if (delta) {
          deltas.push(delta);
        }
        continue;
      }
      if (type === "response.completed") {
        logNativeProviderLifecycle(context, request, "terminal_received", {
          attempt,
          elapsedMs: Date.now() - startedAt,
          terminalType: type
        });
        completed = true;
        const responsePayload = readRecord(payload, "response");
        completedText = extractOpenAiText(responsePayload) ?? completedText;
        completedUsage = normalizeOpenAiUsage(readRecord(responsePayload, "usage"));
        outputItems = readOpenAiOutputItems(responsePayload);
        toolCalls = outputItems.flatMap(readOpenAiFunctionToolCall);
        break;
      }
      if (type === "response.failed" || type === "response.incomplete") {
        logNativeProviderLifecycle(context, request, "terminal_received", {
          attempt,
          elapsedMs: Date.now() - startedAt,
          terminalType: type
        });
        throw new ProviderTerminalResponseError(
          type,
          readProviderTerminalDetail(payload, type)
        );
      }
    }

    throwIfProviderTimedOut(abortController.signal);
    throwIfTurnTimedOut(turnDeadline);
    if (!completed) {
      throw new ProviderStreamIncompleteError();
    }
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

function logNativeProviderLifecycle(
  context: RuntimeServerContext,
  request: RunRequest,
  event: "request_started" | "terminal_received" | "stream_closed",
  fields: Record<string, string | number>
): void {
  const details = Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  context.logInfo?.(
    `Burble Native provider lifecycle runId=${request.runId} event=${event}${details ? ` ${details}` : ""}`
  );
}

async function executeBurbleProviderToolForModel(
  toolCall: OpenAiFunctionToolCall,
  request: RunRequest,
  context: RuntimeServerContext
): Promise<unknown> {
  try {
    return await executeBurbleProviderTool(toolCall, request, context);
  } catch (error) {
    return {
      classification: "user_private",
      content: {
        error: "tool_execution_failed",
        toolName: toolCall.toolName,
        message: sanitizeToolErrorMessage(error)
      }
    };
  }
}

async function executeBurbleProviderTool(
  toolCall: OpenAiFunctionToolCall,
  request: RunRequest,
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
    runtimeId: request.runtime.id,
    tools: request.runtime.manifest?.tools ?? [],
    maxAttempts: readToolGatewayMaxAttempts(context.env),
    retryBaseDelayMs: readToolGatewayRetryBaseDelayMs(context.env),
    ...(context.fetch ? { fetch: context.fetch } : {})
  });
  return executeTool(toolCall.toolName, { input: toolCall.input });
}

function sanitizeToolErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted-openai-key]")
    .trim();
}

function serializeToolOutputForModel(toolResult: unknown): string {
  const serialized = JSON.stringify(toolResult);
  if (serialized.length <= MAX_MODEL_TOOL_OUTPUT_CHARS) {
    return serialized;
  }

  return JSON.stringify({
    classification: readToolResultClassification(toolResult),
    content: {
      truncated: true,
      originalChars: serialized.length,
      omittedChars: Math.max(
        0,
        serialized.length - TRUNCATED_TOOL_OUTPUT_EDGE_CHARS * 2
      ),
      head: serialized.slice(0, TRUNCATED_TOOL_OUTPUT_EDGE_CHARS),
      tail: serialized.slice(-TRUNCATED_TOOL_OUTPUT_EDGE_CHARS)
    }
  });
}

function runtimeToolEventInput(
  input: unknown
): { input: Record<string, unknown> } | Record<string, never> {
  if (!isRecord(input)) {
    return {};
  }
  const serialized = JSON.stringify(input);
  if (serialized.length <= MAX_RUNTIME_TOOL_EVENT_INPUT_CHARS) {
    return { input };
  }
  return {
    input: {
      truncated: true,
      originalChars: serialized.length,
      inputKeys: Object.keys(input)
    }
  };
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

function readProviderMaxAttempts(
  env: Record<string, string | undefined> | undefined
): number {
  const raw = readEnv(env, "BURBLE_NATIVE_PROVIDER_MAX_ATTEMPTS");
  if (!raw) {
    return DEFAULT_PROVIDER_MAX_ATTEMPTS;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.max(1, Math.floor(parsed))
    : DEFAULT_PROVIDER_MAX_ATTEMPTS;
}

function readProviderRetryBaseDelayMs(
  env: Record<string, string | undefined> | undefined
): number {
  const raw = readEnv(env, "BURBLE_NATIVE_PROVIDER_RETRY_BASE_MS");
  if (!raw) {
    return DEFAULT_PROVIDER_RETRY_BASE_DELAY_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.floor(parsed)
    : DEFAULT_PROVIDER_RETRY_BASE_DELAY_MS;
}

function readMaxToolLoopSteps(
  env: Record<string, string | undefined> | undefined
): number {
  const raw = readEnv(env, "BURBLE_NATIVE_MAX_TOOL_LOOP_STEPS");
  if (!raw) {
    return DEFAULT_MAX_TOOL_LOOP_STEPS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_TOOL_LOOP_STEPS;
  }
  return Math.min(Math.max(parsed, MIN_TOOL_LOOP_STEPS), MAX_TOOL_LOOP_STEPS);
}

function formatToolLoopBudget(remainingSteps: number): string {
  return `Burble execution budget: ${remainingSteps} tool-call rounds remain. Complete all required reads and mutations before the final answer. Do not claim an operation succeeded unless its tool result succeeded.`;
}

function readTurnTimeoutMs(
  env: Record<string, string | undefined> | undefined
): number {
  const raw = readEnv(env, "BURBLE_NATIVE_TURN_TIMEOUT_MS");
  if (!raw) {
    return DEFAULT_TURN_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_TURN_TIMEOUT_MS;
  }
  return Math.min(Math.max(parsed, MIN_TURN_TIMEOUT_MS), MAX_TURN_TIMEOUT_MS);
}

function readToolGatewayMaxAttempts(
  env: Record<string, string | undefined> | undefined
): number | undefined {
  const raw = readEnv(env, "BURBLE_NATIVE_TOOL_GATEWAY_MAX_ATTEMPTS");
  if (!raw) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function readToolGatewayRetryBaseDelayMs(
  env: Record<string, string | undefined> | undefined
): number | undefined {
  const raw = readEnv(env, "BURBLE_NATIVE_TOOL_GATEWAY_RETRY_BASE_MS");
  if (!raw) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

class ProviderTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`OpenAI Responses API timed out after ${timeoutMs}ms`);
  }
}

class TurnTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Burble Native turn timed out after ${timeoutMs}ms`);
  }
}

class ProviderHttpError extends Error {
  constructor(readonly status: number) {
    super(`OpenAI Responses API returned HTTP ${status}`);
  }
}

class ProviderStreamIncompleteError extends Error {
  constructor() {
    super("OpenAI Responses API stream ended before response.completed");
  }
}

class ProviderTerminalResponseError extends Error {
  constructor(
    readonly eventType: "response.failed" | "response.incomplete",
    detail: string
  ) {
    super(`OpenAI Responses API ${eventType}: ${detail}`);
  }
}

function readProviderTerminalDetail(
  payload: Record<string, unknown>,
  eventType: "response.failed" | "response.incomplete"
): string {
  const responsePayload = readRecord(payload, "response");
  if (eventType === "response.failed") {
    const error = readRecord(responsePayload, "error") ?? readRecord(payload, "error");
    return sanitizeToolErrorMessage(readString(error, "message") ?? "unknown error");
  }
  const incompleteDetails =
    readRecord(responsePayload, "incomplete_details") ??
    readRecord(payload, "incomplete_details");
  return sanitizeToolErrorMessage(
    readString(incompleteDetails, "reason") ?? "unknown reason"
  );
}

function shouldRetryProviderError(error: unknown): boolean {
  if (error instanceof TurnTimeoutError) {
    return false;
  }
  if (error instanceof ProviderTimeoutError) {
    return true;
  }
  if (error instanceof ProviderStreamIncompleteError) {
    return true;
  }
  const status =
    error instanceof ProviderHttpError
      ? error.status
      : typeof (error as { status?: unknown })?.status === "number"
        ? (error as { status: number }).status
        : null;
  if (status !== null) {
    return status === 408 || status === 429 || status >= 500;
  }
  return error instanceof TypeError;
}

function retryDelayMs(attempt: number, baseDelayMs: number): number {
  return baseDelayMs * 2 ** attempt;
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function throwIfProviderTimedOut(signal: AbortSignal, error?: unknown): void {
  const reason = signal.reason;
  if (signal.aborted && reason instanceof ProviderTimeoutError) {
    throw reason;
  }
  if (signal.aborted && reason instanceof TurnTimeoutError) {
    throw reason;
  }
  if (error instanceof ProviderTimeoutError) {
    throw error;
  }
  if (error instanceof TurnTimeoutError) {
    throw error;
  }
}

function createTurnDeadline(
  env: Record<string, string | undefined> | undefined
): TurnDeadline {
  const timeoutMs = readTurnTimeoutMs(env);
  return { expiresAtMs: Date.now() + timeoutMs, timeoutMs };
}

function remainingTurnMs(deadline: TurnDeadline): number {
  return Math.max(0, deadline.expiresAtMs - Date.now());
}

function throwIfTurnTimedOut(deadline: TurnDeadline): void {
  if (remainingTurnMs(deadline) <= 0) {
    throw new TurnTimeoutError(deadline.timeoutMs);
  }
}

function buildOpenAiInput(request: RunRequest): OpenAiInputItem[] {
  const recentMessages = request.input.context?.recentMessages ?? [];
  const history = recentMessages
    .map((message) => `${message.author}: ${message.text}`)
    .join("\n");
  const toolCatalog = formatSelectedToolCatalog(request);
  const attachmentContext = formatCurrentRequestAttachments(request);
  const scheduledJobContext = formatScheduledJobContext(request);
  const text = [
    "You are Burble, a concise Slack-native work assistant.",
    "Format answers as Slack mrkdwn, not standard Markdown: use *bold* instead of **bold** and <url|label> instead of [label](url).",
    attachmentContext,
    scheduledJobContext,
    toolCatalog
      ? [
          "Use burble_provider_call only when provider data or actions are needed.",
          "When calling it, pass exactly one listed tool alias as toolName and a JSON object matching that tool's input hint as input.",
          toolCatalog
        ].join("\n")
      : "No Burble provider tools are available for this turn.",
    history ? `Recent conversation:\n${history}` : "",
    `User: ${request.input.text.trim()}`
  ]
    .filter(Boolean)
    .join("\n\n");
  return [{ role: "user", content: text }];
}

function buildOpenAiTools(request: RunRequest): OpenAiInputItem[] {
  const tools = selectedRuntimeTools(request);
  if (tools.length === 0) {
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
              "The exact Burble tool alias to execute. Use only aliases listed in the prompt's available Burble tools catalog."
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

type RuntimeRequestManifestTool = NonNullable<
  NonNullable<RunRequest["runtime"]["manifest"]>["tools"]
>[number];

function selectedRuntimeTools(request: RunRequest): RuntimeRequestManifestTool[] {
  if (request.input.scheduledJob) {
    const allowedTools = new Set(request.input.scheduledJob.allowedTools);
    const operationGrants = request.input.scheduledJob.operationGrants ?? [];
    const manifestTools = request.runtime.manifest?.tools ?? [];
    return manifestTools
      .filter(
        (tool) =>
          tool.enabled &&
          (allowedTools.has(tool.name) ||
            allowedTools.has(tool.alias)) &&
          (!tool.operationNameInput ||
            operationGrants.some(
              (grant) =>
                (grant.tool === tool.name || grant.tool === tool.alias) &&
                Boolean(grant.operation)
            ))
      )
      .map((tool) =>
        tool.operationNameInput
          ? narrowRuntimeToolOperations(tool, operationGrants)
          : tool
      )
      .sort(compareRuntimeTools)
      .slice(0, MAX_PROMPT_TOOLS);
  }
  const groups = new Set(request.input.toolGroups?.groups ?? []);
  if (groups.size === 0) {
    return [];
  }
  const builtInTools = selectedBuiltInRuntimeTools(request, groups);
  const manifestTools = (request.runtime.manifest?.tools ?? [])
    .filter((tool) => tool.enabled && toolMatchesSelectedGroups(tool, groups))
    .sort(compareRuntimeTools)
    .slice(0, Math.max(0, MAX_PROMPT_TOOLS - builtInTools.length));
  return [...builtInTools, ...manifestTools];
}

function narrowRuntimeToolOperations(
  tool: RuntimeRequestManifestTool,
  grants: NonNullable<
    NonNullable<RunRequest["input"]["scheduledJob"]>["operationGrants"]
  >
): RuntimeRequestManifestTool {
  const operations = grants
    .filter((grant) => grant.tool === tool.name || grant.tool === tool.alias)
    .map((grant) => grant.operation)
    .filter(Boolean)
    .toSorted();
  return {
    ...tool,
    input: tool.input.map((input) =>
      input.name === tool.operationNameInput
        ? { ...input, values: operations }
        : input
    )
  };
}

function selectedBuiltInRuntimeTools(
  request: RunRequest,
  groups: Set<string>
): RuntimeRequestManifestTool[] {
  if (!groups.has("attachments") || !request.input.attachments?.length) {
    return [];
  }
  return [
    {
      name: "conversation_get_attachment",
      alias: "conversation.getAttachment",
      provider: "conversation",
      title: "Current request attachment fetch",
      description:
        "Fetch text or supported file content for one current-turn attachment by opaque attachment id.",
      enabled: true,
      risk: "read",
      routeRequired: true,
      confirmation: "none",
      retrySafe: true,
      input: [
        {
          name: "attachmentId",
          type: "string",
          required: true,
          description: "Opaque attachment id from Current request attachments."
        }
      ]
    }
  ];
}

function toolMatchesSelectedGroups(
  tool: RuntimeRequestManifestTool,
  groups: Set<string>
): boolean {
  if (groups.has(tool.provider)) {
    return true;
  }
  if (tool.provider === "atlassian" && groups.has("jira")) {
    return true;
  }
  if (tool.alias.startsWith("gmail.") && groups.has("google")) {
    return true;
  }
  return false;
}

function compareRuntimeTools(
  left: RuntimeRequestManifestTool,
  right: RuntimeRequestManifestTool
): number {
  const provider = left.provider.localeCompare(right.provider);
  if (provider !== 0) {
    return provider;
  }
  const risk = riskRank(left.risk) - riskRank(right.risk);
  if (risk !== 0) {
    return risk;
  }
  return left.alias.localeCompare(right.alias);
}

function riskRank(risk: RuntimeRequestManifestTool["risk"]): number {
  switch (risk) {
    case "read":
      return 0;
    case "low_write":
      return 1;
    case "moderate_write":
      return 2;
    case "high_write":
      return 3;
  }
}

function formatSelectedToolCatalog(request: RunRequest): string {
  const tools = selectedRuntimeTools(request);
  if (tools.length === 0) {
    return "";
  }
  const omittedCount =
    (request.runtime.manifest?.tools ?? []).filter(
      (tool) =>
        tool.enabled &&
        toolMatchesSelectedGroups(
          tool,
          new Set(request.input.toolGroups?.groups ?? [])
        )
    ).length - tools.length;
  return [
    "Available Burble tools for this turn:",
    ...tools.map(formatRuntimeTool),
    omittedCount > 0 ? `- ${omittedCount} additional tools omitted; answer with available tools or ask for a narrower request.` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function formatCurrentRequestAttachments(request: RunRequest): string {
  const attachments = request.input.attachments ?? [];
  if (attachments.length === 0) {
    return "";
  }
  return [
    "Current request attachments:",
    "Use only the opaque attachment ids shown here. Fetch content with conversation.getAttachment and input { attachmentId } before summarizing or using an attached file.",
    ...attachments.map((attachment, index) => {
      const name = truncateForPrompt(
        attachment.name ?? "attachment",
        MAX_ATTACHMENT_NAME_CHARS
      );
      const size =
        typeof attachment.sizeBytes === "number"
          ? `, size=${attachment.sizeBytes} bytes`
          : "";
      return `- ${index + 1}. id=${attachment.id}, name=${name}, kind=${attachment.kind}, mimeType=${attachment.mimeType}${size}`;
    })
  ].join("\n");
}

function formatScheduledJobContext(request: RunRequest): string {
  const scheduledJob = request.input.scheduledJob;
  if (!scheduledJob) {
    return "";
  }
  return formatRuntimeScheduledJobContext(scheduledJob, {
    guidanceLines: [
      "Use only the listed Available Burble tools for this scheduled job. Burble Native attaches the trusted jobId to scheduled provider calls; do not invent or override job identity."
    ]
  });
}

function formatRuntimeTool(tool: RuntimeRequestManifestTool): string {
  return `- ${tool.alias}: ${truncateForPrompt(tool.description, 180)} Input: ${formatToolInput(tool)}`;
}

function formatToolInput(tool: RuntimeRequestManifestTool): string {
  if (tool.input.length === 0) {
    return "{}";
  }
  return `{ ${tool.input.map(formatToolInputField).join("; ")} }`;
}

function formatToolInputField(
  field: RuntimeRequestManifestTool["input"][number]
): string {
  const type =
    field.values && field.values.length > 0
      ? `${field.type}(${field.values.join("|")})`
      : field.type;
  const required = field.required ? "required" : "optional";
  return `${field.name}: ${type}, ${required}${field.description ? `, ${truncateForPrompt(field.description, 80)}` : ""}`;
}

function truncateForPrompt(value: string, maxLength: number): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength - 1).trimEnd()}…`;
}

async function* readSseJsonPayloads(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onClose?: (reason: "eof" | "aborted" | "consumer_stopped") => void
): AsyncIterable<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reachedEof = false;
  try {
    while (true) {
      const { value, done } = await readStreamChunkWithAbort(reader, signal);
      if (done) {
        reachedEof = true;
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
  } finally {
    const closeReason = reachedEof
      ? "eof"
      : signal.aborted
        ? "aborted"
        : "consumer_stopped";
    if (!reachedEof) {
      try {
        void reader.cancel("terminal SSE event received").catch(() => {});
      } catch {
        // A terminal protocol event is authoritative even if transport cleanup fails.
      }
    }
    reader.releaseLock();
    onClose?.(closeReason);
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

function toolResultHasError(value: unknown, depth = 0): boolean {
  if (depth > 5 || !isRecord(value)) {
    return false;
  }
  if (
    value.isError === true ||
    typeof value.error === "string" ||
    value.error === true
  ) {
    return true;
  }
  return Object.values(value).some((entry) =>
    Array.isArray(entry)
      ? entry.some((item) => toolResultHasError(item, depth + 1))
      : toolResultHasError(entry, depth + 1)
  );
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
