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
  now?: () => Date;
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
