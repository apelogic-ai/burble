import { createParser } from "eventsource-parser";
import type { AgentInput, AgentOutput, AgentRunEvent, AgentRunner } from "../types";
import type { ToolClassification } from "../../conversation/types";
import type { RuntimeFactory, RuntimeHandle } from "../runtime-factory";

export type AgentRuntimeFetch = (
  input: string,
  init: RequestInit
) => Promise<Response>;

export type AgentRuntimeWebSocket = {
  addEventListener: (
    type: "message" | "error" | "close",
    listener: (event: { data?: unknown }) => void
  ) => void;
  close: () => void;
};

export type AgentRuntimeWebSocketFactory = (
  url: string
) => AgentRuntimeWebSocket;

export type OpenClawNemoClawAgentRunnerDeps = {
  baseUrl?: string;
  runtimeFactory?: RuntimeFactory;
  fetch?: AgentRuntimeFetch;
  webSocketFactory?: AgentRuntimeWebSocketFactory;
  logInfo?: (message: string) => void;
};

type RemoteRunResponse = {
  response?: AgentOutput;
};

type RemoteRunStartResponse = {
  runId?: string;
  eventsUrl?: string;
};

type RemoteRunEvent =
  | { type: "status"; text: string }
  | { type: "tool_call"; toolName: string; callId: string }
  | {
      type: "tool_result";
      toolName: string;
      callId: string;
      classification: ToolClassification;
    }
  | { type: "message_delta"; text: string }
  | { type: "final"; response: AgentOutput }
  | { type: "error"; message: string };

type ConnectionSummary = {
  connected: boolean;
  email?: string;
  providerLogin?: string;
};

export function createOpenClawNemoClawAgentRunner(
  deps: OpenClawNemoClawAgentRunnerDeps
): AgentRunner {
  if (!deps.baseUrl && !deps.runtimeFactory) {
    throw new Error("OPENCLAW_NEMOCLAW_URL or runtimeFactory is required");
  }

  const fallbackBaseUrl = deps.baseUrl?.replace(/\/+$/, "");
  const requestFetch: AgentRuntimeFetch = deps.fetch ?? fetch;
  const createWebSocket: AgentRuntimeWebSocketFactory =
    deps.webSocketFactory ?? ((url) => new WebSocket(url));
  const logInfo = deps.logInfo ?? (() => undefined);

  return {
    name: "openclaw-nemoclaw",
    capabilities: {
      streaming: true,
      remote: true,
      requiresToolGateway: true,
      toolEvents: true
    },
    async *run(input: AgentInput): AsyncIterable<AgentRunEvent> {
      const runId = crypto.randomUUID();
      yield {
        type: "status",
        text: "Preparing your OpenClaw/NemoClaw runtime..."
      };
      const runtime = deps.runtimeFactory
        ? await deps.runtimeFactory.getOrCreateRuntime(input.principal)
        : null;
      const baseUrl = runtime?.endpointUrl.replace(/\/+$/, "") ?? fallbackBaseUrl;
      if (!baseUrl) {
        throw new Error("OpenClaw/NemoClaw runtime endpoint is unavailable");
      }

      yield { type: "status", text: "Running OpenClaw/NemoClaw..." };

      logInfo(
        [
          "OpenClaw/NemoClaw run start",
          `runId=${runId}`,
          `url=${baseUrl}/runs`,
          `runtimeId=${runtime?.id ?? "static"}`,
          `principal=${input.principal.workspaceId}:${input.principal.slackUserId}`,
          `conversationRoot=${input.conversation?.rootId ?? "unknown"}`,
          `textLength=${input.text.length}`,
          `githubConnected=${Boolean(input.connections.github)}`,
          `jiraConnected=${Boolean(input.connections.jira)}`
        ].join(" ")
      );
      if (runtime) {
        deps.runtimeFactory?.recordRuntimeEvent?.(runtime.id, {
          eventType: "runtime_run_started",
          summary: {
            conversationRoot: input.conversation?.rootId ?? "unknown",
            textLength: input.text.length,
            githubConnected: Boolean(input.connections.github),
            jiraConnected: Boolean(input.connections.jira)
          }
        });
      }

      const runBody = {
        runId,
        ...(runtime ? { runtime: sanitizeRuntimeHandle(runtime) } : {}),
        input: sanitizeAgentInput(input)
      };
      const runUrl = `${baseUrl}/runs`;
      const response = await postRuntimeRun(
        requestFetch,
        runUrl,
        runtime,
        runBody,
        "application/json",
        "respond-async"
      );

      if (!response.ok) {
        throw new Error(
          `OpenClaw/NemoClaw runtime returned HTTP ${response.status}`
        );
      }

      let agentResponse: AgentOutput | null;
      const startPayload = (await response.json()) as RemoteRunResponse &
        RemoteRunStartResponse;
      const legacyResponse = validateRemoteRunResponse(startPayload);
      if (legacyResponse) {
        agentResponse = legacyResponse;
      } else {
        const startedRunId = validateRemoteRunStartResponse(startPayload);
        if (!startedRunId) {
          throw new Error("OpenClaw/NemoClaw runtime returned an invalid response");
        }

        const eventsUrl = toWebSocketUrl(
          new URL(
            startPayload.eventsUrl ?? `/runs/${encodeURIComponent(startedRunId)}/events`,
            `${baseUrl}/`
          ).toString()
        );

        try {
          agentResponse = yield* readWebSocketRunResponse(
            createWebSocket(eventsUrl)
          );
        } catch (error) {
          if (!isRuntimeStreamClosedError(error)) {
            throw error;
          }

          logInfo(
            [
              "OpenClaw/NemoClaw event socket closed before final",
              `runId=${startedRunId}`,
              `runtimeId=${runtime?.id ?? "static"}`,
              "fallback=json"
            ].join(" ")
          );
          const fallbackResponse = await getRuntimeRun(
            requestFetch,
            `${baseUrl}/runs/${encodeURIComponent(startedRunId)}`,
            runtime
          );
          if (!fallbackResponse.ok) {
            throw new Error(
              `OpenClaw/NemoClaw runtime returned HTTP ${fallbackResponse.status}`
            );
          }
          agentResponse = await readJsonRunResponse(fallbackResponse);
        }
      }
      if (!agentResponse) {
        throw new Error("OpenClaw/NemoClaw runtime returned an invalid response");
      }

      logInfo(
        [
          "OpenClaw/NemoClaw run finish",
          `runId=${runId}`,
          `runtimeId=${runtime?.id ?? "static"}`,
          `classification=${agentResponse.classification}`,
          `textLength=${agentResponse.text.length}`
        ].join(" ")
      );
      if (runtime) {
        deps.runtimeFactory?.recordRuntimeEvent?.(runtime.id, {
          eventType: "runtime_run_finished",
          summary: {
            classification: agentResponse.classification,
            textLength: agentResponse.text.length
          }
        });
      }

      yield { type: "final", response: agentResponse };
    }
  };
}

