import { describe, expect, test } from "bun:test";
import { adaptMcpGwGoogleToolCall } from "../../src/mcp/mcp-gw-google-adapter";

describe("adaptMcpGwGoogleToolCall", () => {
  test("adapts Drive file content reads to MCP-GW Drive export", () => {
    expect(
      adaptMcpGwGoogleToolCall("google_get_drive_file", {
        fileId: "sheet-123"
      })
    ).toEqual({
      ok: true,
      burbleToolName: "google_get_drive_file",
      name: "gws_drive_files_export",
      arguments: {
        params: {
          fileId: "sheet-123",
          mimeType: "text/csv"
        }
      }
    });
  });

  test("adapts Drive metadata-only reads to MCP-GW Drive get", () => {
    expect(
      adaptMcpGwGoogleToolCall("google_get_drive_file", {
        fileId: "file-123",
        includeContent: false
      })
    ).toEqual({
      ok: true,
      burbleToolName: "google_get_drive_file",
      name: "gws_drive_files_get",
      arguments: {
        params: {
          fileId: "file-123",
          fields: "id,name,mimeType,webViewLink,modifiedTime"
        },
        format: "json"
      }
    });
  });

  test("adapts shared drive listing", () => {
    expect(
      adaptMcpGwGoogleToolCall("google_list_shared_drives", {
        query: "Project",
        limit: 5
      })
    ).toEqual({
      ok: true,
      burbleToolName: "google_list_shared_drives",
      name: "gws_drive_drives_list",
      arguments: {
        params: {
          q: "name contains 'Project'",
          pageSize: 5
        },
        format: "json"
      }
    });
  });

  test("adapts calendar event search", () => {
    expect(
      adaptMcpGwGoogleToolCall("google_search_calendar_events", {
        query: "planning",
        timeMin: "2026-07-07T00:00:00Z",
        limit: 3
      })
    ).toEqual({
      ok: true,
      burbleToolName: "google_search_calendar_events",
      name: "google_calendar_events_list",
      arguments: {
        calendarId: "primary",
        q: "planning",
        timeMin: "2026-07-07T00:00:00Z",
        maxResults: 3,
        singleEvents: true
      }
    });
  });

  test("adapts Google Slides search and read tools", () => {
    expect(
      adaptMcpGwGoogleToolCall("google_slides_search_presentations", {
        query: "QBR",
        limit: 2
      })
    ).toEqual({
      ok: true,
      burbleToolName: "google_slides_search_presentations",
      name: "google_drive_files_list",
      arguments: {
        q: [
          "trashed = false",
          "mimeType = 'application/vnd.google-apps.presentation'",
          "name contains 'QBR'"
        ].join(" and "),
        pageSize: 2,
        orderBy: "modifiedTime desc"
      }
    });

    expect(
      adaptMcpGwGoogleToolCall("google_slides_get_presentation", {
        presentationId: "deck-123"
      })
    ).toEqual({
      ok: true,
      burbleToolName: "google_slides_get_presentation",
      name: "gws_slides_presentations_get",
      arguments: {
        params: { presentationId: "deck-123" },
        format: "json"
      }
    });
  });

  test("keeps Analytics intentionally unadapted", () => {
    expect(
      adaptMcpGwGoogleToolCall("google_analytics_run_report", {})
    ).toEqual({
      ok: false,
      burbleToolName: "google_analytics_run_report",
      message:
        "Google tool google_analytics_run_report is not adapted for MCP-GW yet."
    });
  });
});
