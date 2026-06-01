import { providerToolCatalog } from "../providers/catalog";

const providerToolAliases = new Map<string, string>();

for (const tool of providerToolCatalog) {
  providerToolAliases.set(tool.name, tool.name);
  if (tool.alias) {
    providerToolAliases.set(tool.alias, tool.name);
  }
}

providerToolAliases.set(
  "google.appendToDriveTextFile",
  "google_append_to_drive_text_file"
);

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
  const requiredTools = new Set(
    normalizeScheduledJobToolNames(input.requiredTools)
  );
  return requiredTools.has(normalizeScheduledJobToolName(input.toolName));
}