function postRuntimeRun(
  requestFetch: AgentRuntimeFetch,
  url: string,
  runtime: RuntimeHandle | null,
  body: unknown,
  accept: string,
  prefer?: string
): Promise<Response> {
  return requestFetch(url, {
    method: "POST",
    headers: {
      accept,
      "content-type": "application/json",
      ...(prefer ? { prefer } : {}),
      ...runtimeHeaders(runtime)
    },
    body: JSON.stringify(body)
  });
}

function getRuntimeRun(
  requestFetch: AgentRuntimeFetch,
  url: string,
  runtime: RuntimeHandle | null
): Promise<Response> {
  return requestFetch(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      ...runtimeHeaders(runtime)
    }
  });
}

async function readJsonRunResponse(
  response: Response
): Promise<AgentOutput | null> {
  const payload = (await response.json()) as RemoteRunResponse;
  return validateRemoteRunResponse(payload);
}

async function* readWebSocketRunResponse(
  socket: AgentRuntimeWebSocket
): AsyncIterable<AgentRunEvent, AgentOutput | null> {
  const queue: unknown[] = [];
  let closed = false;
  let failed: Error | null = null;
  let wake: (() => void) | undefined;

  const wakeReader = () => {
    wake?.();
    wake = undefined;
  };

  socket.addEventListener("message", (event) => {
    try {
      queue.push(JSON.parse(String(event.data ?? "")));
    } catch (error) {
      failed = error instanceof Error ? error : new Error("Invalid runtime event");
    }
    wakeReader();
  });
  socket.addEventListener("error", () => {
    failed = new Error("Runtime event socket errored");
    wakeReader();
  });
  socket.addEventListener("close", () => {
    closed = true;
    wakeReader();
  });

  try {
    while (true) {
      while (queue.length > 0) {
        const event = validateRemoteRunEvent(queue.shift());
        if (!event) {
          throw new Error("OpenClaw/NemoClaw runtime returned an invalid stream event");
        }

        if (event.type === "error") {
          throw new Error(event.message);
        }

        if (event.type === "final") {
          socket.close();
          return event.response;
        }

        yield event;
      }

      if (failed) {
        throw failed;
      }
      if (closed) {
        throw new Error("Runtime event socket closed before final");
      }

      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    socket.close();
  }
}

async function* readStreamingRunResponse(
  response: Response
): AsyncIterable<AgentRunEvent, AgentOutput | null> {
  if (!response.body) {
    return null;
  }

  let streamedText = "";
  try {
    for await (const payload of readRuntimeEventStream(response)) {
      const event = validateRemoteRunEvent(payload);
      if (!event) {
        throw new Error("OpenClaw/NemoClaw runtime returned an invalid stream event");
      }

      if (event.type === "error") {
        throw new Error(event.message);
      }

      if (event.type === "final") {
        return event.response;
      }

      if (event.type === "message_delta") {
        streamedText = appendStreamedText(streamedText, event.text);
      }

      yield event;
    }
  } catch (error) {
    if (streamedText.trim() && isRuntimeStreamClosedError(error)) {
      return {
        classification: "user_private",
        text: streamedText.trim()
      };
    }

    throw error;
  }

  if (streamedText.trim()) {
    return {
      classification: "user_private",
      text: streamedText.trim()
    };
  }
  return null;
}

function readRuntimeEventStream(
  response: Response
): AsyncIterable<unknown> {
  return isSseResponse(response)
    ? readSse(response.body!)
    : readNdjson(response.body!);
}

function appendStreamedText(currentText: string, delta: string): string {
  if (!delta.trim()) {
    return currentText;
  }

  return currentText && !currentText.endsWith("...")
    ? `${currentText}${delta}`
    : delta.trimStart();
}

function isRuntimeStreamClosedError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return /socket connection was closed|event socket closed before final|connection.*closed|stream.*closed|terminated|econnreset/i.test(
    error.message
  );
}

