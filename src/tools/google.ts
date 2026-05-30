import type { ProviderConnection } from "../db";
import {
  GoogleApiError,
  type GoogleCalendarEventInput,
  type GoogleCalendarEventUpdateInput,
  type GoogleCreatedDraft,
  type GoogleDriveCreatedFile,
  type GoogleDriveFileContent,
  isGoogleAuthorizationError,
  type GoogleCalendarEvent,
  type GoogleDriveFile,
  type GoogleMailMessage,
  type GoogleTokenSet,
  type GoogleUser
} from "../providers/google/client";
import type { ToolResult } from "./types";

export type GoogleToolDeps = {
  getGoogleUser: (token: string) => Promise<GoogleUser>;
  searchGoogleDriveFiles: (
    token: string,
    input: { query?: string; limit?: number }
  ) => Promise<GoogleDriveFile[]>;
  searchGoogleCalendarEvents: (
    token: string,
    input: { query?: string; timeMin?: string; timeMax?: string; limit?: number }
  ) => Promise<GoogleCalendarEvent[]>;
  searchGoogleMailMessages: (
    token: string,
    input: { query: string; limit?: number }
  ) => Promise<GoogleMailMessage[]>;
  createGoogleDriveTextFile: (
    token: string,
    input: { name: string; text: string; mimeType?: string }
  ) => Promise<GoogleDriveCreatedFile>;
  getGoogleDriveFile?: (
    token: string,
    input: { fileId: string; includeContent?: boolean }
  ) => Promise<GoogleDriveFileContent>;
  updateGoogleDriveTextFile?: (
    token: string,
    input: { fileId: string; text: string; mimeType?: string }
  ) => Promise<GoogleDriveCreatedFile>;
  appendGoogleDriveTextFile?: (
    token: string,
    input: { fileId: string; text: string; separator?: string; mimeType?: string }
  ) => Promise<GoogleDriveCreatedFile>;
  createGoogleDriveFolder?: (
    token: string,
    input: { name: string; parentId?: string }
  ) => Promise<GoogleDriveCreatedFile>;
  moveGoogleDriveFile?: (
    token: string,
    input: { fileId: string; parentId: string; removeParentIds?: string[] }
  ) => Promise<GoogleDriveCreatedFile>;
  createGoogleCalendarEvent?: (
    token: string,
    input: GoogleCalendarEventInput
  ) => Promise<GoogleCalendarEvent>;
  updateGoogleCalendarEvent?: (
    token: string,
    input: GoogleCalendarEventUpdateInput
  ) => Promise<GoogleCalendarEvent>;
  createGmailDraft?: (
    token: string,
    input: {
      to: string[];
      subject: string;
      body: string;
      cc?: string[];
      bcc?: string[];
    }
  ) => Promise<GoogleCreatedDraft>;
  refreshGoogleAccessToken?: (refreshToken: string) => Promise<GoogleTokenSet>;
  saveGoogleConnection?: (connection: ProviderConnection) => void;
  now?: () => Date;
};

export type GoogleToolContext = {
  connection: ProviderConnection;
};

type GoogleAuthErrorContent = { error: string; message: string };
type GoogleAuthErrorResult = ToolResult<GoogleAuthErrorContent>;

