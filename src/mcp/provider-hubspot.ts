import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentRuntimeRecord, ProviderConnection, TokenStore } from "../db";
import { isHubSpotReadableCrmObjectType } from "../providers/hubspot/client";
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
      }),

    searchCrmObjects: (connection, args) =>
      hubspotTools.searchCrmObjects.execute({
        connection,
        input: crmObjectSearchInput(args)
      }),

    listOwners: (connection, args) =>
      hubspotTools.listOwners.execute({
        connection,
        input: listInput(args)
      }),

    listUsers: (connection, args) =>
      hubspotTools.listUsers.execute({
        connection,
        input: listInput(args)
      }),

    readApiResource: (connection, args) =>
      hubspotTools.readApiResource.execute({
        connection,
        input: apiReadInput(args)
      })
  };
}

function searchInput(args: HubSpotToolArgs): { query: string; limit?: number } {
  return {
    query: stringArg(args, "query"),
    ...optionalTruthyNumberField(args, "limit")
  };
}

function crmObjectSearchInput(args: HubSpotToolArgs) {
  const objectType = stringArg(args, "objectType");
  if (!isHubSpotReadableCrmObjectType(objectType)) {
    throw new Error(`Unsupported HubSpot CRM object type ${objectType}`);
  }

  return {
    objectType,
    ...optionalStringField(args, "query"),
    ...optionalTruthyNumberField(args, "limit"),
    ...optionalStringArrayField(args, "properties")
  };
}

function listInput(args: HubSpotToolArgs): { limit?: number; after?: string } {
  return {
    ...optionalTruthyNumberField(args, "limit"),
    ...optionalStringField(args, "after")
  };
}

function apiReadInput(args: HubSpotToolArgs) {
  return {
    path: stringArg(args, "path"),
    ...(isRecord(args.query) ? { query: args.query } : {})
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

function optionalStringField(
  args: HubSpotToolArgs,
  name: string
): { [key: string]: string } {
  const value = args[name];
  return typeof value === "string" && value.trim()
    ? { [name]: value.trim() }
    : {};
}

function optionalStringArrayField(
  args: HubSpotToolArgs,
  name: string
): { [key: string]: string[] } {
  const value = args[name];
  return Array.isArray(value) &&
    value.every((item) => typeof item === "string" && item.trim())
    ? { [name]: value.map((item) => item.trim()) }
    : {};
}

function isRecord(value: unknown): value is Record<string, string | number | boolean> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
