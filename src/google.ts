import type { Config } from "./config";

export type GoogleTokenSet = {
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: string | null;
};

export type GoogleUser = {
  email: string;
  name?: string;
};

export type GoogleDriveFile = {
  id: string;
  name: string;
  mimeType?: string;
  webViewLink?: string;
  modifiedTime?: string;
};

export type GoogleCalendarEvent = {
  id: string;
  summary?: string;
  description?: string;
  htmlLink?: string;
  start?: string;
  end?: string;
  location?: string;
};

export type GoogleMailMessage = {
  id: string;
  threadId?: string;
  subject?: string;
  snippet?: string;
};

export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "GoogleApiError";
  }
}

const googleScopes = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/gmail.readonly"
];

export function buildGoogleOAuthUrl(config: Config, state: string): string {
  if (!config.googleClientId || !config.googleClientSecret) {
    throw new Error("Google OAuth is not configured");
  }

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", config.googleClientId);
  url.searchParams.set("redirect_uri", `${config.baseUrl}/oauth/google/callback`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", googleScopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  return url.toString();
}

export async function exchangeGoogleCode(
  config: Config,
  code: string
): Promise<GoogleTokenSet> {
  if (!config.googleClientId || !config.googleClientSecret) {
    throw new Error("Google OAuth is not configured");
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      code,
      redirect_uri: `${config.baseUrl}/oauth/google/callback`
    })
  });

  const body = (await response.json()) as GoogleTokenResponse;
  if (!response.ok || !body.access_token) {
    throw new Error(
      body.error_description ?? body.error ?? "Google token exchange failed"
    );
  }

  return googleTokenSetFromResponse(body);
}

export async function refreshGoogleAccessToken(
  config: Config,
  refreshToken: string
): Promise<GoogleTokenSet> {
  if (!config.googleClientId || !config.googleClientSecret) {
    throw new Error("Google OAuth is not configured");
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      refresh_token: refreshToken
    })
  });

  const body = (await response.json()) as GoogleTokenResponse;
  if (!response.ok || !body.access_token) {
    throw new Error(
      body.error_description ?? body.error ?? "Google token refresh failed"
    );
  }

  return googleTokenSetFromResponse(body);
}

export async function getGoogleUser(token: string): Promise<GoogleUser> {
  const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: googleHeaders(token)
  });
  const body = (await response.json()) as { email?: string; name?: string };
  if (!response.ok || !body.email) {
    throw googleError(response, "Google user lookup failed");
  }

  return {
    email: body.email,
    ...(body.name ? { name: body.name } : {})
  };
}

export async function searchGoogleDriveFiles(
  token: string,
  input: { query?: string; limit?: number }
): Promise<GoogleDriveFile[]> {
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("pageSize", String(clampLimit(input.limit, 10, 20)));
  url.searchParams.set(
    "fields",
    "files(id,name,mimeType,webViewLink,modifiedTime)"
  );
  url.searchParams.set("orderBy", "modifiedTime desc");
  if (input.query?.trim()) {
    const escaped = escapeDriveQueryString(input.query.trim());
    url.searchParams.set("q", `trashed = false and name contains '${escaped}'`);
  } else {
    url.searchParams.set("q", "trashed = false");
  }

  const response = await fetch(url, { headers: googleHeaders(token) });
  const body = (await response.json()) as {
    files?: GoogleDriveFile[];
    error?: { message?: string };
  };
  if (!response.ok) {
    throw googleError(response, "Google Drive search failed", body.error?.message);
  }

  return body.files ?? [];
}

