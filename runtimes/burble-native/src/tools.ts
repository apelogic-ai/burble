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
  fetch?: BurbleNativeToolGatewayFetch;
}): ToolExecutor {
  const toolGateway = createRuntimeToolGatewayClient({
    baseUrl: input.toolGatewayUrl,
    runtimeToken: input.runtimeToken,
    ...(input.runtimeId ? { runtimeId: input.runtimeId } : {}),
    ...(input.fetch ? { fetch: input.fetch } : {})
  });
  return (toolName, body) => toolGateway.execute(toolName, body);
}
