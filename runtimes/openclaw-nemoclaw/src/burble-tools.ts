import type { RuntimeConfig } from "./config";
import type { ToolExecutor, ToolResult } from "./types";

export function createBurbleToolExecutor(
  config: RuntimeConfig,
  runtimeId?: string
): ToolExecutor {
  return async (toolName, body) => {
    const headers = new Headers({
      "content-type": "application/json",
      authorization: `Bearer ${config.internalToken}`
    });
    if (runtimeId) {
      headers.set("x-burble-runtime-id", runtimeId);
    }

    const response = await fetch(
      `${config.toolGatewayUrl}/${encodeURIComponent(toolName)}/execute`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body)
      }
    );

    if (!response.ok) {
      throw new Error(`Burble tool gateway returned HTTP ${response.status}`);
    }

    return (await response.json()) as ToolResult;
  };
}
