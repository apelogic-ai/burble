import { createRuntimeToolGatewayClient } from "@burble/runtime-sdk/tool-gateway";
import type { ToolExecutor } from "./types";

export type BurbleNativeToolGatewayFetch = (
  url: string,
  init?: RequestInit
) => Promise<Response>;

export type BurbleNativeToolRetrySummary = {
  name: string;
  alias?: string;
  retrySafe?: boolean;
};

export function createBurbleNativeToolExecutor(input: {
  toolGatewayUrl: string;
  runtimeToken: string;
  runtimeId?: string;
  tools?: BurbleNativeToolRetrySummary[];
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  fetch?: BurbleNativeToolGatewayFetch;
}): ToolExecutor {
  const retrySafety = buildToolRetrySafety(input.tools ?? []);
  const toolGateway = createRuntimeToolGatewayClient({
    baseUrl: input.toolGatewayUrl,
    runtimeToken: input.runtimeToken,
    ...(input.runtimeId ? { runtimeId: input.runtimeId } : {}),
    ...(input.maxAttempts ? { maxAttempts: input.maxAttempts } : {}),
    ...(input.retryBaseDelayMs !== undefined
      ? { retryBaseDelayMs: input.retryBaseDelayMs }
      : {}),
    shouldRetryTool: (toolName) =>
      shouldRetryBurbleProviderTool(toolName, retrySafety),
    ...(input.fetch ? { fetch: input.fetch } : {})
  });
  return (toolName, body) => toolGateway.execute(toolName, body);
}

function buildToolRetrySafety(
  tools: BurbleNativeToolRetrySummary[]
): Map<string, boolean> {
  const retrySafety = new Map<string, boolean>();
  for (const tool of tools) {
    retrySafety.set(tool.name, tool.retrySafe === true);
    if (tool.alias) {
      retrySafety.set(tool.alias, tool.retrySafe === true);
    }
  }
  return retrySafety;
}

function shouldRetryBurbleProviderTool(
  toolName: string,
  retrySafety: Map<string, boolean>
): boolean {
  return retrySafety.get(toolName) === true;
}