export function createGoogleTools(deps: GoogleToolDeps) {
  return {
    getAuthenticatedUser: {
      async execute(
        context: GoogleToolContext
      ): Promise<ToolResult<GoogleUser | GoogleAuthErrorContent>> {
        const user = await withGoogleToken(
          deps,
          context.connection,
          (accessToken) => deps.getGoogleUser(accessToken)
        );
        if (isGoogleAuthErrorResult(user)) {
          return user;
        }

        return {
          classification: "user_private",
          content: user
        };
      }
    },

    searchDriveFiles: {
      async execute(
        context: GoogleToolContext & {
          input?: { query?: string; limit?: number };
        }
      ): Promise<ToolResult<GoogleDriveFile[] | GoogleAuthErrorContent>> {
        const files = await withGoogleToken(
          deps,
          context.connection,
          (accessToken) =>
            deps.searchGoogleDriveFiles(accessToken, context.input ?? {})
        );
        if (isGoogleAuthErrorResult(files)) {
          return files;
        }

        return {
          classification: "user_private",
          content: files.slice(0, 20).map((file) => ({
            id: file.id,
            name: file.name,
            ...(file.mimeType ? { mimeType: file.mimeType } : {}),
            ...(file.webViewLink ? { webViewLink: file.webViewLink } : {}),
            ...(file.modifiedTime ? { modifiedTime: file.modifiedTime } : {})
          }))
        };
      }
    },

    createDriveTextFile: {
      async execute(
        context: GoogleToolContext & {
          input: { name: string; text: string; mimeType?: string };
        }
      ): Promise<ToolResult<GoogleDriveCreatedFile | GoogleAuthErrorContent>> {
        const file = await withGoogleToken(
          deps,
          context.connection,
          (accessToken) =>
            deps.createGoogleDriveTextFile(accessToken, context.input)
        );
        if (isGoogleAuthErrorResult(file)) {
          return file;
        }

        return {
          classification: "user_private",
          content: {
            id: file.id,
            name: file.name,
            ...(file.mimeType ? { mimeType: file.mimeType } : {}),
            ...(file.webViewLink ? { webViewLink: file.webViewLink } : {})
          }
        };
      }
    },

    getDriveFile: {
      async execute(
        context: GoogleToolContext & {
          input: { fileId: string; includeContent?: boolean };
        }
      ): Promise<ToolResult<GoogleDriveFileContent | GoogleAuthErrorContent>> {
        const file = await withGoogleToken(
          deps,
          context.connection,
          (accessToken) => {
            if (!deps.getGoogleDriveFile) {
              throw new Error("Google Drive file lookup is not configured");
            }
            return deps.getGoogleDriveFile(accessToken, context.input);
          }
        );
        if (isGoogleAuthErrorResult(file)) {
          return file;
        }
        return {
          classification: "user_private",
          content: file
        };
      }
    },

    updateDriveTextFile: {
      async execute(
        context: GoogleToolContext & {
          input: { fileId: string; text: string; mimeType?: string };
        }
      ): Promise<ToolResult<GoogleDriveCreatedFile | GoogleAuthErrorContent>> {
        const file = await withGoogleToken(
          deps,
          context.connection,
          (accessToken) => {
            if (!deps.updateGoogleDriveTextFile) {
              throw new Error("Google Drive file update is not configured");
            }
            return deps.updateGoogleDriveTextFile(accessToken, context.input);
          }
        );
        if (isGoogleAuthErrorResult(file)) {
          return file;
        }
        return {
          classification: "user_private",
          content: sanitizeCreatedDriveFile(file)
        };
      }
    },

    appendDriveTextFile: {
      async execute(
        context: GoogleToolContext & {
          input: { fileId: string; text: string; separator?: string; mimeType?: string };
        }
      ): Promise<ToolResult<GoogleDriveCreatedFile | GoogleAuthErrorContent>> {
        const file = await withGoogleToken(
          deps,
          context.connection,
          (accessToken) => {
            if (!deps.appendGoogleDriveTextFile) {
              throw new Error("Google Drive file append is not configured");
            }
            return deps.appendGoogleDriveTextFile(accessToken, context.input);
          }
        );
        if (isGoogleAuthErrorResult(file)) {
          return file;
        }
        return {
          classification: "user_private",
          content: sanitizeCreatedDriveFile(file)
        };
      }
    },

    createDriveFolder: {
      async execute(
        context: GoogleToolContext & {
          input: { name: string; parentId?: string };
        }
      ): Promise<ToolResult<GoogleDriveCreatedFile | GoogleAuthErrorContent>> {
        const folder = await withGoogleToken(
          deps,
          context.connection,
          (accessToken) => {
            if (!deps.createGoogleDriveFolder) {
              throw new Error("Google Drive folder creation is not configured");
            }
            return deps.createGoogleDriveFolder(accessToken, context.input);
          }
        );
        if (isGoogleAuthErrorResult(folder)) {
          return folder;
        }
        return {
          classification: "user_private",
          content: sanitizeCreatedDriveFile(folder)
        };
      }
    },

    moveDriveFile: {
      async execute(
        context: GoogleToolContext & {
          input: { fileId: string; parentId: string; removeParentIds?: string[] };
        }
      ): Promise<ToolResult<GoogleDriveCreatedFile | GoogleAuthErrorContent>> {
        const file = await withGoogleToken(
          deps,
          context.connection,
          (accessToken) => {
            if (!deps.moveGoogleDriveFile) {
              throw new Error("Google Drive file move is not configured");
            }
            return deps.moveGoogleDriveFile(accessToken, context.input);
          }
        );
        if (isGoogleAuthErrorResult(file)) {
          return file;
        }
        return {
          classification: "user_private",
          content: sanitizeCreatedDriveFile(file)
        };
      }
    },

    searchCalendarEvents: {
      async execute(
        context: GoogleToolContext & {
          input?: {
            query?: string;
            timeMin?: string;
            timeMax?: string;
            limit?: number;
          };
        }
      ): Promise<ToolResult<GoogleCalendarEvent[] | GoogleAuthErrorContent>> {
        const events = await withGoogleToken(
          deps,
          context.connection,
          (accessToken) =>
            deps.searchGoogleCalendarEvents(accessToken, context.input ?? {})
        );
        if (isGoogleAuthErrorResult(events)) {
          return events;
        }

        return {
          classification: "user_private",
          content: events.slice(0, 20).map((event) => ({
            id: event.id,
            ...(event.summary ? { summary: event.summary } : {}),
            ...(event.description ? { description: event.description } : {}),
            ...(event.htmlLink ? { htmlLink: event.htmlLink } : {}),
            ...(event.start ? { start: event.start } : {}),
            ...(event.end ? { end: event.end } : {}),
            ...(event.location ? { location: event.location } : {})
          }))
        };
      }
    },

    createCalendarEvent: {
      async execute(
        context: GoogleToolContext & { input: GoogleCalendarEventInput }
      ): Promise<ToolResult<GoogleCalendarEvent | GoogleAuthErrorContent>> {
        const event = await withGoogleToken(
          deps,
          context.connection,
          (accessToken) => {
            if (!deps.createGoogleCalendarEvent) {
              throw new Error("Google Calendar event creation is not configured");
            }
            return deps.createGoogleCalendarEvent(accessToken, context.input);
          }
        );
        if (isGoogleAuthErrorResult(event)) {
          return event;
        }
        return {
          classification: "user_private",
          content: event
        };
      }
    },

    updateCalendarEvent: {
      async execute(
        context: GoogleToolContext & { input: GoogleCalendarEventUpdateInput }
      ): Promise<ToolResult<GoogleCalendarEvent | GoogleAuthErrorContent>> {
        const event = await withGoogleToken(
          deps,
          context.connection,
          (accessToken) => {
            if (!deps.updateGoogleCalendarEvent) {
              throw new Error("Google Calendar event update is not configured");
            }
            return deps.updateGoogleCalendarEvent(accessToken, context.input);
          }
        );
        if (isGoogleAuthErrorResult(event)) {
          return event;
        }
        return {
          classification: "user_private",
          content: event
        };
      }
    },

    searchMailMessages: {
      async execute(
        context: GoogleToolContext & { input: { query: string; limit?: number } }
      ): Promise<ToolResult<GoogleMailMessage[] | GoogleAuthErrorContent>> {
        const messages = await withGoogleToken(
          deps,
          context.connection,
          (accessToken) =>
            deps.searchGoogleMailMessages(accessToken, context.input)
        );
        if (isGoogleAuthErrorResult(messages)) {
          return messages;
        }

        return {
          classification: "user_private",
          content: messages.slice(0, 10).map((message) => ({
            id: message.id,
            ...(message.threadId ? { threadId: message.threadId } : {}),
            ...(message.subject ? { subject: message.subject } : {}),
            ...(message.snippet ? { snippet: message.snippet } : {})
          }))
        };
      }
    },

    createMailDraft: {
      async execute(
        context: GoogleToolContext & {
          input: {
            to: string[];
            subject: string;
            body: string;
            cc?: string[];
            bcc?: string[];
          };
        }
      ): Promise<ToolResult<GoogleCreatedDraft | GoogleAuthErrorContent>> {
        const draft = await withGoogleToken(
          deps,
          context.connection,
          (accessToken) => {
            if (!deps.createGmailDraft) {
              throw new Error("Gmail draft creation is not configured");
            }
            return deps.createGmailDraft(accessToken, context.input);
          }
        );
        if (isGoogleAuthErrorResult(draft)) {
          return draft;
        }
        return {
          classification: "user_private",
          content: draft
        };
      }
    }
  };
}

