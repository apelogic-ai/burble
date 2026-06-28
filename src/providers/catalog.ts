import { providerDescriptors } from "./descriptors";
import type { ProviderToolSpec } from "./tool-specs";

export const providerToolCatalog: ProviderToolSpec[] =
  providerDescriptors.flatMap((descriptor) => descriptor.tools);

export function findProviderToolSpec(toolName: string): ProviderToolSpec | null {
  return (
    providerToolCatalog.find(
      (tool) =>
        tool.name === toolName ||
        tool.alias === toolName ||
        (tool.aliases ?? []).includes(toolName),
    ) ?? null
  );
}

export function isProviderToolReadSafe(toolName: string): boolean {
  const tool = findProviderToolSpec(toolName);
  return !tool?.risk || tool.risk === "read";
}
