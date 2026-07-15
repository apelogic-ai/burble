import { describe, expect, test } from "bun:test";
import {
  applyMcpGwGoogleStateRefHints,
  adaptMcpGwGoogleToolCall,
  canAdaptMcpGwGoogleToolCall,
  mcpGwGoogleToolResult
} from "../../src/mcp/mcp-gw-google-adapter";

describe("adaptMcpGwGoogleToolCall", () => {
  test("appends to prepared Google Docs through Docs batch update", () => {
    const input = applyMcpGwGoogleStateRefHints(
      "google_append_to_drive_text_file",
      {
        fileId: "doc-123",
        text: "New topic",
      },
      [
        {
          provider: "google",
          kind: "google_docs_create_document",
          id: "doc-123",
        },
      ],
    );

    expect(input).toEqual({
      fileId: "doc-123",
      text: "New topic",
      mimeType: "application/vnd.google-apps.document",
    });
    expect(
      adaptMcpGwGoogleToolCall("google_append_to_drive_text_file", input),
    ).toEqual({
      ok: true,
      burbleToolName: "google_append_to_drive_text_file",
      name: "gws_docs_documents_batch_update",
      arguments: {
        params: { documentId: "doc-123" },
        json: {
          requests: [
            {
              insertText: {
                endOfSegmentLocation: {},
                text: "\nNew topic",
              },
            },
          ],
        },
      },
    });
  });

  test("makes MCP-GW Google reauthorization actionable without an upstream URL", () => {
    const result = mcpGwGoogleToolResult(
      {
        ok: true,
        burbleToolName: "google_search_drive_files",
        name: "google_drive_files_list",
        arguments: {}
      },
      {
        status: "needs_google_connect",
        message: "Google Workspace reauthorization required"
      }
    );

    expect(result).toEqual({
      classification: "user_private",
      content: {
        error: "google_not_connected",
        message:
          "Google Workspace reauthorization required. Reconnect with `/auth google`.",
        authCommand: "/auth google"
      }
    });
  });

  test("surfaces upstream Google tool errors instead of reporting success", () => {
    expect(
      mcpGwGoogleToolResult(
        {
          ok: true,
          burbleToolName: "google_append_to_drive_text_file",
          name: "gws_docs_documents_batch_update",
          arguments: {},
        },
        {
          status: "ok",
          result: {
            isError: true,
            content: [{ type: "text", text: "Google API rejected the update" }],
          },
        },
      ),
    ).toEqual({
      classification: "user_private",
      content: {
        error: "google_tool_failed",
        message: "Google API rejected the update",
        toolName: "gws_docs_documents_batch_update",
        burbleToolName: "google_append_to_drive_text_file",
      },
    });
  });

  test("reduces Google Docs reads to usable document text", () => {
    expect(
      mcpGwGoogleToolResult(
        {
          ok: true,
          burbleToolName: "google_get_drive_file",
          name: "google_docs_get",
          arguments: {},
        },
        {
          status: "ok",
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  documentId: "doc-123",
                  title: "Dedup state",
                  body: {
                    content: [
                      {
                        paragraph: {
                          elements: [
                            { textRun: { content: "First topic\n" } },
                            { textRun: { content: "Second topic\n" } },
                          ],
                        },
                      },
                    ],
                  },
                }),
              },
            ],
          },
        },
      ),
    ).toEqual({
      classification: "user_private",
      content: {
        mcpGw: true,
        toolName: "google_docs_get",
        burbleToolName: "google_get_drive_file",
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                documentId: "doc-123",
                title: "Dedup state",
                content: "First topic\nSecond topic\n",
              }),
            },
          ],
        },
      },
    });
  });

  test("adapts Drive file content reads to MCP-GW Drive export", () => {
    expect(
      adaptMcpGwGoogleToolCall("google_get_drive_file", {
        fileId: "sheet-123",
        mimeType: "application/vnd.google-apps.spreadsheet"
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

  test("reads prepared Google Docs through the Docs API", () => {
    const input = applyMcpGwGoogleStateRefHints(
      "google_get_drive_file",
      {
        fileId: "doc-123",
      },
      [
        {
          provider: "google",
          kind: "google_docs_create_document",
          id: "doc-123",
        },
      ],
    );

    expect(input).toEqual({
      fileId: "doc-123",
      mimeType: "application/vnd.google-apps.document",
    });
    expect(adaptMcpGwGoogleToolCall("google_get_drive_file", input)).toEqual({
      ok: true,
      burbleToolName: "google_get_drive_file",
      name: "google_docs_get",
      arguments: { documentId: "doc-123" },
    });
  });

  test("downloads non-Google-native Drive content instead of exporting it", () => {
    expect(
      adaptMcpGwGoogleToolCall("google_get_drive_file", {
        fileId: "pdf-123",
        mimeType: "application/pdf"
      })
    ).toEqual({
      ok: true,
      burbleToolName: "google_get_drive_file",
      name: "gws_drive_files_download",
      arguments: {
        params: {
          fileId: "pdf-123"
        },
        format: "text"
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

  test("adapts Drive metadata-only writes that do not need upload content", () => {
    expect(
      adaptMcpGwGoogleToolCall("google_create_drive_text_file", {
        name: "Blank"
      })
    ).toEqual({
      ok: true,
      burbleToolName: "google_create_drive_text_file",
      name: "google_drive_files_create",
      arguments: {
        fields: "id,name,mimeType,webViewLink",
        name: "Blank",
        mimeType: "text/plain"
      }
    });

    expect(
      adaptMcpGwGoogleToolCall("google_create_drive_text_file", {
        name: "Notes",
        text: "hello"
      })
    ).toMatchObject({
      ok: false,
      burbleToolName: "google_create_drive_text_file"
    });

    expect(
      adaptMcpGwGoogleToolCall("google_create_drive_folder", {
        name: "QBR",
        parentId: "parent-1"
      })
    ).toEqual({
      ok: true,
      burbleToolName: "google_create_drive_folder",
      name: "google_drive_files_create",
      arguments: {
        fields: "id,name,mimeType,webViewLink",
        name: "QBR",
        mimeType: "application/vnd.google-apps.folder",
        parents: JSON.stringify(["parent-1"])
      }
    });

    expect(
      adaptMcpGwGoogleToolCall("google_move_drive_file", {
        fileId: "file-1",
        parentId: "folder-2",
        removeParentIds: ["folder-1"]
      })
    ).toEqual({
      ok: true,
      burbleToolName: "google_move_drive_file",
      name: "gws_drive_files_update",
      arguments: {
        params: {
          fileId: "file-1",
          addParents: "folder-2",
          removeParents: "folder-1",
          fields: "id,name,mimeType,webViewLink",
          supportsAllDrives: true
        },
        format: "json"
      }
    });

    expect(
      adaptMcpGwGoogleToolCall("google_move_drive_file", {
        fileId: "file-1",
        parentId: "folder-2"
      })
    ).toMatchObject({
      ok: false,
      burbleToolName: "google_move_drive_file"
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

  test("adapts Gmail draft creation", () => {
    const adapted = adaptMcpGwGoogleToolCall("gmail_create_draft", {
      to: ["to@example.com"],
      cc: ["cc@example.com"],
      subject: "Hello",
      body: "Draft body"
    });

    expect(adapted).toMatchObject({
      ok: true,
      burbleToolName: "gmail_create_draft",
      name: "gws_gmail_users_drafts_create",
      arguments: {
        params: { userId: "me" },
        format: "json"
      }
    });
    if (adapted.ok) {
      const raw = (adapted.arguments.json as { message: { raw: string } }).message.raw;
      const decoded = Buffer.from(
        raw.replace(/-/g, "+").replace(/_/g, "/"),
        "base64"
      ).toString("utf8");
      expect(decoded).toContain("To: to@example.com");
      expect(decoded).toContain("Cc: cc@example.com");
      expect(decoded).toContain("Subject: Hello");
      expect(decoded).toContain("Draft body");
    }
  });

  test("adapts simple Slides authoring operations and declines multi-step fills", () => {
    expect(
      adaptMcpGwGoogleToolCall("google_slides_copy_presentation", {
        presentationId: "deck-1",
        name: "Copy"
      })
    ).toEqual({
      ok: true,
      burbleToolName: "google_slides_copy_presentation",
      name: "gws_drive_files_copy",
      arguments: {
        params: {
          fileId: "deck-1",
          fields: "id,name,mimeType,webViewLink"
        },
        json: { name: "Copy" },
        format: "json"
      }
    });

    expect(
      adaptMcpGwGoogleToolCall("google_slides_create_slide", {
        presentationId: "deck-1",
        objectId: "slide-2",
        insertionIndex: 1,
        predefinedLayout: "TITLE_AND_BODY"
      })
    ).toEqual({
      ok: true,
      burbleToolName: "google_slides_create_slide",
      name: "gws_slides_presentations_batch_update",
      arguments: {
        params: { presentationId: "deck-1" },
        json: {
          requests: [
            {
              createSlide: {
                objectId: "slide-2",
                insertionIndex: 1,
                slideLayoutReference: { predefinedLayout: "TITLE_AND_BODY" }
              }
            }
          ]
        },
        format: "json"
      }
    });

    expect(
      adaptMcpGwGoogleToolCall("google_slides_create_slide", {
        presentationId: "deck-1",
        replacements: [{ placeholderType: "TITLE", text: "Hello" }]
      })
    ).toMatchObject({
      ok: false,
      burbleToolName: "google_slides_create_slide"
    });
  });

  test("keeps Docs imports on fallback until MCP-GW has content import support", () => {
    expect(
      adaptMcpGwGoogleToolCall("google_docs_create_document", {
        name: "Doc",
        text: "# Hello"
      })
    ).toMatchObject({
      ok: false,
      burbleToolName: "google_docs_create_document"
    });
    expect(
      canAdaptMcpGwGoogleToolCall("google_docs_create_document", {
        name: "Doc",
        text: "# Hello"
      })
    ).toBe(false);
  });

  test("keeps Analytics intentionally unadapted", () => {
    expect(canAdaptMcpGwGoogleToolCall("google_analytics_run_report")).toBe(false);

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
