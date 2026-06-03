import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentRuntimeRecord, ProviderConnection, TokenStore } from "../db";
import { hubspotProviderToolSpecs } from "../providers/hubspot/tool-specs";
import { providerToolInputSchema } from "../providers/tool-specs";
import { createHubSpotTools } from "../tools/hubspot";
import type { ToolResult } from "../tools/types";
import { mcpToolResult, type ProviderMcpDeps, withConnection } from "./provider-context";
import {
  isProviderMcpToolEnabled,
  type ProviderMcpToolPolicy
} from "./provider-policy";

type HubSpotTools = ReturnType<typeof createHubSpotTools>;
type HubSpotToolArgs = Record<string, unknown>;
type HubSpotMcpHandler = (
  connection: ProviderConnection,
  args: HubSpotToolArgs
) => Promise<ToolResult<unknown>>;

export function registerHubSpotMcpTools(input: {
  server: McpServer;
  store: TokenStore;
  runtime: AgentRuntimeRecord;
  deps: Parameters<typeof createHubSpotTools>[0] & ProviderMcpDeps;
  policy?: ProviderMcpToolPolicy;
}): void {
  const hubspotTools = createHubSpotTools(input.deps);
  const handlers = createHubSpotMcpHandlers(hubspotTools);

  for (const spec of hubspotProviderToolSpecs) {
    if (!isProviderMcpToolEnabled(input.policy, spec.name)) {
      continue;
    }
    const handler = handlers[spec.implementation];
    if (!handler) {
      throw new Error(`Missing HubSpot MCP handler for ${spec.implementation}`);
    }

    input.server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: providerToolInputSchema(spec)
      },
      async (args) =>
        mcpToolResult(
          await withConnection(input.store, input.runtime, "hubspot", (connection) =>
            handler(connection, args as HubSpotToolArgs)
          )
        )
    );
  }
}

function createHubSpotMcpHandlers(
  hubspotTools: HubSpotTools
): Record<string, HubSpotMcpHandler> {
  return {
    getAuthenticatedUser: (connection) =>
      hubspotTools.getAuthenticatedUser.execute({ connection }),

    searchContacts: (connection, args) =>
      hubspotTools.searchContacts.execute({
        connection,
        input: searchInput(args)
      }),

    searchCompanies: (connection, args) =>
      hubspotTools.searchCompanies.execute({
        connection,
        input: searchInput(args)
      }),

    searchDeals: (connection, args) =>
      hubspotTools.searchDeals.execute({
        connection,
        input: searchInput(args)
      })
  };
}

function searchInput(args: HubSpotToolArgs): { query: string; limit?: number } {
  return {
    query: stringArg(args, "query"),
    ...optionalTruthyNumberField(args, "limit")
  };
}

function stringArg(args: HubSpotToolArgs, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing HubSpot MCP string argument ${name}`);
  }
  return value.trim();
}

function optionalTruthyNumberField(
  args: HubSpotToolArgs,
  name: string
): { [key: string]: number } {
  const value = args[name];
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? { [name]: value }
    : {};
}