export async function searchGoogleCalendarEvents(
  token: string,
  input: { query?: string; timeMin?: string; timeMax?: string; limit?: number }
): Promise<GoogleCalendarEvent[]> {
  const url = new URL(
    "https://www.googleapis.com/calendar/v3/calendars/primary/events"
  );
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("maxResults", String(clampLimit(input.limit, 10, 20)));
  url.searchParams.set("timeMin", input.timeMin ?? new Date().toISOString());
  if (input.timeMax) {
    url.searchParams.set("timeMax", input.timeMax);
  }
  if (input.query?.trim()) {
    url.searchParams.set("q", input.query.trim());
  }

  const response = await fetch(url, { headers: googleHeaders(token) });
  const body = (await response.json()) as {
    items?: Array<{
      id?: string;
      summary?: string;
      description?: string;
      htmlLink?: string;
      start?: { dateTime?: string; date?: string };
      end?: { dateTime?: string; date?: string };
      location?: string;
    }>;
    error?: { message?: string };
  };
  if (!response.ok) {
    throw googleError(response, "Google Calendar search failed", body.error?.message);
  }

  return (body.items ?? []).flatMap((event) =>
    event.id
      ? [
          {
            id: event.id,
            ...(event.summary ? { summary: event.summary } : {}),
            ...(event.description ? { description: event.description } : {}),
            ...(event.htmlLink ? { htmlLink: event.htmlLink } : {}),
            ...(event.start?.dateTime ?? event.start?.date
              ? { start: event.start?.dateTime ?? event.start?.date }
              : {}),
            ...(event.end?.dateTime ?? event.end?.date
              ? { end: event.end?.dateTime ?? event.end?.date }
              : {}),
            ...(event.location ? { location: event.location } : {})
          }
        ]
      : []
  );
}

export async function searchGoogleMailMessages(
  token: string,
  input: { query: string; limit?: number }
): Promise<GoogleMailMessage[]> {
  const limit = clampLimit(input.limit, 10, 10);
  const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  url.searchParams.set("q", input.query);
  url.searchParams.set("maxResults", String(limit));

  const response = await fetch(url, { headers: googleHeaders(token) });
  const body = (await response.json()) as {
    messages?: Array<{ id?: string; threadId?: string }>;
    error?: { message?: string };
  };
  if (!response.ok) {
    throw googleError(response, "Google Mail search failed", body.error?.message);
  }

  const messages = (body.messages ?? []).filter(
    (message): message is { id: string; threadId?: string } =>
      typeof message.id === "string"
  );
  const details = await Promise.all(
    messages.slice(0, limit).map((message) => readGoogleMailMessage(token, message))
  );
  return details;
}

export function isGoogleAuthorizationError(error: unknown): boolean {
  return error instanceof GoogleApiError && (error.status === 401 || error.status === 403);
}

async function readGoogleMailMessage(
  token: string,
  message: { id: string; threadId?: string }
): Promise<GoogleMailMessage> {
  const url = new URL(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${message.id}`
  );
  url.searchParams.set("format", "metadata");
  url.searchParams.set("metadataHeaders", "Subject");
  url.searchParams.set(
    "fields",
    "id,threadId,snippet,payload/headers/name,payload/headers/value"
  );

  const response = await fetch(url, { headers: googleHeaders(token) });
  const body = (await response.json()) as {
    id?: string;
    threadId?: string;
    snippet?: string;
    payload?: { headers?: Array<{ name?: string; value?: string }> };
    error?: { message?: string };
  };
  if (!response.ok) {
    throw googleError(response, "Google Mail message lookup failed", body.error?.message);
  }

  const subject = readHeader(body.payload?.headers, "Subject");

  return {
    id: body.id ?? message.id,
    ...(body.threadId ?? message.threadId
      ? { threadId: body.threadId ?? message.threadId }
      : {}),
    ...(subject ? { subject } : {}),
    ...(body.snippet ? { snippet: body.snippet } : {})
  };
}

function googleHeaders(token: string): HeadersInit {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${token}`
  };
}

function googleError(
  response: Response,
  fallback: string,
  detail?: string
): GoogleApiError {
  return new GoogleApiError(detail ?? `${fallback} with ${response.status}`, response.status);
}

function googleTokenSetFromResponse(body: GoogleTokenResponse): GoogleTokenSet {
  return {
    accessToken: body.access_token!,
    refreshToken: body.refresh_token ?? null,
    accessTokenExpiresAt:
      typeof body.expires_in === "number"
        ? new Date(Date.now() + body.expires_in * 1000).toISOString()
        : null
  };
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isInteger(value) || !value || value <= 0) {
    return fallback;
  }
  return Math.min(value, max);
}

function escapeDriveQueryString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function readHeader(
  headers: Array<{ name?: string; value?: string }> | undefined,
  name: string
): string | null {
  const header = headers?.find(
    (item) => item.name?.toLowerCase() === name.toLowerCase()
  );
  return header?.value ?? null;
}

type GoogleTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};
