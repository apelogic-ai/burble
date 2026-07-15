import { findProviderToolSpec } from "../providers/catalog";
import type { ScheduledJobStateRef } from "../agent/scheduled-job-context";
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

export function applyMcpGwGoogleStateRefHints(
  toolName: string,
  input: unknown,
  stateRefs: ScheduledJobStateRef[],
): unknown {
  const tool = findProviderToolSpec(toolName);
  const burbleToolName = tool?.provider === "google" ? tool.name : toolName;
  if (
    ![
      "google_append_to_drive_text_file",
      "google_get_drive_file",
    ].includes(burbleToolName) ||
    !isOptionalObject(input) ||
    stringInput(input, "mimeType")
  ) {
    return input;
  }
  const fileId = stringInput(input, "fileId");
  const preparedDocument = stateRefs.some(
    (stateRef) =>
      stateRef.provider === "google" &&
      stateRef.kind === "google_docs_create_document" &&
      stateRef.id === fileId,
  );
  return preparedDocument
    ? {
        ...input,
        mimeType: "application/vnd.google-apps.document",
      }
    : input;
}

export function canAdaptMcpGwGoogleToolCall(
  toolName: string,
  input: unknown = {}
): boolean {
  return adaptMcpGwGoogleToolCall(toolName, input).ok;
}

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
      return adaptMcpGwDriveFilesReadArgs(burbleToolName, args);

    case "google_create_drive_text_file":
      return adaptMcpGwDriveFilesCreateTextArgs(burbleToolName, args);

    case "google_append_to_drive_text_file":
      return adaptMcpGwDriveTextAppendArgs(burbleToolName, args);

    case "google_create_drive_folder":
      return adaptMcpGwDriveFolderCreateArgs(burbleToolName, args);

    case "google_move_drive_file":
      return adaptMcpGwDriveFileMoveArgs(burbleToolName, args);

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
        name: "gws_calendar_events_insert",
        arguments: adaptMcpGwCalendarEventWriteArgs(args)
      };

    case "google_update_calendar_event":
      return {
        ok: true,
        burbleToolName,
        name: "gws_calendar_events_patch",
        arguments: adaptMcpGwCalendarEventUpdateArgs(args)
      };

    case "google_search_mail_messages":
      return {
        ok: true,
        burbleToolName,
        name: "google_gmail_messages_list",
        arguments: adaptMcpGwGmailMessagesListArgs(args)
      };

    case "gmail_create_draft":
      return {
        ok: true,
        burbleToolName,
        name: "gws_gmail_users_drafts_create",
        arguments: adaptMcpGwGmailDraftCreateArgs(args)
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

    case "google_slides_copy_presentation":
      return {
        ok: true,
        burbleToolName,
        name: "gws_drive_files_copy",
        arguments: adaptMcpGwSlidesPresentationCopyArgs(args)
      };

    case "google_slides_create_slide":
      return adaptMcpGwSlidesCreateSlideArgs(burbleToolName, args);

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
        message: actionableGoogleReconnectMessage(result.message),
        authCommand: "/auth google",
        ...(result.connectUrl ? { connectUrl: result.connectUrl } : {})
      }
    };
  }

  if (result.result.isError) {
    return {
      classification: "user_private",
      content: {
        error: "google_tool_failed",
        message: readMcpToolResultText(result.result) || "Google tool failed.",
        toolName: tool.name,
        burbleToolName: tool.burbleToolName,
      },
    };
  }

  const normalizedResult = normalizeMcpGwGoogleResult(tool, result.result);

  return {
    classification: "user_private",
    content: {
      mcpGw: true,
      toolName: tool.name,
      burbleToolName: tool.burbleToolName,
      result: normalizedResult
    }
  };
}

function normalizeMcpGwGoogleResult(
  tool: McpGwGoogleAdaptedToolCall,
  result: { content?: unknown[]; isError?: boolean },
): { content?: unknown[]; isError?: boolean } {
  if (tool.name !== "google_docs_get") {
    return result;
  }

  const document = readMcpJsonObject(result);
  if (!document) {
    return result;
  }
  const documentId = stringInput(document, "documentId");
  const title = stringInput(document, "title");
  const content = collectGoogleDocsText(document).join("");
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ documentId, title, content }),
      },
    ],
  };
}

function readMcpJsonObject(result: { content?: unknown[] }): Record<string, unknown> | null {
  for (const item of result.content ?? []) {
    if (!isOptionalObject(item) || typeof item.text !== "string") {
      continue;
    }
    try {
      const parsed = JSON.parse(item.text) as unknown;
      if (isOptionalObject(parsed)) {
        return parsed;
      }
    } catch {
      // Preserve the upstream result when it is not JSON.
    }
  }
  return null;
}

