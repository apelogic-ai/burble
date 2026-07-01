import { describe, expect, test } from "bun:test";
import type { ProviderConnection } from "../../src/db";
import { GoogleApiError } from "../../src/providers/google/client";
import { createGoogleTools } from "../../src/tools/google";

const connection: ProviderConnection = {
  provider: "google",
  email: "person@example.com",
  slackUserId: "U123",
  providerLogin: "person@google.example",
  accessToken: "google-token",
  connectedAt: "2026-05-26T00:00:00Z"
};

describe("createGoogleTools", () => {
  test("asks for reconnect when Google returns 401 without a refresh token", async () => {
    const tools = createGoogleTools({
      getGoogleUser: async () => ({
        email: "person@google.example"
      }),
      searchGoogleDriveFiles: async () => [],
      createGoogleDriveTextFile: async () => ({
        id: "file-1",
        name: "Test"
      }),
      searchGoogleCalendarEvents: async () => {
        throw new GoogleApiError("expired", 401);
      },
      searchGoogleMailMessages: async () => []
    });

    const result = await tools.searchCalendarEvents.execute({ connection });

    expect(result).toEqual({
      classification: "user_private",
      content: {
        error: "google_authorization_failed",
        message: "Google authorization expired. Reconnect Google with `/auth google`."
      }
    });
  });

  test("returns Google 403 details instead of calling the connection expired", async () => {
    const tools = createGoogleTools({
      getGoogleUser: async () => ({
        email: "person@google.example"
      }),
      searchGoogleDriveFiles: async () => [],
      createGoogleDriveTextFile: async () => ({
        id: "file-1",
        name: "Test"
      }),
      searchGoogleCalendarEvents: async () => {
        throw new GoogleApiError(
          "Google Calendar search failed: Request had insufficient authentication scopes",
          403
        );
      },
      searchGoogleMailMessages: async () => []
    });

    const result = await tools.searchCalendarEvents.execute({ connection });

    expect(result).toEqual({
      classification: "user_private",
      content: {
        error: "google_api_failed",
        message:
          "Google Calendar search failed: Request had insufficient authentication scopes. If you recently changed Google scopes, run `/auth google` again."
      }
    });
  });

  test("explains Drive file access failures without leaking Google details", async () => {
    const tools = createGoogleTools({
      getGoogleUser: async () => ({
        email: "person@google.example"
      }),
      searchGoogleDriveFiles: async () => [],
      createGoogleDriveTextFile: async () => ({
        id: "file-1",
        name: "Test"
      }),
      appendGoogleDriveTextFile: async () => {
        throw new GoogleApiError(
          "The user has not granted the app 146084443593 read access to the file 1isJjEDSMUH3g",
          403
        );
      },
      searchGoogleCalendarEvents: async () => [],
      searchGoogleMailMessages: async () => []
    });

    const result = await tools.appendDriveTextFile.execute({
      connection,
      input: {
        fileId: "1isJjEDSMUH3g",
        text: "another test"
      }
    });

    expect(result.classification).toBe("user_private");
    expect(result.content).toEqual({
      error: "google_drive_file_not_accessible",
      message:
        "Google Drive blocked access to that file. The connected Google account may not have access, or Burble's stored Google authorization may not include full Drive access yet. If Google scopes were just expanded, reconnect Google with `/auth google`; otherwise share the file with the connected Google account."
    });
    expect(JSON.stringify(result.content)).not.toContain("146084443593");
    expect(JSON.stringify(result.content)).not.toContain("1isJjEDSMUH3g");
    expect(JSON.stringify(result.content)).toContain("/auth google");
  });

  test("treats generic Drive file permission failures as file access errors", async () => {
    const tools = createGoogleTools({
      getGoogleUser: async () => ({
        email: "person@google.example"
      }),
      searchGoogleDriveFiles: async () => [],
      createGoogleDriveTextFile: async () => ({
        id: "file-1",
        name: "Test"
      }),
      appendGoogleDriveTextFile: async () => {
        throw new GoogleApiError(
          "Google Drive file content lookup failed: insufficient permissions for this file",
          403
        );
      },
      searchGoogleCalendarEvents: async () => [],
      searchGoogleMailMessages: async () => []
    });

    const result = await tools.appendDriveTextFile.execute({
      connection,
      input: {
        fileId: "file-1",
        text: "another test"
      }
    });

    expect(result.content).toMatchObject({
      error: "google_drive_file_not_accessible"
    });
    expect(JSON.stringify(result.content)).toContain("/auth google");
  });

  test("explains Slides copy access failures as reconnect-or-share problems", async () => {
    const tools = createGoogleTools({
      getGoogleUser: async () => ({
        email: "person@google.example"
      }),
      searchGoogleDriveFiles: async () => [],
      createGoogleDriveTextFile: async () => ({
        id: "file-1",
        name: "Test"
      }),
      copyGoogleSlidesPresentation: async () => {
        throw new GoogleApiError(
          "Google Slides presentation copy failed: The user has not granted the app 146084443593 read access to the file deck-template",
          403
        );
      },
      searchGoogleCalendarEvents: async () => [],
      searchGoogleMailMessages: async () => []
    });

    const result = await tools.copySlidesPresentation.execute({
      connection,
      input: {
        presentationId: "deck-template",
        name: "Template Copy"
      }
    });

    expect(result.content).toEqual({
      error: "google_drive_file_not_accessible",
      message:
        "Google Drive blocked access to that file. The connected Google account may not have access, or Burble's stored Google authorization may not include full Drive access yet. If Google scopes were just expanded, reconnect Google with `/auth google`; otherwise share the file with the connected Google account."
    });
    expect(JSON.stringify(result.content)).not.toContain("146084443593");
    expect(JSON.stringify(result.content)).not.toContain("deck-template");
  });

  test("refreshes an expiring token and persists the refreshed connection", async () => {
    const saved: ProviderConnection[] = [];
    const tools = createGoogleTools({
      getGoogleUser: async () => ({
        email: "person@google.example"
      }),
      searchGoogleDriveFiles: async () => [],
      createGoogleDriveTextFile: async () => ({
        id: "file-1",
        name: "Test"
      }),
      searchGoogleCalendarEvents: async (token) => {
        expect(token).toBe("new-google-token");
        return [{ id: "event-1", summary: "Planning" }];
      },
      searchGoogleMailMessages: async () => [],
      refreshGoogleAccessToken: async (refreshToken) => {
        expect(refreshToken).toBe("old-refresh-token");
        return {
          accessToken: "new-google-token",
          refreshToken: null,
          accessTokenExpiresAt: "2026-05-26T08:00:00.000Z"
        };
      },
      saveGoogleConnection: (refreshed) => saved.push(refreshed),
      now: () => new Date("2026-05-26T07:00:00.000Z")
    });

    const result = await tools.searchCalendarEvents.execute({
      connection: {
        ...connection,
        refreshToken: "old-refresh-token",
        accessTokenExpiresAt: "2026-05-26T07:00:30.000Z"
      }
    });

    expect(result.content).toEqual([{ id: "event-1", summary: "Planning" }]);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      accessToken: "new-google-token",
      refreshToken: "old-refresh-token",
      accessTokenExpiresAt: "2026-05-26T08:00:00.000Z"
    });
  });

  test("creates a Drive text file with caller token and sanitized result", async () => {
    const tools = createGoogleTools({
      getGoogleUser: async () => ({
        email: "person@google.example"
      }),
      searchGoogleDriveFiles: async () => [],
      createGoogleDriveTextFile: async (token, input) => {
        expect(token).toBe("google-token");
        expect(input).toEqual({
          name: "Test",
          text: "Test One"
        });
        return {
          id: "file-1",
          name: "Test",
          mimeType: "text/plain",
          webViewLink: "https://drive.google.com/file-1"
        };
      },
      searchGoogleCalendarEvents: async () => [],
      searchGoogleMailMessages: async () => []
    });

    const result = await tools.createDriveTextFile.execute({
      connection,
      input: {
        name: "Test",
        text: "Test One"
      }
    });

    expect(result).toEqual({
      classification: "user_private",
      content: {
        id: "file-1",
        name: "Test",
        mimeType: "text/plain",
        webViewLink: "https://drive.google.com/file-1"
      }
    });
  });

  test("creates an empty Drive text file when text is omitted", async () => {
    const tools = createGoogleTools({
      getGoogleUser: async () => ({
        email: "person@google.example"
      }),
      searchGoogleDriveFiles: async () => [],
      createGoogleDriveTextFile: async (token, input) => {
        expect(token).toBe("google-token");
        expect(input).toEqual({
          name: "Blank",
          text: ""
        });
        return {
          id: "file-2",
          name: "Blank"
        };
      },
      searchGoogleCalendarEvents: async () => [],
      searchGoogleMailMessages: async () => []
    });

    const result = await tools.createDriveTextFile.execute({
      connection,
      input: {
        name: "Blank"
      }
    });

    expect(result).toEqual({
      classification: "user_private",
      content: {
        id: "file-2",
        name: "Blank"
      }
    });
  });

  test("lists Shared Drives with the caller token", async () => {
    const tools = createGoogleTools({
      getGoogleUser: async () => ({
        email: "person@google.example"
      }),
      searchGoogleDriveFiles: async () => [],
      listGoogleSharedDrives: async (token, input) => {
        expect(token).toBe("google-token");
        expect(input).toEqual({ query: "Engineering", limit: 2 });
        return [{ id: "drive-1", name: "Engineering" }];
      },
      createGoogleDriveTextFile: async () => ({
        id: "file-1",
        name: "Test"
      }),
      searchGoogleCalendarEvents: async () => [],
      searchGoogleMailMessages: async () => []
    });

    const result = await tools.listSharedDrives.execute({
      connection,
      input: { query: "Engineering", limit: 2 }
    });

    expect(result).toEqual({
      classification: "user_private",
      content: [{ id: "drive-1", name: "Engineering" }]
    });
  });

  test("lists Shared Drive files with the caller token", async () => {
    const tools = createGoogleTools({
      getGoogleUser: async () => ({
        email: "person@google.example"
      }),
      searchGoogleDriveFiles: async () => [],
      listGoogleSharedDriveFiles: async (token, input) => {
        expect(token).toBe("google-token");
        expect(input).toEqual({
          sharedDriveName: "Buble",
          mimeType: "application/vnd.google-apps.document",
          limit: 5
        });
        return [
          {
            drive: { id: "drive-1", name: "Buble Shared Drive" },
            files: [
              {
                id: "doc-1",
                name: "Shared doc",
                mimeType: "application/vnd.google-apps.document"
              }
            ]
          }
        ];
      },
      createGoogleDriveTextFile: async () => ({
        id: "file-1",
        name: "Test"
      }),
      searchGoogleCalendarEvents: async () => [],
      searchGoogleMailMessages: async () => []
    });

    const result = await tools.listSharedDriveFiles.execute({
      connection,
      input: {
        sharedDriveName: "Buble",
        mimeType: "application/vnd.google-apps.document",
        limit: 5
      }
    });

    expect(result).toEqual({
      classification: "user_private",
      content: [
        {
          drive: { id: "drive-1", name: "Buble Shared Drive" },
          files: [
            {
              id: "doc-1",
              name: "Shared doc",
              mimeType: "application/vnd.google-apps.document"
            }
          ]
        }
      ]
    });
  });

  test("creates Google Docs documents with caller token and sanitized result", async () => {
    const tools = createGoogleTools({
      getGoogleUser: async () => ({
        email: "person@google.example"
      }),
      searchGoogleDriveFiles: async () => [],
      createGoogleDriveTextFile: async () => ({
        id: "file-1",
        name: "Test"
      }),
      createGoogleDocsDocument: async (token, input) => {
        expect(token).toBe("google-token");
        expect(input).toEqual({
          name: "Contribution Map",
          text: "# Enterprise Agent Runtime",
          sourceMimeType: "text/markdown"
        });
        return {
          id: "doc-1",
          name: "Contribution Map",
          mimeType: "application/vnd.google-apps.document",
          webViewLink: "https://docs.google.com/document/d/doc-1/edit"
        };
      },
      searchGoogleCalendarEvents: async () => [],
      searchGoogleMailMessages: async () => []
    });

    const result = await tools.createDocsDocument.execute({
      connection,
      input: {
        name: "Contribution Map",
        text: "# Enterprise Agent Runtime",
        sourceMimeType: "text/markdown"
      }
    });

    expect(result).toEqual({
      classification: "user_private",
      content: {
        id: "doc-1",
        name: "Contribution Map",
        mimeType: "application/vnd.google-apps.document",
        webViewLink: "https://docs.google.com/document/d/doc-1/edit"
      }
    });
  });

  test("lists Google Analytics properties with the caller token", async () => {
    const tools = createGoogleTools({
      getGoogleUser: async () => ({
        email: "person@google.example"
      }),
      searchGoogleDriveFiles: async () => [],
      createGoogleDriveTextFile: async () => ({
        id: "file-1",
        name: "Test"
      }),
      searchGoogleCalendarEvents: async () => [],
      searchGoogleMailMessages: async () => [],
      listGoogleAnalyticsProperties: async (token, input) => {
        expect(token).toBe("google-token");
        expect(input).toEqual({ limit: 2 });
        return [
          {
            account: "accounts/123",
            property: "properties/456",
            propertyId: "456",
            displayName: "Website"
          }
        ];
      }
    });

    const result = await tools.listAnalyticsProperties.execute({
      connection,
      input: { limit: 2 }
    });

    expect(result).toEqual({
      classification: "user_private",
      content: [
        {
          account: "accounts/123",
          property: "properties/456",
          propertyId: "456",
          displayName: "Website"
        }
      ]
    });
  });

  test("probes Google Slides templates with the caller token", async () => {
    const tools = createGoogleTools({
      getGoogleUser: async () => ({
        email: "person@google.example"
      }),
      searchGoogleDriveFiles: async () => [],
      createGoogleDriveTextFile: async () => ({
        id: "file-1",
        name: "Test"
      }),
      searchGoogleCalendarEvents: async () => [],
      searchGoogleMailMessages: async () => [],
      probeGoogleSlidesTemplate: async (token, input) => {
        expect(token).toBe("google-token");
        expect(input).toEqual({ presentationId: "deck-1" });
        return {
          presentationId: "deck-1",
          title: "Template",
          layouts: [
            {
              layoutId: "layout-1",
              slots: [
                {
                  role: "title",
                  objectId: "slot-title",
                  placeholder: { type: "TITLE", index: 0 }
                }
              ]
            }
          ]
        };
      }
    });

    const result = await tools.probeSlidesTemplate.execute({
      connection,
      input: { presentationId: "deck-1" }
    });

    expect(result).toEqual({
      classification: "user_private",
      content: {
        presentationId: "deck-1",
        title: "Template",
        layouts: [
          {
            layoutId: "layout-1",
            slots: [
              {
                role: "title",
                objectId: "slot-title",
                placeholder: { type: "TITLE", index: 0 }
              }
            ]
          }
        ]
      }
    });
  });

  test("fills Google Slides placeholders with the caller token", async () => {
    const tools = createGoogleTools({
      getGoogleUser: async () => ({
        email: "person@google.example"
      }),
      searchGoogleDriveFiles: async () => [],
      createGoogleDriveTextFile: async () => ({
        id: "file-1",
        name: "Test"
      }),
      searchGoogleCalendarEvents: async () => [],
      searchGoogleMailMessages: async () => [],
      fillGoogleSlidesPlaceholders: async (token, input) => {
        expect(token).toBe("google-token");
        expect(input).toEqual({
          presentationId: "deck-1",
          replacements: [{ placeholderType: "TITLE", text: "ApeLogic" }]
        });
        return {
          presentationId: "deck-1",
          slideObjectId: "slide-1",
          updatedPlaceholders: [
            {
              placeholderType: "TITLE",
              matchedPlaceholderType: "TITLE",
              objectId: "title-shape",
              text: "ApeLogic"
            }
          ],
          skippedPlaceholders: []
        };
      }
    });

    const result = await tools.fillSlidesPlaceholders.execute({
      connection,
      input: {
        presentationId: "deck-1",
        replacements: [{ placeholderType: "TITLE", text: "ApeLogic" }]
      }
    });

    expect(result).toEqual({
      classification: "user_private",
      content: {
        presentationId: "deck-1",
        slideObjectId: "slide-1",
        updatedPlaceholders: [
          {
            placeholderType: "TITLE",
            matchedPlaceholderType: "TITLE",
            objectId: "title-shape",
            text: "ApeLogic"
          }
        ],
        skippedPlaceholders: []
      }
    });
  });

  test("creates Google Slides slides with the caller token", async () => {
    const tools = createGoogleTools({
      getGoogleUser: async () => ({
        email: "person@google.example"
      }),
      searchGoogleDriveFiles: async () => [],
      createGoogleDriveTextFile: async () => ({
        id: "file-1",
        name: "Test"
      }),
      searchGoogleCalendarEvents: async () => [],
      searchGoogleMailMessages: async () => [],
      createGoogleSlidesSlide: async (token, input) => {
        expect(token).toBe("google-token");
        expect(input).toEqual({
          presentationId: "deck-1",
          insertionIndex: 2,
          predefinedLayout: "TITLE_AND_TWO_COLUMNS",
          replacements: [
            { placeholderType: "TITLE", text: "Test slide 3" },
            { placeholderType: "BODY", index: 0, text: "Left text" },
            { placeholderType: "BODY", index: 1, text: "Right text" }
          ]
        });
        return {
          presentationId: "deck-1",
          slideObjectId: "slide-3"
        };
      }
    });

    const result = await tools.createSlidesSlide.execute({
      connection,
      input: {
        presentationId: "deck-1",
        insertionIndex: 2,
        predefinedLayout: "TITLE_AND_TWO_COLUMNS",
        replacements: [
          { placeholderType: "TITLE", text: "Test slide 3" },
          { placeholderType: "BODY", index: 0, text: "Left text" },
          { placeholderType: "BODY", index: 1, text: "Right text" }
        ]
      }
    });

    expect(result).toEqual({
      classification: "user_private",
      content: {
        presentationId: "deck-1",
        slideObjectId: "slide-3"
      }
    });
  });

  test("runs Google Analytics reports with the caller token", async () => {
    const tools = createGoogleTools({
      getGoogleUser: async () => ({
        email: "person@google.example"
      }),
      searchGoogleDriveFiles: async () => [],
      createGoogleDriveTextFile: async () => ({
        id: "file-1",
        name: "Test"
      }),
      searchGoogleCalendarEvents: async () => [],
      searchGoogleMailMessages: async () => [],
      runGoogleAnalyticsReport: async (token, input) => {
        expect(token).toBe("google-token");
        expect(input).toEqual({
          propertyId: "456",
          startDate: "7daysAgo",
          endDate: "today",
          metrics: ["activeUsers"],
          dimensions: ["country"],
          limit: 3
        });
        return {
          propertyId: "456",
          dimensionHeaders: ["country"],
          metricHeaders: ["activeUsers"],
          rows: [
            {
              dimensions: { country: "US" },
              metrics: { activeUsers: "42" }
            }
          ]
        };
      }
    });

    const result = await tools.runAnalyticsReport.execute({
      connection,
      input: {
        propertyId: "456",
        startDate: "7daysAgo",
        endDate: "today",
        metrics: ["activeUsers"],
        dimensions: ["country"],
        limit: 3
      }
    });

    expect(result).toEqual({
      classification: "user_private",
      content: {
        propertyId: "456",
        dimensionHeaders: ["country"],
        metricHeaders: ["activeUsers"],
        rows: [
          {
            dimensions: { country: "US" },
            metrics: { activeUsers: "42" }
          }
        ]
      }
    });
  });
});