async function withGoogleToken<T>(
  deps: GoogleToolDeps,
  connection: ProviderConnection,
  callback: (accessToken: string) => Promise<T>
): Promise<T | GoogleAuthErrorResult> {
  let current = await refreshIfNeeded(deps, connection);

  try {
    return await callback(current.accessToken);
  } catch (error) {
    if (!isGoogleAuthorizationError(error)) {
      if (error instanceof GoogleApiError) {
        return googleApiErrorResult(error);
      }
      throw error;
    }

    const refreshed = await refreshConnection(deps, current);
    if (!refreshed) {
      return googleReconnectResult();
    }

    current = refreshed;
    try {
      return await callback(current.accessToken);
    } catch (retryError) {
      if (isGoogleAuthorizationError(retryError)) {
        return googleReconnectResult();
      }
      if (retryError instanceof GoogleApiError) {
        return googleApiErrorResult(retryError);
      }
      throw retryError;
    }
  }
}

async function refreshIfNeeded(
  deps: GoogleToolDeps,
  connection: ProviderConnection
): Promise<ProviderConnection> {
  if (!connection.accessTokenExpiresAt) {
    return connection;
  }

  const expiresAtMs = new Date(connection.accessTokenExpiresAt).getTime();
  if (!Number.isFinite(expiresAtMs)) {
    return connection;
  }

  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  return expiresAtMs - nowMs <= 60_000
    ? (await refreshConnection(deps, connection)) ?? connection
    : connection;
}

