import type { RuntimeConfig } from "./config";
import type { ToolExecutor, ToolResult } from "./types";

export function createBurbleToolExecutor(config: RuntimeConfig): ToolExecutor {
  return async (toolName, body) => {
    const response = await fetch(
      `${config.toolGatewayUrl}/${encodeURIComponent(toolName)}/execute`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.internalToken}`
        },
        body: JSON.stringify(body)
      }
    );

    if (!response.ok) {
      throw new Error(`Burble tool gateway returned HTTP ${response.status}`);
    }

    return (await response.json()) as ToolResult;
  };
}
