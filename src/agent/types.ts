import type { ProviderConnection } from "../db";
import type { ToolClassification } from "../conversation/types";

export type AgentRunnerCapabilities = {
  streaming: boolean;
  toolEvents: boolean;
  remote: boolean;
  requiresToolGateway?: boolean;
};

export type AgentInput = {
  text: string;
  connections: {
    github: ProviderConnection | null;
  };
};

export type AgentOutput = {
  classification: ToolClassification;
  text: string;
  blocks?: unknown[];
};

export type AgentRunEvent =
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

export type AgentRunner = {
  name: string;
  capabilities: AgentRunnerCapabilities;
  run: (input: AgentInput) => AsyncIterable<AgentRunEvent>;
};

export async function collectAgentRun(
  runner: AgentRunner,
  input: AgentInput
): Promise<AgentOutput> {
  for await (const event of runner.run(input)) {
    if (event.type === "error") {
      throw new Error(event.message);
    }

    if (event.type === "final") {
      return event.response;
    }
  }

  throw new Error(`Agent runner ${runner.name} finished without a final response`);
}