async function refreshConnection(
  deps: GoogleToolDeps,
  connection: ProviderConnection
): Promise<ProviderConnection | null> {
  if (!connection.refreshToken || !deps.refreshGoogleAccessToken) {
    return null;
  }

  const tokenSet = await deps.refreshGoogleAccessToken(connection.refreshToken);
  const refreshed = {
    ...connection,
    accessToken: tokenSet.accessToken,
    refreshToken: tokenSet.refreshToken ?? connection.refreshToken,
    accessTokenExpiresAt: tokenSet.accessTokenExpiresAt
  };
  deps.saveGoogleConnection?.(refreshed);
  return refreshed;
}

function googleReconnectResult(): GoogleAuthErrorResult {
  return {
    classification: "user_private",
    content: {
      error: "google_authorization_failed",
      message: "Google authorization expired. Reconnect Google with `/auth google`."
    }
  };
}

function googleApiErrorResult(error: GoogleApiError): GoogleAuthErrorResult {
  if (isGoogleDriveFileAccessError(error)) {
    return {
      classification: "user_private",
      content: {
        error: "google_drive_file_not_accessible",
        message:
          "Google Drive blocked access to that file. Burble can search Drive metadata, but with the current `drive.file` permission it can only read or edit files it created, or files explicitly opened for this app. Reconnecting Google will not grant access to arbitrary existing files."
      }
    };
  }

  return {
    classification: "user_private",
    content: {
      error: "google_api_failed",
      message: `${error.message}. If you recently changed Google scopes, run \`/auth google\` again.`
    }
  };
}

function isGoogleDriveFileAccessError(error: GoogleApiError): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes("has not granted the app") &&
    message.includes("access to the file")
  );
}

function isGoogleAuthErrorResult(value: unknown): value is GoogleAuthErrorResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "classification" in value &&
    "content" in value
  );
}

function sanitizeCreatedDriveFile(file: GoogleDriveCreatedFile): GoogleDriveCreatedFile {
  return {
    id: file.id,
    name: file.name,
    ...(file.mimeType ? { mimeType: file.mimeType } : {}),
    ...(file.webViewLink ? { webViewLink: file.webViewLink } : {})
  };
}
