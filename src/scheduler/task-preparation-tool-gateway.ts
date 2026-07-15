import type { Config } from "../config";
import type { TokenStore } from "../db";
import type { RuntimeFactory } from "../agent/runtime-factory";
import type { McpIdentityIssuer } from "../mcp-identity";
import { findProviderToolSpec } from "../providers/catalog";
import { handleToolGatewayRequest } from "../tool-gateway";
import type {
  ScheduledTaskPreparationToolExecutor,
  ScheduledTaskPreparationToolResult,
} from "./task-preparation";

type ToolGatewayRequestHandler = typeof handleToolGatewayRequest;

export function createToolGatewayScheduledTaskPreparationExecutor(input: {
  config: Config;
  store: TokenStore;
  runtimeFactory: RuntimeFactory;
  mcpIdentityIssuer?: McpIdentityIssuer;
  getSlackEmail: (slackUserId: string) => Promise<string>;
  handleRequest?: ToolGatewayRequestHandler;
}): ScheduledTaskPreparationToolExecutor {
  const handleRequest = input.handleRequest ?? handleToolGatewayRequest;
  return async (call) => {
    const spec = findProviderToolSpec(call.tool);
    if (!spec) {
      throw new Error(`Unknown provider tool ${call.tool}.`);
    }
    const runtime = await input.runtimeFactory.getOrCreateRuntime({
      workspaceId: call.workspaceId,
      slackUserId: call.slackUserId,
    });
    const response = await handleRequest(
      input.config,
      input.store,
      spec.alias,
      new Request(
        `http://burble.internal/internal/tools/${encodeURIComponent(spec.alias)}/execute`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${runtime.authToken}`,
            "content-type": "application/json",
            "x-burble-runtime-id": runtime.id,
          },
          body: JSON.stringify({ input: call.input }),
        },
      ),
      {
        ...(input.mcpIdentityIssuer
          ? { mcpIdentityIssuer: input.mcpIdentityIssuer }
          : {}),
        getSlackEmail: input.getSlackEmail,
      },
    );
    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(
        `Provider preparation tool ${spec.name} failed with HTTP ${response.status}${bodyText ? `: ${bodyText}` : ""}`,
      );
    }
    const body = parseJsonObject(bodyText);
    if (!body) {
      throw new Error(
        `Provider preparation tool ${spec.name} returned an invalid response.`,
      );
    }
    const content = body.content;
    const providerError = readProviderError(content);
    if (providerError) {
      throw new Error(providerError);
    }
    return normalizePreparationResult(spec.provider, spec.name, content, call.purpose);
  };
}

function normalizePreparationResult(
  provider: string,
  tool: string,
  content: unknown,
  purpose?: string,
): ScheduledTaskPreparationToolResult {
  const value = unwrapProviderContent(content);
  const resource = findResourceObject(value);
  if (!resource) {
    return { value };
  }
  const id = firstString(resource, [
    "id",
    "documentId",
    "fileId",
    "folderId",
    "presentationId",
    "spreadsheetId",
    "eventId",
    "draftId",
  ]);
  if (!id) {
    return { value };
  }
  const name = firstString(resource, ["name", "title", "summary", "subject"]);
  const webViewLink = firstString(resource, ["webViewLink", "url", "htmlUrl"]);
  const normalized = {
    id,
    ...(name ? { name } : {}),
    ...(webViewLink ? { webViewLink } : {}),
  };
  return {
    value: normalized,
    stateRef: {
      provider,
      kind: tool,
      id,
      ...(name ? { name } : {}),
      ...(purpose ? { purpose } : {}),
    },
  };
}

function unwrapProviderContent(content: unknown): unknown {
  if (!isRecord(content) || content.mcpGw !== true) {
    return content;
  }
  const result = content.result;
  if (!isRecord(result) || !Array.isArray(result.content)) {
    return result;
  }
  for (const item of result.content) {
    if (!isRecord(item) || typeof item.text !== "string") {
      continue;
    }
    try {
      return JSON.parse(item.text) as unknown;
    } catch {
      if (item.text.trim()) {
        return item.text;
      }
    }
  }
  return result;
}

function readProviderError(content: unknown): string | null {
  if (!isRecord(content) || typeof content.error !== "string") {
    return null;
  }
  return typeof content.message === "string" && content.message.trim()
    ? content.message.trim()
    : content.error;
}

function findResourceObject(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 5) {
    return null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const resource = findResourceObject(entry, depth + 1);
      if (resource) {
        return resource;
      }
    }
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }
  if (
    firstString(value, [
      "id",
      "documentId",
      "fileId",
      "folderId",
      "presentationId",
      "spreadsheetId",
      "eventId",
      "draftId",
    ])
  ) {
    return value;
  }
  for (const entry of Object.values(value)) {
    const resource = findResourceObject(entry, depth + 1);
    if (resource) {
      return resource;
    }
  }
  return null;
}

function firstString(
  value: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
