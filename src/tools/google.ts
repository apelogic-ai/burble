import type { ProviderConnection } from "../db";
import {
  isGoogleAuthorizationError,
  type GoogleCalendarEvent,
  type GoogleDriveFile,
  type GoogleMailMessage,
  type GoogleTokenSet,
  type GoogleUser
} from "../google";
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

function isGoogleAuthErrorResult(value: unknown): value is GoogleAuthErrorResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "classification" in value &&
    "content" in value
  );
}
