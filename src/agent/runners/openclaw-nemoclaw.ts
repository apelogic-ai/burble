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
      streaming: false,
      toolEvents: false,
      remote: true,
      requiresToolGateway: true
    },
    async *run(input: AgentInput): AsyncIterable<AgentRunEvent> {
      yield { type: "status", text: "Starting OpenClaw/NemoClaw runner..." };
      const runtime = deps.runtimeFactory
        ? await deps.runtimeFactory.getOrCreateRuntime(input.principal)
        : null;
      const baseUrl = runtime?.endpointUrl.replace(/\/+$/, "") ?? fallbackBaseUrl;
      if (!baseUrl) {
        throw new Error("OpenClaw/NemoClaw runtime endpoint is unavailable");
      }

      logInfo(
        [
          "OpenClaw/NemoClaw run start",
          `url=${baseUrl}/runs`,
          `runtimeId=${runtime?.id ?? "static"}`,
          `principal=${input.principal.workspaceId}:${input.principal.slackUserId}`,
          `textLength=${input.text.length}`,
          `githubConnected=${Boolean(input.connections.github)}`
        ].join(" ")
      );

      const response = await requestFetch(`${baseUrl}/runs`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...runtimeHeaders(runtime)
        },
        body: JSON.stringify({
          ...(runtime ? { runtime: sanitizeRuntimeHandle(runtime) } : {}),
          input: sanitizeAgentInput(input)
        })
      });

      if (!response.ok) {
        throw new Error(
          `OpenClaw/NemoClaw runtime returned HTTP ${response.status}`
        );
      }

      const payload = (await response.json()) as RemoteRunResponse;
      const agentResponse = validateRemoteRunResponse(payload);
      if (!agentResponse) {
        throw new Error("OpenClaw/NemoClaw runtime returned an invalid response");
      }

      logInfo(
        [
          "OpenClaw/NemoClaw run finish",
          `runtimeId=${runtime?.id ?? "static"}`,
          `classification=${agentResponse.classification}`,
          `textLength=${agentResponse.text.length}`
        ].join(" ")
      );

      yield { type: "final", response: agentResponse };
    }
  };
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
