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

export function expandProviderToolDependencies(
  toolNames: readonly string[],
): string[] {
  const expanded = new Set<string>();
  const visiting = new Set<string>();

  const visit = (toolName: string): void => {
    const tool = findProviderToolSpec(toolName);
    const canonicalName = tool?.name ?? toolName;
    if (expanded.has(canonicalName)) {
      return;
    }
    if (visiting.has(canonicalName)) {
      throw new Error(`Provider tool dependency cycle includes ${canonicalName}.`);
    }
    visiting.add(canonicalName);
    for (const dependency of tool?.dependsOn ?? []) {
      visit(dependency);
    }
    visiting.delete(canonicalName);
    expanded.add(canonicalName);
  };

  for (const toolName of toolNames) {
    visit(toolName);
  }
  return [...expanded].sort();
}

export function providerToolCovers(
  actualToolName: string,
  expectedToolName: string,
): boolean {
  const actual = findProviderToolSpec(actualToolName);
  const expected = findProviderToolSpec(expectedToolName);
  if (!actual || !expected) {
    return actualToolName === expectedToolName;
  }
  return (
    actual.name === expected.name ||
    (actual.provider === expected.provider && actual.grantCoverage === "provider")
  );
}