async function* readNdjson(
  body: ReadableStream<Uint8Array>
): AsyncIterable<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }

      buffer += decoder.decode(result.value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          yield JSON.parse(trimmed);
        }
      }
    }

    buffer += decoder.decode();
    const trimmed = buffer.trim();
    if (trimmed) {
      yield JSON.parse(trimmed);
    }
  } finally {
    reader.releaseLock();
  }
}

async function* readSse(
  body: ReadableStream<Uint8Array>
): AsyncIterable<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const events: unknown[] = [];
  let parseError: Error | null = null;
  const parser = createParser({
    onEvent(event) {
      events.push(JSON.parse(event.data));
    },
    onError(error) {
      parseError = error;
    }
  });

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }

      parser.feed(decoder.decode(result.value, { stream: true }));
      if (parseError) {
        throw parseError;
      }

      while (events.length > 0) {
        yield events.shift();
      }
    }

    const remaining = decoder.decode();
    if (remaining) {
      parser.feed(remaining);
    }
    parser.reset({ consume: true });
    if (parseError) {
      throw parseError;
    }

    while (events.length > 0) {
      yield events.shift();
    }
  } finally {
    reader.releaseLock();
  }
}

function isStreamingResponse(response: Response): boolean {
  return isSseResponse(response) || isNdjsonResponse(response);
}

function isSseResponse(response: Response): boolean {
  return (response.headers.get("content-type") ?? "")
    .toLowerCase()
    .startsWith("text/event-stream");
}

function isNdjsonResponse(response: Response): boolean {
  return (response.headers.get("content-type") ?? "")
    .toLowerCase()
    .startsWith("application/x-ndjson");
}

function runtimeHeaders(runtime: RuntimeHandle | null): Record<string, string> {
  if (!runtime) {
    return {};
  }

  return {
    "x-burble-runtime-id": runtime.id
  };
}

function sanitizeRuntimeHandle(runtime: RuntimeHandle): {
  id: string;
  engine: RuntimeHandle["engine"];
  status: RuntimeHandle["status"];
} {
  return {
    id: runtime.id,
    engine: runtime.engine,
    status: runtime.status
  };
}

const classifications: ReadonlySet<ToolClassification> = new Set([
  "public",
  "user_private",
  "restricted"
]);

function validateRemoteRunResponse(payload: RemoteRunResponse): AgentOutput | null {
  const response = payload.response;
  if (!response) {
    return null;
  }

  if (
    typeof response.text !== "string" ||
    !classifications.has(response.classification)
  ) {
    return null;
  }

  return response;
}

function validateRemoteRunStartResponse(
  payload: RemoteRunStartResponse
): string | null {
  return typeof payload.runId === "string" && payload.runId.trim().length > 0
    ? payload.runId
    : null;
}

function validateRemoteRunEvent(payload: unknown): RemoteRunEvent | null {
  if (typeof payload !== "object" || payload === null || !("type" in payload)) {
    return null;
  }

  const event = payload as RemoteRunEvent;
  switch (event.type) {
    case "status":
    case "message_delta":
      return typeof event.text === "string" ? event : null;
    case "tool_call":
      return typeof event.toolName === "string" &&
        typeof event.callId === "string"
        ? event
        : null;
    case "tool_result":
      return typeof event.toolName === "string" &&
        typeof event.callId === "string" &&
        classifications.has(event.classification)
        ? event
        : null;
    case "error":
      return typeof event.message === "string" ? event : null;
    case "final":
      return validateRemoteRunResponse({ response: event.response })
        ? event
        : null;
    default:
      return null;
  }
}

function toWebSocketUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol === "https:") {
    parsed.protocol = "wss:";
  } else if (parsed.protocol === "http:") {
    parsed.protocol = "ws:";
  }
  return parsed.toString();
}

function sanitizeAgentInput(input: AgentInput): {
  text: string;
  conversation?: NonNullable<AgentInput["conversation"]>;
  connections: { github: ConnectionSummary; jira: ConnectionSummary };
} {
  const github = input.connections.github;
  const jira = input.connections.jira;

  return {
    text: input.text,
    ...(input.conversation ? { conversation: input.conversation } : {}),
    connections: {
      github: github
        ? {
            connected: true,
            email: github.email,
            providerLogin: github.providerLogin
          }
        : {
            connected: false
          },
      jira: jira
        ? {
            connected: true,
            email: jira.email,
            providerLogin: jira.providerLogin
          }
        : {
            connected: false
          }
    }
  };
}