function collectGoogleDocsText(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectGoogleDocsText);
  }
  if (!isOptionalObject(value)) {
    return [];
  }
  if (isOptionalObject(value.textRun) && typeof value.textRun.content === "string") {
    return [value.textRun.content];
  }
  return Object.values(value).flatMap(collectGoogleDocsText);
}

function readMcpToolResultText(result: { content?: unknown[] }): string {
  return (result.content ?? [])
    .flatMap((item) =>
      isOptionalObject(item) && typeof item.text === "string" ? [item.text] : [],
    )
    .join("\n")
    .trim()
    .slice(0, 2_000);
}

function actionableGoogleReconnectMessage(message: string): string {
  const trimmed = message.trim().replace(/[.!?]+$/, "");
  if (trimmed.includes("/auth google")) {
    return `${trimmed}.`;
  }
  return `${trimmed || "Google Workspace authorization required"}. Reconnect with \`/auth google\`.`;
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

function adaptMcpGwDriveFilesReadArgs(
  burbleToolName: string,
  input: Record<string, unknown>
): McpGwGoogleToolCallAdaptation {
  if (input.includeContent === false) {
    return {
      ok: true,
      burbleToolName,
      name: "gws_drive_files_get",
      arguments: adaptMcpGwDriveFilesGetArgs(input)
    };
  }

  const mimeType = stringInput(input, "mimeType");
  if (mimeType === "application/vnd.google-apps.document") {
    return {
      ok: true,
      burbleToolName,
      name: "google_docs_get",
      arguments: {
        documentId: stringInput(input, "fileId"),
      },
    };
  }
  return {
    ok: false,
    burbleToolName,
    message:
      "MCP-GW Drive export/download does not return file content to Burble; use the direct Google fallback.",
  };
}

function adaptMcpGwDriveFilesCreateTextArgs(
  burbleToolName: string,
  input: Record<string, unknown>
): McpGwGoogleToolCallAdaptation {
  const text = typeof input.text === "string" ? input.text : "";
  if (text.length > 0) {
    return {
      ok: false,
      burbleToolName,
      message:
        "Google Drive text file creation with content requires upload support and is not adapted for MCP-GW yet."
    };
  }

  return {
    ok: true,
    burbleToolName,
    name: "gws_drive_files_create",
    arguments: {
      params: {
        fields: "id,name,mimeType,webViewLink",
        supportsAllDrives: true,
      },
      json: {
        name: stringInput(input, "name"),
        mimeType: stringInput(input, "mimeType", "text/plain"),
      },
      format: "json",
    }
  };
}

function adaptMcpGwDriveTextAppendArgs(
  burbleToolName: string,
  input: Record<string, unknown>,
): McpGwGoogleToolCallAdaptation {
  if (
    stringInput(input, "mimeType") !==
    "application/vnd.google-apps.document"
  ) {
    return {
      ok: false,
      burbleToolName,
      message:
        "Google Drive append is MCP-GW adapted only for Google Docs resources.",
    };
  }
  const text = `${typeof input.separator === "string" ? input.separator : "\n"}${stringInput(input, "text")}`;
  return {
    ok: true,
    burbleToolName,
    name: "gws_docs_documents_batch_update",
    arguments: {
      params: {
        documentId: stringInput(input, "fileId"),
      },
      json: {
        requests: [
          {
            insertText: {
              endOfSegmentLocation: {},
              text,
            },
          },
        ],
      },
    },
  };
}

function adaptMcpGwDriveFolderCreateArgs(
  burbleToolName: string,
  input: Record<string, unknown>
): McpGwGoogleToolCallAdaptation {
  return {
    ok: true,
    burbleToolName,
    name: "gws_drive_files_create",
    arguments: {
      params: {
        fields: "id,name,mimeType,webViewLink",
        supportsAllDrives: true,
      },
      json: {
        name: stringInput(input, "name"),
        mimeType: "application/vnd.google-apps.folder",
        ...(typeof input.parentId === "string" && input.parentId.trim()
          ? { parents: [input.parentId.trim()] }
          : {}),
      },
      format: "json",
    }
  };
}

function adaptMcpGwDriveFileMoveArgs(
  burbleToolName: string,
  input: Record<string, unknown>
): McpGwGoogleToolCallAdaptation {
  if (!Array.isArray(input.removeParentIds)) {
    return {
      ok: false,
      burbleToolName,
      message:
        "Google Drive file move without explicit removeParentIds requires reading current parents and is not adapted for MCP-GW yet."
    };
  }

  const removeParentIds = input.removeParentIds.filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0
  );
  return {
    ok: true,
    burbleToolName,
    name: "gws_drive_files_update",
    arguments: {
      params: {
        fileId: stringInput(input, "fileId"),
        addParents: stringInput(input, "parentId"),
        ...(removeParentIds.length
          ? { removeParents: removeParentIds.map((value) => value.trim()).join(",") }
          : {}),
        fields: "id,name,mimeType,webViewLink",
        supportsAllDrives: true
      },
      format: "json"
    }
  };
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

function adaptMcpGwGmailDraftCreateArgs(
  input: Record<string, unknown>
): Record<string, unknown> {
  return {
    params: { userId: "me" },
    json: {
      message: {
        raw: encodeGmailRawMessage({
          to: stringArrayInput(input, "to"),
          subject: stringInput(input, "subject"),
          body: stringInput(input, "body"),
          cc: stringArrayInput(input, "cc"),
          bcc: stringArrayInput(input, "bcc")
        })
      }
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
    params: {
      calendarId: stringInput(input, "calendarId", "primary"),
    },
    json: {
      summary: stringInput(input, "summary"),
      start: calendarTimeInput(input, "start", input.timeZone),
      end: calendarTimeInput(input, "end", input.timeZone),
      ...(typeof input.description === "string"
        ? { description: input.description }
        : {}),
      ...(typeof input.location === "string" ? { location: input.location } : {}),
    },
    format: "json",
  };
}

function adaptMcpGwCalendarEventUpdateArgs(
  input: Record<string, unknown>
): Record<string, unknown> {
  return {
    params: {
      calendarId: stringInput(input, "calendarId", "primary"),
      eventId: stringInput(input, "eventId"),
    },
    json: {
      ...(typeof input.summary === "string" ? { summary: input.summary } : {}),
      ...(typeof input.start === "string"
        ? { start: calendarTimeInput(input, "start", input.timeZone) }
        : {}),
      ...(typeof input.end === "string"
        ? { end: calendarTimeInput(input, "end", input.timeZone) }
        : {}),
      ...(typeof input.description === "string"
        ? { description: input.description }
        : {}),
      ...(typeof input.location === "string" ? { location: input.location } : {}),
    },
    format: "json",
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

function adaptMcpGwSlidesPresentationCopyArgs(
  input: Record<string, unknown>
): Record<string, unknown> {
  return {
    params: {
      fileId: stringInput(input, "presentationId"),
      fields: "id,name,mimeType,webViewLink"
    },
    json: {
      name: stringInput(input, "name")
    },
    format: "json"
  };
}

function adaptMcpGwSlidesCreateSlideArgs(
  burbleToolName: string,
  input: Record<string, unknown>
): McpGwGoogleToolCallAdaptation {
  if (Array.isArray(input.replacements) && input.replacements.length > 0) {
    return {
      ok: false,
      burbleToolName,
      message:
        "Google Slides slide creation with placeholder fills requires a follow-up placeholder resolution step and is not adapted for MCP-GW yet."
    };
  }

  const createSlide: Record<string, unknown> = {};
  const objectId = stringInput(input, "objectId");
  if (objectId) {
    createSlide.objectId = objectId;
  }
  if (typeof input.insertionIndex === "number") {
    createSlide.insertionIndex = input.insertionIndex;
  }
  const layoutObjectId = stringInput(input, "layoutObjectId");
  const predefinedLayout = stringInput(input, "predefinedLayout");
  if (layoutObjectId) {
    createSlide.slideLayoutReference = { layoutId: layoutObjectId };
  } else if (predefinedLayout) {
    createSlide.slideLayoutReference = { predefinedLayout };
  }

  return {
    ok: true,
    burbleToolName,
    name: "gws_slides_presentations_batch_update",
    arguments: {
      params: {
        presentationId: stringInput(input, "presentationId")
      },
      json: {
        requests: [{ createSlide }]
      },
      format: "json"
    }
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

function stringArrayInput(
  input: Record<string, unknown>,
  key: string
): string[] {
  const value = input[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function encodeGmailRawMessage(input: {
  to: string[];
  subject: string;
  body: string;
  cc?: string[];
  bcc?: string[];
}): string {
  const lines = [
    `To: ${input.to.join(", ")}`,
    ...(input.cc?.length ? [`Cc: ${input.cc.join(", ")}`] : []),
    ...(input.bcc?.length ? [`Bcc: ${input.bcc.join(", ")}`] : []),
    `Subject: ${input.subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    input.body
  ];
  return Buffer.from(lines.join("\r\n"), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
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
