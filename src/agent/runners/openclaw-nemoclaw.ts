import type { AgentInput, AgentOutput, AgentRunEvent, AgentRunner } from "../types";
import type { ToolClassification } from "../../conversation/types";
import type { RuntimeFactory, RuntimeHandle } from "../runtime-factory";

export type AgentRuntimeFetch = (
  input: string,
  init: RequestInit
) => Promise<Response>;

export type OpenClawNemoClawAgentRunnerDeps = {
  baseUrl?: string;
  runtimeFactory?: RuntimeFactory;
  fetch?: AgentRuntimeFetch;
  logInfo?: (message: string) => void;
};

type RemoteRunResponse = {
  response?: AgentOutput;
};

type RemoteRunEvent =
  | { type: "status"; text: string }
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
  const logInfo = deps.logInfo ?? (() => undefined);

  return {
    name: "openclaw-nemoclaw",
    capabilities: {
      streaming: true,
      toolEvents: false,
      remote: true,
      requiresToolGateway: true
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
          `textLength=${input.text.length}`,
          `githubConnected=${Boolean(input.connections.github)}`
        ].join(" ")
      );
      if (runtime) {
        deps.runtimeFactory?.recordRuntimeEvent?.(runtime.id, {
          eventType: "runtime_run_started",
          summary: {
            textLength: input.text.length,
            githubConnected: Boolean(input.connections.github)
          }
        });
      }

      const response = await requestFetch(`${baseUrl}/runs`, {
        method: "POST",
        headers: {
          accept: "application/x-ndjson, application/json",
          "content-type": "application/json",
          ...runtimeHeaders(runtime)
        },
        body: JSON.stringify({
          runId,
          ...(runtime ? { runtime: sanitizeRuntimeHandle(runtime) } : {}),
          input: sanitizeAgentInput(input)
        })
      });

      if (!response.ok) {
        throw new Error(
          `OpenClaw/NemoClaw runtime returned HTTP ${response.status}`
        );
      }

      const agentResponse = isNdjsonResponse(response)
        ? yield* readStreamingRunResponse(response)
        : await readJsonRunResponse(response);
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

async function readJsonRunResponse(
  response: Response
): Promise<AgentOutput | null> {
  const payload = (await response.json()) as RemoteRunResponse;
  return validateRemoteRunResponse(payload);
}

async function* readStreamingRunResponse(
  response: Response
): AsyncIterable<AgentRunEvent, AgentOutput | null> {
  if (!response.body) {
    return null;
  }

  for await (const payload of readNdjson(response.body)) {
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

    yield event;
  }

  return null;
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

function validateRemoteRunEvent(payload: unknown): RemoteRunEvent | null {
  if (typeof payload !== "object" || payload === null || !("type" in payload)) {
    return null;
  }

  const event = payload as RemoteRunEvent;
  switch (event.type) {
    case "status":
    case "message_delta":
      return typeof event.text === "string" ? event : null;
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

function sanitizeAgentInput(input: AgentInput): {
  text: string;
  connections: { github: ConnectionSummary };
} {
  const github = input.connections.github;

  return {
    text: input.text,
    connections: {
      github: github
        ? {
            connected: true,
            email: github.email,
            providerLogin: github.providerLogin
          }
        : {
            connected: false
          }
    }
  };
}
