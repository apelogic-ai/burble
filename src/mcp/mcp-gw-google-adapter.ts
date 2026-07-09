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

    case "google_get_drive_file":
      return {
        ok: true,
        burbleToolName,
        ...(args.includeContent === false
          ? {
              name: "gws_drive_files_get",
              arguments: adaptMcpGwDriveFilesGetArgs(args)
            }
          : {
              name: "gws_drive_files_export",
              arguments: adaptMcpGwDriveFilesExportArgs(args)
            })
      };

    case "google_list_shared_drives":
      return {
        ok: true,
        burbleToolName,
        name: "gws_drive_drives_list",
        arguments: adaptMcpGwSharedDrivesListArgs(args)
      };

    case "google_search_calendar_events":
      return {
        ok: true,
        burbleToolName,
        name: "google_calendar_events_list",
        arguments: adaptMcpGwCalendarEventsListArgs(args)
      };

    case "google_create_calendar_event":
      return {
        ok: true,
        burbleToolName,
        name: "google_calendar_events_insert",
        arguments: adaptMcpGwCalendarEventWriteArgs(args)
      };

    case "google_update_calendar_event":
      return {
        ok: true,
        burbleToolName,
        name: "google_calendar_events_update",
        arguments: adaptMcpGwCalendarEventUpdateArgs(args)
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

    case "google_slides_search_presentations":
      return {
        ok: true,
        burbleToolName,
        name: "google_drive_files_list",
        arguments: adaptMcpGwSlidesPresentationsListArgs(args)
      };

    case "google_slides_get_presentation":
      return {
        ok: true,
        burbleToolName,
        name: "gws_slides_presentations_get",
        arguments: adaptMcpGwSlidesPresentationGetArgs(args)
      };

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

function adaptMcpGwDriveFilesGetArgs(
  input: Record<string, unknown>
): Record<string, unknown> {
  return {
    params: {
      fileId: stringInput(input, "fileId"),
      fields: "id,name,mimeType,webViewLink,modifiedTime"
    },
    format: "json"
  };
}

function adaptMcpGwDriveFilesExportArgs(
  input: Record<string, unknown>
): Record<string, unknown> {
  return {
    params: {
      fileId: stringInput(input, "fileId"),
      mimeType: googleDriveExportMimeType(input)
    }
  };
}

function googleDriveExportMimeType(input: Record<string, unknown>): string {
  const explicit = stringInput(input, "exportMimeType");
  if (explicit) {
    return explicit;
  }
  const mimeType = stringInput(input, "mimeType");
  return mimeType === "application/vnd.google-apps.spreadsheet"
    ? "text/csv"
    : "text/plain";
}

function adaptMcpGwSharedDrivesListArgs(
  input: Record<string, unknown>
): Record<string, unknown> {
  const query = typeof input.query === "string" ? input.query.trim() : "";
  return {
    params: {
      ...(query ? { q: `name contains '${escapeMcpGwDriveQueryString(query)}'` } : {}),
      ...(typeof input.limit === "number" ? { pageSize: input.limit } : {})
    },
    format: "json"
  };
}

function adaptMcpGwCalendarEventsListArgs(
  input: Record<string, unknown>
): Record<string, unknown> {
  return {
    calendarId: stringInput(input, "calendarId", "primary"),
    ...(typeof input.query === "string" ? { q: input.query } : {}),
    ...(typeof input.timeMin === "string" ? { timeMin: input.timeMin } : {}),
    ...(typeof input.timeMax === "string" ? { timeMax: input.timeMax } : {}),
    ...(typeof input.limit === "number" ? { maxResults: input.limit } : {}),
    singleEvents: true
  };
}

function adaptMcpGwCalendarEventWriteArgs(
  input: Record<string, unknown>
): Record<string, unknown> {
  return {
    calendarId: stringInput(input, "calendarId", "primary"),
    summary: stringInput(input, "summary"),
    start: JSON.stringify(calendarTimeInput(input, "start", input.timeZone)),
    end: JSON.stringify(calendarTimeInput(input, "end", input.timeZone)),
    ...(typeof input.description === "string"
      ? { description: input.description }
      : {}),
    ...(typeof input.location === "string" ? { location: input.location } : {})
  };
}

function adaptMcpGwCalendarEventUpdateArgs(
  input: Record<string, unknown>
): Record<string, unknown> {
  return {
    calendarId: stringInput(input, "calendarId", "primary"),
    eventId: stringInput(input, "eventId"),
    ...(typeof input.summary === "string" ? { summary: input.summary } : {}),
    ...(typeof input.start === "string"
      ? { start: JSON.stringify(calendarTimeInput(input, "start", input.timeZone)) }
      : {}),
    ...(typeof input.end === "string"
      ? { end: JSON.stringify(calendarTimeInput(input, "end", input.timeZone)) }
      : {}),
    ...(typeof input.description === "string"
      ? { description: input.description }
      : {})
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

function adaptMcpGwSlidesPresentationsListArgs(
  input: Record<string, unknown>
): Record<string, unknown> {
  return {
    q: [
      "trashed = false",
      "mimeType = 'application/vnd.google-apps.presentation'",
      ...(typeof input.query === "string" && input.query.trim()
        ? [`name contains '${escapeMcpGwDriveQueryString(input.query.trim())}'`]
        : [])
    ].join(" and "),
    ...(typeof input.limit === "number" ? { pageSize: input.limit } : {}),
    orderBy: "modifiedTime desc"
  };
}

function adaptMcpGwSlidesPresentationGetArgs(
  input: Record<string, unknown>
): Record<string, unknown> {
  return {
    params: {
      presentationId: stringInput(input, "presentationId")
    },
    format: "json"
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

function stringInput(
  input: Record<string, unknown>,
  key: string,
  fallback?: string
): string {
  return typeof input[key] === "string" && input[key].trim()
    ? input[key].trim()
    : (fallback ?? "");
}

function calendarTimeInput(
  input: Record<string, unknown>,
  key: "start" | "end",
  timeZone: unknown
): Record<string, string> {
  const value = stringInput(input, key);
  return {
    dateTime: value,
    ...(typeof timeZone === "string" && timeZone.trim()
      ? { timeZone: timeZone.trim() }
      : {})
  };
}
