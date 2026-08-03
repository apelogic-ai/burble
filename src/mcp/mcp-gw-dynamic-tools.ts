import type { UpstreamMcpTool } from "./upstream-http-client";

export function advertisedDynamicTools(input: {
  tools: UpstreamMcpTool[];
  isOperationName: (name: string) => boolean;
  excludedNames?: readonly string[];
  limit?: number;
}) {
  const excludedNames = new Set(input.excludedNames ?? []);
  return input.tools
    .filter(
      (tool) =>
        input.isOperationName(tool.name) && !excludedNames.has(tool.name)
    )
    .slice(0, input.limit ?? 100)
    .map(sanitizeDynamicTool);
}

export function isAdvertisedDynamicOperation(input: {
  name: string;
  tools: UpstreamMcpTool[];
  isOperationName: (name: string) => boolean;
  excludedNames?: readonly string[];
}): boolean {
  const excludedNames = new Set(input.excludedNames ?? []);
  return (
    input.isOperationName(input.name) &&
    !excludedNames.has(input.name) &&
    input.tools.some((tool) => tool.name === input.name)
  );
}

export function dynamicToolArguments(
  value: unknown
): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function dynamicOperationName(
  input: Record<string, unknown>,
  key = "name"
): string {
  const value = input[key];
  return typeof value === "string" ? value.trim() : "";
}

function sanitizeDynamicTool(tool: UpstreamMcpTool) {
  return {
    name: tool.name,
    ...(tool.title ? { title: tool.title } : {}),
    ...(tool.description ? { description: tool.description } : {}),
    ...(tool.inputSchema !== undefined
      ? { inputSchema: boundedJson(tool.inputSchema, 12_000) }
      : {})
  };
}

function boundedJson(value: unknown, maxLength: number): unknown {
  try {
    const serialized = JSON.stringify(value);
    return serialized.length <= maxLength ? JSON.parse(serialized) : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
