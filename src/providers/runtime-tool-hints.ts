import type { ProviderToolSpec } from "./tool-specs";

export type RuntimeProviderToolHints = {
  providers: RuntimeProviderToolHintGroup[];
};

export type RuntimeProviderToolHintGroup = {
  provider: string;
  tools: RuntimeProviderToolHint[];
};

export type RuntimeProviderToolHint = {
  name: string;
  alias: string;
  description: string;
  input: ProviderToolSpec["input"];
};

export function buildRuntimeProviderToolHints(
  catalog: ProviderToolSpec[]
): RuntimeProviderToolHints {
  const byProvider = new Map<string, RuntimeProviderToolHint[]>();
  for (const tool of catalog) {
    const tools = byProvider.get(tool.provider) ?? [];
    tools.push({
      name: tool.name,
      alias: tool.alias,
      description: tool.description,
      input: tool.input
    });
    byProvider.set(tool.provider, tools);
  }

  return {
    providers: Array.from(byProvider.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([provider, tools]) => ({
        provider,
        tools: tools.sort((left, right) => left.name.localeCompare(right.name))
      }))
  };
}
