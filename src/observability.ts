import { createHash } from "node:crypto";
import { mkdirSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type ObservabilityUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
};

export type ObservabilityEventInput = {
  name: string;
  traceId?: string;
  runId?: string;
  sessionId?: string;
  workspaceId?: string;
  principalId?: string;
  runtimeId?: string;
  runtimeType?: string;
  routeId?: string;
  jobId?: string;
  model?: string;
  provider?: string;
  toolName?: string;
  callId?: string;
  classification?: string;
  durationMs?: number;
  status?: "ok" | "error";
  usage?: ObservabilityUsage;
  attributes?: Record<string, unknown>;
  content?: Record<string, unknown>;
  error?: {
    name?: string;
    message: string;
    code?: string;
  };
};

export type ObservabilityEvent = ObservabilityEventInput & {
  schemaVersion: 1;
  timestamp: string;
};

export type ObservabilitySink = {
  emit: (event: ObservabilityEventInput) => void;
};

export type JsonlObservabilityOptions = {
  path: string;
  includeContent?: boolean;
  now?: () => Date;
};

export type PartitionedJsonlObservabilityOptions = {
  dir: string;
  includeContent?: boolean;
  observerNormalized?: boolean;
  now?: () => Date;
};

export type ObserverTraceEntry = {
  id: string;
  timestamp: string;
  agent: string;
  sessionId: string;
  entryType:
    | "message"
    | "tool_call"
    | "tool_result"
    | "reasoning"
    | "task_summary"
    | "token_usage";
  role: "user" | "assistant" | "system" | "tool";
  model: string | null;
  tokenUsage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
    reasoning: number;
  } | null;
  developer: string;
  machine: string;
  project: string;
  toolName: string | null;
  toolCallId: string | null;
  filePath: string | null;
  command: string | null;
  taskSummary: string | null;
  gitRepo: string | null;
  gitBranch: string | null;
  gitCommit: string | null;
  userPrompt: string | null;
  assistantText: string | null;
  thinking: string | null;
  reasoning: string | null;
  systemPrompt: string | null;
  toolResultContent: string | null;
  fileContent: string | null;
  stdout: string | null;
  queryData: string | null;
  exitCode: number | null;
  durationMs: number | null;
  success: boolean | null;
};

const sensitiveKeyPattern =
  /(authorization|cookie|credential|jwt|oauth|password|refresh|secret|token)/i;

export function createNoopObservabilitySink(): ObservabilitySink {
  return {
    emit: () => undefined
  };
}

export function createJsonlObservabilitySink(
  options: JsonlObservabilityOptions
): ObservabilitySink {
  mkdirSync(dirname(options.path), { recursive: true });
  const now = options.now ?? (() => new Date());
  return {
    emit: (input) => {
      const event: ObservabilityEvent = {
        schemaVersion: 1,
        timestamp: now().toISOString(),
        ...sanitizeEvent(input, Boolean(options.includeContent))
      };
      appendFileSync(options.path, `${JSON.stringify(event)}\n`, "utf8");
    }
  };
}

export function createPartitionedJsonlObservabilitySink(
  options: PartitionedJsonlObservabilityOptions
): ObservabilitySink {
  mkdirSync(options.dir, { recursive: true });
  const now = options.now ?? (() => new Date());
  const observerNormalized = options.observerNormalized ?? true;
  return {
    emit: (input) => {
      const timestamp = now();
      const event: ObservabilityEvent = {
        schemaVersion: 1,
        timestamp: timestamp.toISOString(),
        ...sanitizeEvent(input, Boolean(options.includeContent))
      };
      const path = partitionedEventPath(options.dir, timestamp, event);
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
      if (observerNormalized) {
        const traceEntry = toObserverTraceEntry(event);
        if (traceEntry) {
          const tracePath = observerNormalizedEventPath(
            options.dir,
            timestamp,
            traceEntry
          );
          mkdirSync(dirname(tracePath), { recursive: true });
          appendFileSync(tracePath, `${JSON.stringify(traceEntry)}\n`, "utf8");
        }
      }
    }
  };
}

export function createObservabilitySink(input: {
  path: string | null;
  dir?: string | null;
  includeContent?: boolean;
}): ObservabilitySink {
  if (!input.path) {
    if (input.dir) {
      return createPartitionedJsonlObservabilitySink({
        dir: input.dir,
        includeContent: input.includeContent
      });
    }
    return createNoopObservabilitySink();
  }

  return createJsonlObservabilitySink({
    path: input.path,
    includeContent: input.includeContent
  });
}

function partitionedEventPath(
  rootDir: string,
  timestamp: Date,
  event: ObservabilityEvent
): string {
  return join(
    rootDir,
    `year=${timestamp.getUTCFullYear()}`,
    `month=${String(timestamp.getUTCMonth() + 1).padStart(2, "0")}`,
    `day=${String(timestamp.getUTCDate()).padStart(2, "0")}`,
    `hour=${String(timestamp.getUTCHours()).padStart(2, "0")}`,
    `workspace=${safePathSegment(event.workspaceId ?? "unknown")}`,
    `runtime=${safePathSegment(event.runtimeType ?? "app")}`,
    "events.jsonl"
  );
}

function observerNormalizedEventPath(
  rootDir: string,
  timestamp: Date,
  entry: ObserverTraceEntry
): string {
  return join(
    rootDir,
    "observer-normalized",
    [
      timestamp.getUTCFullYear(),
      String(timestamp.getUTCMonth() + 1).padStart(2, "0"),
      String(timestamp.getUTCDate()).padStart(2, "0")
    ].join("-"),
    safePathSegment(entry.agent),
    `${safePathSegment(entry.sessionId)}.jsonl`
  );
}

