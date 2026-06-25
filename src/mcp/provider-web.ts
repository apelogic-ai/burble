import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { webProviderToolSpecs } from "../providers/web/tool-specs";
import { searchWeb, type WebSearchDeps } from "../providers/web/client";
import { providerToolInputSchema } from "../providers/tool-specs";
import { mcpToolResult } from "./provider-context";
import {
  isProviderMcpToolEnabled,
  type ProviderMcpToolPolicy
} from "./provider-policy";

export function registerWebMcpTools(input: {
  server: McpServer;
  deps: WebSearchDeps;
  policy?: ProviderMcpToolPolicy;
}): void {
  for (const spec of webProviderToolSpecs) {
    if (!isProviderMcpToolEnabled(input.policy, spec.name)) {
      continue;
    }
    if (spec.implementation !== "search") {
      throw new Error(`Missing Web MCP handler for ${spec.implementation}`);
    }
    input.server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: providerToolInputSchema(spec)
      },
      async (args) => {
        const record = args as Record<string, unknown>;
        return mcpToolResult(
          await searchWeb(
            {
              query: String(record.query ?? ""),
              ...(typeof record.limit === "number" ? { limit: record.limit } : {})
            },
            input.deps
          )
        );
      }
    );
  }
}

