import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { AgentRuntimeRecord, TokenStore } from "../db";
import type { GoogleToolDeps } from "../tools/google";
import { createGoogleTools } from "../tools/google";
import { mcpToolResult, type ProviderMcpDeps, withConnection } from "./provider-context";

export function registerGoogleMcpTools(input: {
  server: McpServer;
  store: TokenStore;
  runtime: AgentRuntimeRecord;
  deps: GoogleToolDeps & ProviderMcpDeps;
}): void {
  const googleTools = createGoogleTools(input.deps);

  input.server.registerTool(
    "google_get_authenticated_user",
    {
      title: "Google authenticated user",
      description: "Return the Google identity connected to this Slack user.",
      inputSchema: {}
    },
    async () =>
      mcpToolResult(
        await withConnection(input.store, input.runtime, "google", (connection) =>
          googleTools.getAuthenticatedUser.execute({ connection })
        )
      )
  );

  input.server.registerTool(
    "google_search_drive_files",
    {
      title: "Google Drive file search",
      description:
        "Search Google Drive files visible to this Slack user's connected Google account.",
      inputSchema: {
        query: z.string().optional().describe("Optional Drive search terms"),
        limit: z.number().int().positive().max(20).optional()
      }
    },
    async ({ query, limit }) =>
      mcpToolResult(
        await withConnection(input.store, input.runtime, "google", (connection) =>
          googleTools.searchDriveFiles.execute({
            connection,
            input: {
              ...(query ? { query } : {}),
              ...(limit ? { limit } : {})
            }
          })
        )
      )
  );

  input.server.registerTool(
    "google_create_drive_text_file",
    {
      title: "Google Drive create text file",
      description:
        "Create a new app-owned text file in Google Drive using this Slack user's connected Google account.",
      inputSchema: {
        name: z.string().min(1).max(200).describe("Drive file name"),
        text: z.string().max(200_000).describe("Text body to write into the file"),
        mimeType: z
          .string()
          .optional()
          .describe("Optional MIME type. Defaults to text/plain.")
      }
    },
    async ({ name, text, mimeType }) =>
      mcpToolResult(
        await withConnection(input.store, input.runtime, "google", (connection) =>
          googleTools.createDriveTextFile.execute({
            connection,
            input: {
              name,
              text,
              ...(mimeType ? { mimeType } : {})
            }
          })
        )
      )
  );

  input.server.registerTool(
    "google_get_drive_file",
    {
      title: "Google Drive get file",
      description:
        "Read Google Drive file metadata and, by default, text content for app-accessible files.",
      inputSchema: {
        fileId: z.string().min(1).describe("Google Drive file ID"),
        includeContent: z
          .boolean()
          .optional()
          .describe("Whether to include exported/downloaded text content. Defaults to true.")
      }
    },
    async ({ fileId, includeContent }) =>
      mcpToolResult(
        await withConnection(input.store, input.runtime, "google", (connection) =>
          googleTools.getDriveFile.execute({
            connection,
            input: {
              fileId,
              ...(includeContent !== undefined ? { includeContent } : {})
            }
          })
        )
      )
  );

  input.server.registerTool(
    "google_update_drive_text_file",
    {
      title: "Google Drive update text file",
      description:
        "Replace the content of an app-accessible Google Drive text file. Use google_get_drive_file first when preserving existing content matters.",
      inputSchema: {
        fileId: z.string().min(1).describe("Google Drive file ID"),
        text: z.string().max(1_000_000).describe("New full file text"),
        mimeType: z.string().optional().describe("Optional MIME type. Defaults to text/plain.")
      }
    },
    async ({ fileId, text, mimeType }) =>
      mcpToolResult(
        await withConnection(input.store, input.runtime, "google", (connection) =>
          googleTools.updateDriveTextFile.execute({
            connection,
            input: {
              fileId,
              text,
              ...(mimeType ? { mimeType } : {})
            }
          })
        )
      )
  );

  input.server.registerTool(
    "google_append_to_drive_text_file",
    {
      title: "Google Drive append text file",
      description:
        "Append text to an app-accessible Google Drive text file by reading existing content then replacing it.",
      inputSchema: {
        fileId: z.string().min(1).describe("Google Drive file ID"),
        text: z.string().max(200_000).describe("Text to append"),
        separator: z.string().max(20).optional().describe("Separator before appended text"),
        mimeType: z.string().optional().describe("Optional MIME type. Defaults to text/plain.")
      }
    },
    async ({ fileId, text, separator, mimeType }) =>
      mcpToolResult(
        await withConnection(input.store, input.runtime, "google", (connection) =>
          googleTools.appendDriveTextFile.execute({
            connection,
            input: {
              fileId,
              text,
              ...(separator !== undefined ? { separator } : {}),
              ...(mimeType ? { mimeType } : {})
            }
          })
        )
      )
  );

  input.server.registerTool(
    "google_create_drive_folder",
    {
      title: "Google Drive create folder",
      description: "Create a Google Drive folder using this Slack user's Google account.",
      inputSchema: {
        name: z.string().min(1).max(200).describe("Folder name"),
        parentId: z.string().min(1).optional().describe("Optional parent folder ID")
      }
    },
    async ({ name, parentId }) =>
      mcpToolResult(
        await withConnection(input.store, input.runtime, "google", (connection) =>
          googleTools.createDriveFolder.execute({
            connection,
            input: {
              name,
              ...(parentId ? { parentId } : {})
            }
          })
        )
      )
  );

  input.server.registerTool(
    "google_move_drive_file",
    {
      title: "Google Drive move file",
      description:
        "Move an app-accessible Google Drive file into a folder. Does not delete the file.",
      inputSchema: {
        fileId: z.string().min(1).describe("Google Drive file ID"),
        parentId: z.string().min(1).describe("Destination folder ID"),
        removeParentIds: z
          .array(z.string().min(1))
          .max(20)
          .optional()
          .describe("Optional parent IDs to remove. Defaults to current parents.")
      }
    },
    async ({ fileId, parentId, removeParentIds }) =>
      mcpToolResult(
        await withConnection(input.store, input.runtime, "google", (connection) =>
          googleTools.moveDriveFile.execute({
            connection,
            input: {
              fileId,
              parentId,
              ...(removeParentIds ? { removeParentIds } : {})
            }
          })
        )
      )
  );

  input.server.registerTool(
    "google_search_calendar_events",
    {
      title: "Google Calendar event search",
      description:
        "Search upcoming Google Calendar events visible to this Slack user's connected Google account.",
      inputSchema: {
        query: z.string().optional().describe("Optional calendar search terms"),
        timeMin: z
          .string()
          .optional()
          .describe("Optional RFC3339 lower bound; defaults to now"),
        timeMax: z.string().optional().describe("Optional RFC3339 upper bound"),
        limit: z.number().int().positive().max(20).optional()
      }
    },
    async ({ query, timeMin, timeMax, limit }) =>
      mcpToolResult(
        await withConnection(input.store, input.runtime, "google", (connection) =>
          googleTools.searchCalendarEvents.execute({
            connection,
            input: {
              ...(query ? { query } : {}),
              ...(timeMin ? { timeMin } : {}),
              ...(timeMax ? { timeMax } : {}),
              ...(limit ? { limit } : {})
            }
          })
        )
      )
  );

  input.server.registerTool(
    "google_create_calendar_event",
    {
      title: "Google Calendar create event",
      description: "Create a Google Calendar event. Use only when clearly requested.",
      inputSchema: {
        calendarId: z.string().optional().describe("Calendar ID. Defaults to primary."),
        summary: z.string().min(1).max(512).describe("Event title"),
        start: z.string().min(1).describe("RFC3339 start date-time"),
        end: z.string().min(1).describe("RFC3339 end date-time"),
        description: z.string().max(65_536).optional(),
        location: z.string().max(512).optional(),
        timeZone: z.string().optional().describe("Optional IANA time zone")
      }
    },
    async ({ calendarId, summary, start, end, description, location, timeZone }) =>
      mcpToolResult(
        await withConnection(input.store, input.runtime, "google", (connection) =>
          googleTools.createCalendarEvent.execute({
            connection,
            input: {
              ...(calendarId ? { calendarId } : {}),
              summary,
              start,
              end,
              ...(description !== undefined ? { description } : {}),
              ...(location !== undefined ? { location } : {}),
              ...(timeZone ? { timeZone } : {})
            }
          })
        )
      )
  );

  input.server.registerTool(
    "google_update_calendar_event",
    {
      title: "Google Calendar update event",
      description:
        "Update Google Calendar event metadata or start/end time. Does not delete events.",
      inputSchema: {
        calendarId: z.string().optional().describe("Calendar ID. Defaults to primary."),
        eventId: z.string().min(1).describe("Calendar event ID"),
        summary: z.string().min(1).max(512).optional(),
        start: z.string().min(1).optional().describe("RFC3339 start date-time"),
        end: z.string().min(1).optional().describe("RFC3339 end date-time"),
        description: z.string().max(65_536).optional(),
        location: z.string().max(512).optional(),
        timeZone: z.string().optional().describe("Optional IANA time zone")
      }
    },
    async ({ calendarId, eventId, summary, start, end, description, location, timeZone }) =>
      mcpToolResult(
        await withConnection(input.store, input.runtime, "google", (connection) =>
          googleTools.updateCalendarEvent.execute({
            connection,
            input: {
              ...(calendarId ? { calendarId } : {}),
              eventId,
              ...(summary !== undefined ? { summary } : {}),
              ...(start !== undefined ? { start } : {}),
              ...(end !== undefined ? { end } : {}),
              ...(description !== undefined ? { description } : {}),
              ...(location !== undefined ? { location } : {}),
              ...(timeZone ? { timeZone } : {})
            }
          })
        )
      )
  );

  input.server.registerTool(
    "google_search_mail_messages",
    {
      title: "Google Mail message search",
      description:
        "Search Gmail messages visible to this Slack user's connected Google account.",
      inputSchema: {
        query: z.string().min(1).describe("Gmail search query"),
        limit: z.number().int().positive().max(10).optional()
      }
    },
    async ({ query, limit }) =>
      mcpToolResult(
        await withConnection(input.store, input.runtime, "google", (connection) =>
          googleTools.searchMailMessages.execute({
            connection,
            input: {
              query,
              ...(limit ? { limit } : {})
            }
          })
        )
      )
  );

  input.server.registerTool(
    "gmail_create_draft",
    {
      title: "Gmail create draft",
      description:
        "Create a Gmail draft only. This does not send email and should be used before any user-reviewed send workflow.",
      inputSchema: {
        to: z.array(z.string().email()).min(1).max(20).describe("Recipient emails"),
        subject: z.string().min(1).max(512).describe("Draft subject"),
        body: z.string().max(200_000).describe("Plain text draft body"),
        cc: z.array(z.string().email()).max(20).optional(),
        bcc: z.array(z.string().email()).max(20).optional()
      }
    },
    async ({ to, subject, body, cc, bcc }) =>
      mcpToolResult(
        await withConnection(input.store, input.runtime, "google", (connection) =>
          googleTools.createMailDraft.execute({
            connection,
            input: {
              to,
              subject,
              body,
              ...(cc ? { cc } : {}),
              ...(bcc ? { bcc } : {})
            }
          })
        )
      )
  );
}
