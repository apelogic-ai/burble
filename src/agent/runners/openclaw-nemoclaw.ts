import type { AgentInput, AgentOutput, AgentRunEvent, AgentRunner } from "../types";
import type { ToolClassification } from "../../conversation/types";

export type AgentRuntimeFetch = (
  input: string,
  init: RequestInit
) => Promise<Response>;

export type OpenClawNemoClawAgentRunnerDeps = {
  baseUrl: string;
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
  const baseUrl = deps.baseUrl.replace(/\/+$/, "");
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

      logInfo(
        [
          "OpenClaw/NemoClaw run start",
          `url=${baseUrl}/runs`,
          `textLength=${input.text.length}`,
          `githubConnected=${Boolean(input.connections.github)}`
        ].join(" ")
      );

      const response = await requestFetch(`${baseUrl}/runs`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
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
          `classification=${agentResponse.classification}`,
          `textLength=${agentResponse.text.length}`
        ].join(" ")
      );

      yield { type: "final", response: agentResponse };
    }
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
