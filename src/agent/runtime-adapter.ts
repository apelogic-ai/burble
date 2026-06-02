import type {
  AgentInput,
  AgentRunEvent,
  AgentRunner,
  AgentRunnerCapabilities
} from "./types";

export type RuntimeAdapter = {
  name: string;
  capabilities: AgentRunnerCapabilities;
  run: (input: AgentInput) => AsyncIterable<AgentRunEvent>;
};

export function createAgentRunnerFromRuntimeAdapter(
  adapter: RuntimeAdapter
): AgentRunner {
  return {
    name: adapter.name,
    capabilities: adapter.capabilities,
    run: (input) => adapter.run(input)
  };
}