function toObserverTraceEntry(event: ObservabilityEvent): ObserverTraceEntry | null {
  if (event.name === "runtime.heartbeat") {
    return null;
  }

  const entryShape = observerEntryShape(event);
  if (!entryShape) {
    return null;
  }

  const textContent = typeof event.content?.text === "string"
    ? event.content.text
    : null;
  const tokenUsage = event.usage
    ? {
        input: event.usage.inputTokens ?? 0,
        output: event.usage.outputTokens ?? 0,
        cacheRead: event.usage.cachedInputTokens ?? 0,
        cacheCreation: 0,
        reasoning: event.usage.reasoningTokens ?? 0
      }
    : null;
  const taskSummary = typeof event.attributes?.text === "string"
    ? event.attributes.text
    : null;
  const sessionId =
    event.sessionId ?? event.runId ?? event.traceId ?? event.callId ?? "unknown";
  const base: Omit<ObserverTraceEntry, "id"> = {
    timestamp: event.timestamp,
    agent: event.runtimeType ?? "burble",
    sessionId,
    entryType: entryShape.entryType,
    role: entryShape.role,
    model: event.model ?? null,
    tokenUsage,
    developer: event.principalId ?? "unknown",
    machine: event.runtimeId ?? event.workspaceId ?? "unknown",
    project: event.workspaceId ?? "unknown",
    toolName: event.toolName ?? null,
    toolCallId: event.callId ?? null,
    filePath: null,
    command: null,
    taskSummary: entryShape.entryType === "task_summary" ? taskSummary : null,
    gitRepo: null,
    gitBranch: null,
    gitCommit: null,
    userPrompt:
      entryShape.entryType === "message" && entryShape.role === "user"
        ? textContent
        : null,
    assistantText:
      entryShape.entryType === "message" && entryShape.role === "assistant"
        ? textContent
        : null,
    thinking: null,
    reasoning: null,
    systemPrompt: null,
    toolResultContent: null,
    fileContent: null,
    stdout: null,
    queryData: null,
    exitCode: null,
    durationMs: event.durationMs ?? null,
    success: event.status ? event.status === "ok" : null
  };

  return {
    id: stableTraceEntryId(event, base),
    ...base
  };
}

function observerEntryShape(event: ObservabilityEvent): Pick<
  ObserverTraceEntry,
  "entryType" | "role"
> | null {
  if (event.name === "conversation.request.started") {
    return { entryType: "message", role: "user" };
  }

  if (
    event.name === "conversation.response.completed" ||
    event.name === "agent.message.delta"
  ) {
    return { entryType: "message", role: "assistant" };
  }

  if (
    event.name === "tool.call.started" ||
    event.name === "tool.gateway.started"
  ) {
    return { entryType: "tool_call", role: "assistant" };
  }

  if (
    event.name === "tool.call.completed" ||
    event.name === "tool.gateway.completed"
  ) {
    return { entryType: "tool_result", role: "tool" };
  }

  if (event.name === "llm.call.completed" && event.usage) {
    return { entryType: "token_usage", role: "assistant" };
  }

  if (event.name === "runtime.run.completed" && event.usage) {
    return { entryType: "token_usage", role: "assistant" };
  }

  if (
    event.name === "agent.status" ||
    event.name === "runtime.run.started" ||
    event.name === "runtime.run.accepted" ||
    event.name === "conversation.request.failed"
  ) {
    return { entryType: "task_summary", role: "system" };
  }

  return null;
}

function stableTraceEntryId(
  event: ObservabilityEvent,
  entry: Omit<ObserverTraceEntry, "id">
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        timestamp: entry.timestamp,
        name: event.name,
        traceId: event.traceId,
        runId: event.runId,
        sessionId: entry.sessionId,
        toolName: entry.toolName,
        toolCallId: entry.toolCallId,
        entryType: entry.entryType,
        role: entry.role,
        durationMs: entry.durationMs,
        success: entry.success
      })
    )
    .digest("hex")
    .slice(0, 24);
}

function safePathSegment(input: string): string {
  const normalized = input.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 96);
  return normalized || "unknown";
}

function sanitizeEvent(
  input: ObservabilityEventInput,
  includeContent: boolean
): ObservabilityEventInput {
  const { attributes, content, error, ...rest } = input;
  return compactObject({
    ...rest,
    ...(attributes
      ? { attributes: sanitizeRecord(attributes) }
      : {}),
    ...(includeContent && content
      ? { content: sanitizeRecord(content) }
      : {}),
    ...(error ? { error: sanitizeError(error) } : {})
  }) as ObservabilityEventInput;
}

function sanitizeRecord(record: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (sensitiveKeyPattern.test(key)) {
      output[key] = "[redacted]";
      continue;
    }
    output[key] = sanitizeValue(value);
  }
  return output;
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }

  if (value && typeof value === "object") {
    return sanitizeRecord(value as Record<string, unknown>);
  }

  return value;
}

function sanitizeError(error: NonNullable<ObservabilityEventInput["error"]>) {
  return compactObject({
    name: error.name,
    message: error.message,
    code: error.code
  }) as NonNullable<ObservabilityEventInput["error"]>;
}

function compactObject(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      output[key] = value;
    }
  }
  return output;
}
