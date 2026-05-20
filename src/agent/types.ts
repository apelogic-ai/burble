import type { ProviderConnection } from "../db";
import type { ToolClassification } from "../conversation/types";

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

export type AgentRunner = (input: AgentInput) => Promise<AgentOutput>;
