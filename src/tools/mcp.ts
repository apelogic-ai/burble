import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  type StdioServerParameters
} from "@modelcontextprotocol/sdk/client/stdio.js";

export type McpToolCall = {
  toolName: string;
  arguments?: Record<string, unknown>;
};

export type McpToolClient = {
  callTool(input: McpToolCall): Promise<unknown>;
  close(): Promise<void>;
};

export type StdioMcpToolClientConfig = {
  name: string;
  version: string;
  server: StdioServerParameters;
};

export async function createStdioMcpToolClient(
  config: StdioMcpToolClientConfig
): Promise<McpToolClient> {
  const client = new Client({
    name: config.name,
    version: config.version
  });
  const transport = new StdioClientTransport(config.server);

  await client.connect(transport);

  return {
    callTool(input) {
      return client.callTool({
        name: input.toolName,
        arguments: input.arguments ?? {}
      });
    },
    close() {
      return client.close();
    }
  };
}

export function extractMcpTextContent(result: unknown): string[] {
  if (!isRecord(result) || !Array.isArray(result.content)) {
    return [];
  }

  return result.content.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }

    if (item.type === "text" && typeof item.text === "string") {
      return [item.text];
    }

    if (item.type === "resource" && isRecord(item.resource)) {
      return typeof item.resource.text === "string" ? [item.resource.text] : [];
    }

    return [];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
