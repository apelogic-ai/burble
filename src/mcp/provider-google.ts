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
}
