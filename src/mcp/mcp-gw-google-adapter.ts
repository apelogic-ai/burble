import { findProviderToolSpec } from "../providers/catalog";
import type { ToolResult } from "../tools/types";
import type { McpGwToolCallResult } from "./mcp-gw-client";

export type McpGwGoogleAdaptedToolCall = {
  ok: true;
  burbleToolName: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type McpGwGoogleToolCallAdaptation =
  | McpGwGoogleAdaptedToolCall
  | {
      ok: false;
      burbleToolName: string;
      message: string;
    };

export function adaptMcpGwGoogleToolCall(
  toolName: string,
  input: unknown
): McpGwGoogleToolCallAdaptation {
  const tool = findProviderToolSpec(toolName);
  const burbleToolName = tool?.provider === "google" ? tool.name : toolName;
  const args = isOptionalObject(input) ? input : {};

  switch (burbleToolName) {
    case "google_search_drive_files":
      return {
        ok: true,
        burbleToolName,
        name: "google_drive_files_list",
        arguments: adaptMcpGwDriveFilesListArgs(args)
      };

    case "google_search_mail_messages":
      return {
        ok: true,
        burbleToolName,
        name: "google_gmail_messages_list",
        arguments: adaptMcpGwGmailMessagesListArgs(args)
      };

    case "google_docs_create_document":
      return adaptMcpGwDocsCreateArgs(burbleToolName, args);

    default:
      return {
        ok: false,
        burbleToolName,
        message: `Google tool ${burbleToolName} is not adapted for MCP-GW yet.`
      };
  }
}

export function mcpGwGoogleToolResult(
  tool: McpGwGoogleAdaptedToolCall,
  result: McpGwToolCallResult
): ToolResult<unknown> {
  if (result.status === "needs_google_connect") {
    return {
      classification: "user_private",
      content: {
        error: "google_not_connected",
        message: result.message,
        ...(result.connectUrl ? { connectUrl: result.connectUrl } : {})
      }
    };
  }

  return {
    classification: "user_private",
    content: {
      mcpGw: true,
      toolName: tool.name,
      burbleToolName: tool.burbleToolName,
      result: result.result
    }
  };
}

function adaptMcpGwDriveFilesListArgs(
  input: Record<string, unknown>
): Record<string, unknown> {
  const q = buildMcpGwDriveFilesQuery(input);
  return {
    ...(q ? { q } : {}),
    ...(typeof input.limit === "number" ? { pageSize: input.limit } : {}),
    orderBy: "modifiedTime desc"
  };
}

function buildMcpGwDriveFilesQuery(input: Record<string, unknown>): string {
  const clauses = ["trashed = false"];
  if (typeof input.query === "string" && input.query.trim()) {
    clauses.push(
      `name contains '${escapeMcpGwDriveQueryString(input.query.trim())}'`
    );
  }
  if (typeof input.mimeType === "string" && input.mimeType.trim()) {
    clauses.push(
      `mimeType = '${escapeMcpGwDriveQueryString(input.mimeType.trim())}'`
    );
  }
  if (typeof input.parentId === "string" && input.parentId.trim()) {
    clauses.push(
      `'${escapeMcpGwDriveQueryString(input.parentId.trim())}' in parents`
    );
  }
  if (
    input.sharedWithMe === true ||
    (typeof input.scope === "string" && input.scope === "shared_with_me")
  ) {
    clauses.push("sharedWithMe = true");
  }
  return clauses.join(" and ");
}

function escapeMcpGwDriveQueryString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function adaptMcpGwGmailMessagesListArgs(
  input: Record<string, unknown>
): Record<string, unknown> {
  return {
    userId: "me",
    ...(typeof input.query === "string" ? { q: input.query } : {}),
    ...(typeof input.limit === "number" ? { maxResults: input.limit } : {})
  };
}

function adaptMcpGwDocsCreateArgs(
  burbleToolName: string,
  input: Record<string, unknown>
): McpGwGoogleToolCallAdaptation {
  const text = typeof input.text === "string" ? input.text : "";
  if (text.trim()) {
    return {
      ok: false,
      burbleToolName,
      message:
        "Google Docs creation with imported text is not adapted for MCP-GW yet."
    };
  }
  if (typeof input.parentId === "string" && input.parentId.trim()) {
    return {
      ok: false,
      burbleToolName,
      message:
        "Google Docs creation into a parent folder is not adapted for MCP-GW yet."
    };
  }
  if (typeof input.name !== "string" || !input.name.trim()) {
    return {
      ok: false,
      burbleToolName,
      message: "Google Docs creation requires a document name."
    };
  }
  return {
    ok: true,
    burbleToolName,
    name: "google_docs_create",
    arguments: { title: input.name.trim() }
  };
}

function isOptionalObject(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input);
}
