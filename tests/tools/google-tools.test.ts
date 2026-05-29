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
});
