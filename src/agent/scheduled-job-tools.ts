import {
  providerToolCatalog,
  providerToolCovers
} from "../providers/catalog";

const providerToolAliases = new Map<string, string>();

for (const tool of providerToolCatalog) {
  providerToolAliases.set(tool.name, tool.name);
  if (tool.alias) {
    providerToolAliases.set(tool.alias, tool.name);
  }
  for (const alias of tool.aliases ?? []) {
    providerToolAliases.set(alias, tool.name);
  }
}

export function normalizeScheduledJobToolName(toolName: string): string {
  const trimmed = toolName.trim();
  return providerToolAliases.get(trimmed) ?? trimmed;
}

export function normalizeScheduledJobToolNames(toolNames: string[]): string[] {
  return [
    ...new Set(
      toolNames
        .map((toolName) => normalizeScheduledJobToolName(toolName))
        .filter(Boolean)
    )
  ].sort();
}

export function isScheduledJobToolAllowed(input: {
  requiredTools: string[];
  toolName: string;
}): boolean {
  const toolName = normalizeScheduledJobToolName(input.toolName);
  return normalizeScheduledJobToolNames(input.requiredTools).some(
    (requiredTool) => providerToolCovers(requiredTool, toolName)
  );
}
