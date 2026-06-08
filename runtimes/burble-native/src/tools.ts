import { createRuntimeToolGatewayClient } from "@burble/runtime-sdk/tool-gateway";
import type { ToolExecutor } from "./types";

export type BurbleNativeToolGatewayFetch = (
  url: string,
  init?: RequestInit
) => Promise<Response>;

export function createBurbleNativeToolExecutor(input: {
  toolGatewayUrl: string;
  runtimeToken: string;
  runtimeId?: string;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  fetch?: BurbleNativeToolGatewayFetch;
}): ToolExecutor {
  const toolGateway = createRuntimeToolGatewayClient({
    baseUrl: input.toolGatewayUrl,
    runtimeToken: input.runtimeToken,
    ...(input.runtimeId ? { runtimeId: input.runtimeId } : {}),
    ...(input.maxAttempts ? { maxAttempts: input.maxAttempts } : {}),
    ...(input.retryBaseDelayMs !== undefined
      ? { retryBaseDelayMs: input.retryBaseDelayMs }
      : {}),
    ...(input.fetch ? { fetch: input.fetch } : {})
  });
  return (toolName, body) => toolGateway.execute(toolName, body);
}
