import { createRuntimeToolGatewayClient } from "@burble/runtime-sdk/tool-gateway";
import type { ToolExecutor } from "./types";

const nonIdempotentToolVerbs = [
  "add",
  "append",
  "close",
  "comment",
  "copy",
  "create",
  "delete",
  "edit",
  "move",
  "reopen",
  "request",
  "transition",
  "update"
];

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
    shouldRetryTool: shouldRetryBurbleProviderTool,
    ...(input.fetch ? { fetch: input.fetch } : {})
  });
  return (toolName, body) => toolGateway.execute(toolName, body);
}

function shouldRetryBurbleProviderTool(toolName: string): boolean {
  return !isNonIdempotentBurbleProviderTool(toolName);
}

function isNonIdempotentBurbleProviderTool(toolName: string): boolean {
  const normalized = toolName
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
  return nonIdempotentToolVerbs.some(
    (verb) =>
      normalized.includes(`.${verb}`) ||
      normalized.startsWith(`${verb}.`) ||
      normalized.includes(`_${verb}_`) ||
      normalized.endsWith(`_${verb}`)
  );
}
