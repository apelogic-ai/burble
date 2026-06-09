import type { Config } from "../../config";

const maxGoogleAnalyticsReportDateRangeDays = 366;

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

export type GoogleDriveCreatedFile = {
  id: string;
  name: string;
  mimeType?: string;
  webViewLink?: string;
};

export type GoogleDriveFileContent = GoogleDriveFile & {
  content?: string;
};

export type GoogleSlidesPresentationSummary = GoogleDriveFile;

export type GoogleSlidesPlaceholderRef = {
  type: string;
  index?: number;
  parentObjectId?: string;
};

export type GoogleSlidesElement = {
  objectId: string;
  elementType: string;
  shapeType?: string;
  placeholder?: GoogleSlidesPlaceholderRef;
  text?: string;
  imageContentUrl?: string;
};

export type GoogleSlidesTemplateSlot = {
  role: string;
  objectId: string;
  placeholder: GoogleSlidesPlaceholderRef;
};

export type GoogleSlidesSlide = {
  objectId: string;
  layoutObjectId?: string;
  elements: GoogleSlidesElement[];
};

export type GoogleSlidesLayout = {
  objectId: string;
  name?: string;
  slots: GoogleSlidesTemplateSlot[];
  elements: GoogleSlidesElement[];
};

export type GoogleSlidesPresentation = {
  presentationId: string;
  title?: string;
  layouts: GoogleSlidesLayout[];
  slides: GoogleSlidesSlide[];
};

export type GoogleSlidesTemplateProbe = {
  presentationId: string;
  title?: string;
  layouts: Array<{
    layoutId: string;
    name?: string;
    slots: GoogleSlidesTemplateSlot[];
  }>;
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

export type GoogleCreatedDraft = {
  id: string;
  messageId?: string;
};

export type GoogleAnalyticsPropertySummary = {
  account: string;
  accountDisplayName?: string;
  property: string;
  propertyId: string;
  displayName?: string;
  parent?: string;
  propertyType?: string;
};

export type GoogleAnalyticsMetadataField = {
  apiName: string;
  uiName?: string;
  description?: string;
  category?: string;
};

export type GoogleAnalyticsMetadata = {
  dimensions: GoogleAnalyticsMetadataField[];
  metrics: GoogleAnalyticsMetadataField[];
};

export type GoogleAnalyticsReportInput = {
  propertyId: string;
  startDate: string;
  endDate: string;
  metrics: string[];
  dimensions?: string[];
  limit?: number;
};

export type GoogleAnalyticsReport = {
  propertyId: string;
  dimensionHeaders: string[];
  metricHeaders: string[];
  rows: Array<{
    dimensions: Record<string, string>;
    metrics: Record<string, string>;
  }>;
  rowCount?: number;
};

export type GoogleCalendarEventInput = {
  calendarId?: string;
  summary: string;
  start: string;
  end: string;
  description?: string;
  location?: string;
  timeZone?: string;
};

export type GoogleCalendarEventUpdateInput = {
  calendarId?: string;
  eventId: string;
  summary?: string;
  start?: string;
  end?: string;
  description?: string;
  location?: string;
  timeZone?: string;
};

type GoogleSlidesApiPresentation = {
  presentationId: string;
  title?: string;
  layouts?: GoogleSlidesApiLayout[];
  slides?: GoogleSlidesApiSlide[];
};

type GoogleSlidesApiLayout = {
  objectId?: string;
  layoutProperties?: {
    displayName?: string;
  };
  pageElements?: GoogleSlidesApiPageElement[];
};

type GoogleSlidesApiSlide = {
  objectId?: string;
  slideProperties?: {
    layoutObjectId?: string;
  };
  pageElements?: GoogleSlidesApiPageElement[];
};

type GoogleSlidesApiPageElement = {
  objectId?: string;
  shape?: {
    shapeType?: string;
    placeholder?: GoogleSlidesApiPlaceholder;
    text?: GoogleSlidesApiText;
  };
  image?: {
    contentUrl?: string;
  };
};

type GoogleSlidesApiPlaceholder = {
  type?: string;
  index?: number;
  parentObjectId?: string;
};

type GoogleSlidesApiText = {
  textElements?: Array<{
    textRun?: {
      content?: string;
    };
  }>;
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
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/analytics.readonly",
  "https://www.googleapis.com/auth/presentations.readonly"
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

export async function searchGoogleSlidesPresentations(
  token: string,
  input: { query?: string; limit?: number }
): Promise<GoogleSlidesPresentationSummary[]> {
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("pageSize", String(clampLimit(input.limit, 10, 20)));
  url.searchParams.set(
    "fields",
    "files(id,name,mimeType,webViewLink,modifiedTime)"
  );
  url.searchParams.set("orderBy", "modifiedTime desc");
  const predicates = [
    "trashed = false",
    "mimeType = 'application/vnd.google-apps.presentation'"
  ];
  if (input.query?.trim()) {
    predicates.push(`name contains '${escapeDriveQueryString(input.query.trim())}'`);
  }
  url.searchParams.set("q", predicates.join(" and "));

  const response = await fetch(url, { headers: googleHeaders(token) });
  const body = (await response.json()) as {
    files?: GoogleDriveFile[];
    error?: { message?: string };
  };
  if (!response.ok) {
    throw googleError(response, "Google Slides search failed", body.error?.message);
  }

  return (body.files ?? []).map(sanitizeDriveFile);
}

export async function getGoogleSlidesPresentation(
  token: string,
  input: { presentationId: string; includeSlides?: boolean }
): Promise<GoogleSlidesPresentation> {
  const presentation = await readGoogleSlidesPresentation(token, input.presentationId);
  return sanitizeSlidesPresentation(presentation, input.includeSlides !== false);
}

export async function probeGoogleSlidesTemplate(
  token: string,
  input: { presentationId: string }
): Promise<GoogleSlidesTemplateProbe> {
  const presentation = await readGoogleSlidesPresentation(token, input.presentationId);
  const sanitized = sanitizeSlidesPresentation(presentation, false);
  return {
    presentationId: sanitized.presentationId,
    ...(sanitized.title ? { title: sanitized.title } : {}),
    layouts: sanitized.layouts.map((layout) => ({
      layoutId: layout.objectId,
      ...(layout.name ? { name: layout.name } : {}),
      slots: layout.slots
    }))
  };
}

export async function createGoogleDriveTextFile(
  token: string,
  input: { name: string; text: string; mimeType?: string }
): Promise<GoogleDriveCreatedFile> {
  const url = new URL("https://www.googleapis.com/upload/drive/v3/files");
  url.searchParams.set("uploadType", "multipart");
  url.searchParams.set("fields", "id,name,mimeType,webViewLink");

  const boundary = `burble_${crypto.randomUUID().replace(/-/g, "")}`;
  const mimeType = input.mimeType ?? "text/plain";
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...googleHeaders(token),
      "Content-Type": `multipart/related; boundary=${boundary}`
    },
    body: [
      `--${boundary}`,
      "Content-Type: application/json; charset=UTF-8",
      "",
      JSON.stringify({
        name: input.name,
        mimeType
      }),
      `--${boundary}`,
      `Content-Type: ${mimeType}; charset=UTF-8`,
      "",
      input.text,
      `--${boundary}--`,
      ""
    ].join("\r\n")
  });

  const body = (await response.json()) as {
    id?: string;
    name?: string;
    mimeType?: string;
    webViewLink?: string;
    error?: { message?: string };
  };
  if (!response.ok || !body.id || !body.name) {
    throw googleError(response, "Google Drive file creation failed", body.error?.message);
  }

  return {
    id: body.id,
    name: body.name,
    ...(body.mimeType ? { mimeType: body.mimeType } : {}),
    ...(body.webViewLink ? { webViewLink: body.webViewLink } : {})
  };
}

export async function getGoogleDriveFile(
  token: string,
  input: { fileId: string; includeContent?: boolean }
): Promise<GoogleDriveFileContent> {
  const metadataUrl = new URL(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(input.fileId)}`
  );
  metadataUrl.searchParams.set(
    "fields",
    "id,name,mimeType,webViewLink,modifiedTime"
  );
  const metadataResponse = await fetch(metadataUrl, { headers: googleHeaders(token) });
  const metadata = (await metadataResponse.json()) as GoogleDriveFile & {
    error?: { message?: string };
  };
  if (!metadataResponse.ok) {
    throw googleError(
      metadataResponse,
      "Google Drive file lookup failed",
      metadata.error?.message
    );
  }

  if (input.includeContent === false) {
    return sanitizeDriveFile(metadata);
  }

  const content = await readGoogleDriveFileContent(token, metadata);
  return {
    ...sanitizeDriveFile(metadata),
    ...(content !== null ? { content } : {})
  };
}

export async function updateGoogleDriveTextFile(
  token: string,
  input: { fileId: string; text: string; mimeType?: string }
): Promise<GoogleDriveCreatedFile> {
  const url = new URL(
    `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(input.fileId)}`
  );
  url.searchParams.set("uploadType", "media");
  url.searchParams.set("fields", "id,name,mimeType,webViewLink");
  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      ...googleHeaders(token),
      "Content-Type": `${input.mimeType ?? "text/plain"}; charset=UTF-8`
    },
    body: input.text
  });
  const body = (await response.json()) as GoogleDriveCreatedFile & {
    error?: { message?: string };
  };
  if (!response.ok || !body.id || !body.name) {
    throw googleError(
      response,
      "Google Drive file update failed",
      body.error?.message
    );
  }
  return sanitizeCreatedDriveFile(body);
}

export async function appendGoogleDriveTextFile(
  token: string,
  input: { fileId: string; text: string; separator?: string; mimeType?: string }
): Promise<GoogleDriveCreatedFile> {
  const current = await getGoogleDriveFile(token, {
    fileId: input.fileId,
    includeContent: true
  });
  const next = `${current.content ?? ""}${input.separator ?? "\n"}${input.text}`;
  return updateGoogleDriveTextFile(token, {
    fileId: input.fileId,
    text: next,
    ...(input.mimeType ? { mimeType: input.mimeType } : {})
  });
}

export async function createGoogleDriveFolder(
  token: string,
  input: { name: string; parentId?: string }
): Promise<GoogleDriveCreatedFile> {
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("fields", "id,name,mimeType,webViewLink");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...googleHeaders(token),
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      name: input.name,
      mimeType: "application/vnd.google-apps.folder",
      ...(input.parentId ? { parents: [input.parentId] } : {})
    })
  });
  const body = (await response.json()) as GoogleDriveCreatedFile & {
    error?: { message?: string };
  };
  if (!response.ok || !body.id || !body.name) {
    throw googleError(
      response,
      "Google Drive folder creation failed",
      body.error?.message
    );
  }
  return sanitizeCreatedDriveFile(body);
}

export async function moveGoogleDriveFile(
  token: string,
  input: { fileId: string; parentId: string; removeParentIds?: string[] }
): Promise<GoogleDriveCreatedFile> {
  const removeParentIds =
    input.removeParentIds ??
    (await readGoogleDriveParents(token, input.fileId)).filter(
      (parentId) => parentId !== input.parentId
    );
  const url = new URL(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(input.fileId)}`
  );
  url.searchParams.set("addParents", input.parentId);
  if (removeParentIds.length) {
    url.searchParams.set("removeParents", removeParentIds.join(","));
  }
  url.searchParams.set("fields", "id,name,mimeType,webViewLink");
  const response = await fetch(url, {
    method: "PATCH",
    headers: googleHeaders(token)
  });
  const body = (await response.json()) as GoogleDriveCreatedFile & {
    error?: { message?: string };
  };
  if (!response.ok || !body.id || !body.name) {
    throw googleError(response, "Google Drive file move failed", body.error?.message);
  }
  return sanitizeCreatedDriveFile(body);
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

export async function createGoogleCalendarEvent(
  token: string,
  input: GoogleCalendarEventInput
): Promise<GoogleCalendarEvent> {
  const calendarId = input.calendarId ?? "primary";
  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      method: "POST",
      headers: {
        ...googleHeaders(token),
        "Content-Type": "application/json"
      },
      body: JSON.stringify(googleCalendarEventPayload(input))
    }
  );
  const body = (await response.json()) as GoogleCalendarEventApiResponse & {
    error?: { message?: string };
  };
  if (!response.ok || !body.id) {
    throw googleError(
      response,
      "Google Calendar event creation failed",
      body.error?.message
    );
  }
  return sanitizeCalendarEvent(body);
}

export async function updateGoogleCalendarEvent(
  token: string,
  input: GoogleCalendarEventUpdateInput
): Promise<GoogleCalendarEvent> {
  const calendarId = input.calendarId ?? "primary";
  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(input.eventId)}`,
    {
      method: "PATCH",
      headers: {
        ...googleHeaders(token),
        "Content-Type": "application/json"
      },
      body: JSON.stringify(googleCalendarEventPayload(input))
    }
  );
  const body = (await response.json()) as GoogleCalendarEventApiResponse & {
    error?: { message?: string };
  };
  if (!response.ok || !body.id) {
    throw googleError(
      response,
      "Google Calendar event update failed",
      body.error?.message
    );
  }
  return sanitizeCalendarEvent(body);
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

export async function listGoogleAnalyticsProperties(
  token: string,
  input: { limit?: number }
): Promise<GoogleAnalyticsPropertySummary[]> {
  const limit = clampLimit(input.limit, 20, 50);
  const url = new URL("https://analyticsadmin.googleapis.com/v1beta/accountSummaries");
  url.searchParams.set("pageSize", String(Math.max(limit, 1)));
  url.searchParams.set(
    "fields",
    "accountSummaries(account,displayName,propertySummaries(property,displayName,parent,propertyType))"
  );

  const response = await fetch(url, { headers: googleHeaders(token) });
  const body = (await response.json()) as {
    accountSummaries?: Array<{
      account?: string;
      displayName?: string;
      propertySummaries?: Array<{
        property?: string;
        displayName?: string;
        parent?: string;
        propertyType?: string;
      }>;
    }>;
    error?: { message?: string };
  };
  if (!response.ok) {
    throw googleError(
      response,
      "Google Analytics property lookup failed",
      body.error?.message
    );
  }

  return (body.accountSummaries ?? [])
    .flatMap((account) =>
      (account.propertySummaries ?? []).flatMap((property) => {
        if (!account.account || !property.property) {
          return [];
        }
        return [
          {
            account: account.account,
            ...(account.displayName
              ? { accountDisplayName: account.displayName }
              : {}),
            property: property.property,
            propertyId: normalizeGoogleAnalyticsPropertyId(property.property),
            ...(property.displayName ? { displayName: property.displayName } : {}),
            ...(property.parent ? { parent: property.parent } : {}),
            ...(property.propertyType
              ? { propertyType: property.propertyType }
              : {})
          }
        ];
      })
    )
    .slice(0, limit);
}

export async function getGoogleAnalyticsMetadata(
  token: string,
  input: {
    propertyId: string;
    dimensionQuery?: string;
    metricQuery?: string;
    limit?: number;
  }
): Promise<GoogleAnalyticsMetadata> {
  const propertyName = googleAnalyticsPropertyName(input.propertyId);
  const url = new URL(
    `https://analyticsdata.googleapis.com/v1beta/${propertyName}/metadata`
  );
  url.searchParams.set(
    "fields",
    "dimensions(apiName,uiName,description,category),metrics(apiName,uiName,description,category)"
  );
  const response = await fetch(url, { headers: googleHeaders(token) });
  const body = (await response.json()) as {
    dimensions?: GoogleAnalyticsMetadataField[];
    metrics?: GoogleAnalyticsMetadataField[];
    error?: { message?: string };
  };
  if (!response.ok) {
    throw googleError(
      response,
      "Google Analytics metadata lookup failed",
      body.error?.message
    );
  }

  const limit = clampLimit(input.limit, 25, 100);
  return {
    dimensions: filterAnalyticsMetadataFields(
      body.dimensions ?? [],
      input.dimensionQuery
    ).slice(0, limit),
    metrics: filterAnalyticsMetadataFields(body.metrics ?? [], input.metricQuery).slice(
      0,
      limit
    )
  };
}

export async function runGoogleAnalyticsReport(
  token: string,
  input: GoogleAnalyticsReportInput
): Promise<GoogleAnalyticsReport> {
  assertGoogleAnalyticsDateRange(input);
  const propertyName = googleAnalyticsPropertyName(input.propertyId);
  const response = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/${propertyName}:runReport`,
    {
      method: "POST",
      headers: {
        ...googleHeaders(token),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        dateRanges: [{ startDate: input.startDate, endDate: input.endDate }],
        metrics: input.metrics.slice(0, 10).map((name) => ({ name })),
        dimensions: (input.dimensions ?? []).slice(0, 10).map((name) => ({ name })),
        limit: String(clampLimit(input.limit, 10, 100))
      })
    }
  );
  const body = (await response.json()) as {
    dimensionHeaders?: Array<{ name?: string }>;
    metricHeaders?: Array<{ name?: string }>;
    rows?: Array<{
      dimensionValues?: Array<{ value?: string }>;
      metricValues?: Array<{ value?: string }>;
    }>;
    rowCount?: number;
    error?: { message?: string };
  };
  if (!response.ok) {
    throw googleError(
      response,
      "Google Analytics report failed",
      body.error?.message
    );
  }

  const dimensionHeaders = (body.dimensionHeaders ?? [])
    .map((header) => header.name)
    .filter((name): name is string => Boolean(name));
  const metricHeaders = (body.metricHeaders ?? [])
    .map((header) => header.name)
    .filter((name): name is string => Boolean(name));

  return {
    propertyId: normalizeGoogleAnalyticsPropertyId(input.propertyId),
    dimensionHeaders,
    metricHeaders,
    rows: (body.rows ?? []).map((row) => ({
      dimensions: valuesByHeader(dimensionHeaders, row.dimensionValues),
      metrics: valuesByHeader(metricHeaders, row.metricValues)
    })),
    ...(typeof body.rowCount === "number" ? { rowCount: body.rowCount } : {})
  };
}

export async function createGmailDraft(
  token: string,
  input: {
    to: string[];
    subject: string;
    body: string;
    cc?: string[];
    bcc?: string[];
  }
): Promise<GoogleCreatedDraft> {
  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
    method: "POST",
    headers: {
      ...googleHeaders(token),
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      message: {
        raw: encodeGmailRawMessage(input)
      }
    })
  });
  const body = (await response.json()) as {
    id?: string;
    message?: { id?: string };
    error?: { message?: string };
  };
  if (!response.ok || !body.id) {
    throw googleError(response, "Gmail draft creation failed", body.error?.message);
  }
  return {
    id: body.id,
    ...(body.message?.id ? { messageId: body.message.id } : {})
  };
}

export function isGoogleAuthorizationError(error: unknown): boolean {
  return error instanceof GoogleApiError && error.status === 401;
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

async function readGoogleDriveFileContent(
  token: string,
  file: GoogleDriveFile
): Promise<string | null> {
  if (!file.mimeType) {
    return null;
  }
  const url = file.mimeType.startsWith("application/vnd.google-apps.")
    ? new URL(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}/export`
      )
    : new URL(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}`
      );
  if (file.mimeType.startsWith("application/vnd.google-apps.")) {
    url.searchParams.set("mimeType", googleExportMimeType(file.mimeType));
  } else {
    url.searchParams.set("alt", "media");
  }
  const response = await fetch(url, { headers: googleHeaders(token) });
  if (!response.ok) {
    const detail = await readGoogleErrorText(response);
    throw googleError(
      response,
      "Google Drive file content lookup failed",
      detail ? `Google Drive file content lookup failed: ${detail}` : undefined
    );
  }
  return response.text();
}

async function readGoogleDriveParents(
  token: string,
  fileId: string
): Promise<string[]> {
  const url = new URL(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`
  );
  url.searchParams.set("fields", "parents");
  const response = await fetch(url, { headers: googleHeaders(token) });
  const body = (await response.json()) as {
    parents?: string[];
    error?: { message?: string };
  };
  if (!response.ok) {
    throw googleError(
      response,
      "Google Drive parent lookup failed",
      body.error?.message
    );
  }
  return body.parents ?? [];
}

function sanitizeDriveFile(file: GoogleDriveFile): GoogleDriveFile {
  return {
    id: file.id,
    name: file.name,
    ...(file.mimeType ? { mimeType: file.mimeType } : {}),
    ...(file.webViewLink ? { webViewLink: file.webViewLink } : {}),
    ...(file.modifiedTime ? { modifiedTime: file.modifiedTime } : {})
  };
}

function sanitizeCreatedDriveFile(
  file: GoogleDriveCreatedFile
): GoogleDriveCreatedFile {
  return {
    id: file.id,
    name: file.name,
    ...(file.mimeType ? { mimeType: file.mimeType } : {}),
    ...(file.webViewLink ? { webViewLink: file.webViewLink } : {})
  };
}

function googleExportMimeType(mimeType: string): string {
  return mimeType === "application/vnd.google-apps.spreadsheet"
    ? "text/csv"
    : "text/plain";
}

async function readGoogleSlidesPresentation(
  token: string,
  presentationId: string
): Promise<GoogleSlidesApiPresentation> {
  const url = new URL(
    `https://slides.googleapis.com/v1/presentations/${encodeURIComponent(presentationId)}`
  );
  url.searchParams.set(
    "fields",
    [
      "presentationId",
      "title",
      "layouts(objectId,layoutProperties(displayName),pageElements(objectId,shape(shapeType,placeholder,text(textElements(textRun(content)))),image(contentUrl)))",
      "slides(objectId,slideProperties(layoutObjectId),pageElements(objectId,shape(shapeType,placeholder,text(textElements(textRun(content)))),image(contentUrl)))"
    ].join(",")
  );
  const response = await fetch(url, { headers: googleHeaders(token) });
  const body = (await response.json()) as GoogleSlidesApiPresentation & {
    error?: { message?: string };
  };
  if (!response.ok || !body.presentationId) {
    throw googleError(
      response,
      "Google Slides presentation lookup failed",
      body.error?.message
    );
  }
  return body;
}

function sanitizeSlidesPresentation(
  presentation: GoogleSlidesApiPresentation,
  includeSlides: boolean
): GoogleSlidesPresentation {
  return {
    presentationId: presentation.presentationId,
    ...(presentation.title ? { title: presentation.title } : {}),
    layouts: (presentation.layouts ?? []).flatMap((layout) => {
      if (!layout.objectId) {
        return [];
      }
      const elements = sanitizeSlidesElements(layout.pageElements);
      return [
        {
          objectId: layout.objectId,
          ...(layout.layoutProperties?.displayName
            ? { name: layout.layoutProperties.displayName }
            : {}),
          slots: buildSlidesTemplateSlots(elements),
          elements
        }
      ];
    }),
    slides: includeSlides
      ? (presentation.slides ?? []).flatMap((slide) => {
          if (!slide.objectId) {
            return [];
          }
          return [
            {
              objectId: slide.objectId,
              ...(slide.slideProperties?.layoutObjectId
                ? { layoutObjectId: slide.slideProperties.layoutObjectId }
                : {}),
              elements: sanitizeSlidesElements(slide.pageElements)
            }
          ];
        })
      : []
  };
}

function sanitizeSlidesElements(
  elements: GoogleSlidesApiPageElement[] | undefined
): GoogleSlidesElement[] {
  return (elements ?? []).flatMap((element) => {
    if (!element.objectId) {
      return [];
    }
    const placeholder = sanitizeSlidesPlaceholder(element.shape?.placeholder);
    const text = extractSlidesText(element.shape?.text);
    return [
      {
        objectId: element.objectId,
        elementType: element.shape ? "shape" : element.image ? "image" : "unknown",
        ...(element.shape?.shapeType ? { shapeType: element.shape.shapeType } : {}),
        ...(placeholder ? { placeholder } : {}),
        ...(text ? { text } : {}),
        ...(element.image?.contentUrl
          ? { imageContentUrl: element.image.contentUrl }
          : {})
      }
    ];
  });
}

function sanitizeSlidesPlaceholder(
  placeholder: GoogleSlidesApiPlaceholder | undefined
): GoogleSlidesPlaceholderRef | undefined {
  if (!placeholder?.type) {
    return undefined;
  }
  return {
    type: placeholder.type,
    ...(typeof placeholder.index === "number" ? { index: placeholder.index } : {}),
    ...(placeholder.parentObjectId
      ? { parentObjectId: placeholder.parentObjectId }
      : {})
  };
}

function extractSlidesText(text: GoogleSlidesApiText | undefined): string | undefined {
  const content = (text?.textElements ?? [])
    .map((element) => element.textRun?.content ?? "")
    .join("")
    .trim();
  return content || undefined;
}

function buildSlidesTemplateSlots(
  elements: GoogleSlidesElement[]
): GoogleSlidesTemplateSlot[] {
  const roleCounts = new Map<string, number>();
  return elements.flatMap((element) => {
    if (!element.placeholder) {
      return [];
    }
    const baseRole = slidesPlaceholderRole(element.placeholder);
    const count = roleCounts.get(baseRole) ?? 0;
    roleCounts.set(baseRole, count + 1);
    const role = count === 0 ? baseRole : `${baseRole}_${count + 1}`;
    return [
      {
        role,
        objectId: element.objectId,
        placeholder: element.placeholder
      }
    ];
  });
}

function slidesPlaceholderRole(placeholder: GoogleSlidesPlaceholderRef): string {
  const base = placeholder.type.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "_");
  if (!base) {
    return typeof placeholder.index === "number"
      ? `placeholder_${placeholder.index}`
      : "placeholder";
  }
  return base;
}

function googleAnalyticsPropertyName(propertyId: string): string {
  const trimmed = propertyId.trim();
  return trimmed.startsWith("properties/")
    ? trimmed
    : `properties/${encodeURIComponent(trimmed)}`;
}

function assertGoogleAnalyticsDateRange(input: GoogleAnalyticsReportInput): void {
  const startDate = parseGoogleAnalyticsDate(input.startDate);
  const endDate = parseGoogleAnalyticsDate(input.endDate);
  if (!startDate || !endDate || startDate.getTime() > endDate.getTime()) {
    throw new GoogleApiError(
      "Google Analytics report date range must use YYYY-MM-DD, today, yesterday, or NdaysAgo dates with startDate on or before endDate",
      400
    );
  }

  const daySpan =
    Math.floor((endDate.getTime() - startDate.getTime()) / 86_400_000) + 1;
  if (daySpan > maxGoogleAnalyticsReportDateRangeDays) {
    throw new GoogleApiError(
      `Google Analytics report date range is limited to ${maxGoogleAnalyticsReportDateRangeDays} days`,
      400
    );
  }
}

function parseGoogleAnalyticsDate(value: string): Date | null {
  const normalized = value.trim().toLocaleLowerCase();
  const today = utcStartOfDay(new Date());
  if (normalized === "today") {
    return today;
  }
  if (normalized === "yesterday") {
    return new Date(today.getTime() - 86_400_000);
  }
  const daysAgo = normalized.match(/^(\d+)daysago$/);
  if (daysAgo) {
    const days = Number(daysAgo[1]);
    return Number.isSafeInteger(days)
      ? new Date(today.getTime() - days * 86_400_000)
      : null;
  }
  const isoDate = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoDate) {
    const date = new Date(`${normalized}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime())) {
      return null;
    }
    return date.getUTCFullYear() === Number(isoDate[1]) &&
      date.getUTCMonth() === Number(isoDate[2]) - 1 &&
      date.getUTCDate() === Number(isoDate[3])
      ? date
      : null;
  }
  return null;
}

function utcStartOfDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
}

function normalizeGoogleAnalyticsPropertyId(property: string): string {
  return property.replace(/^properties\//, "");
}

function filterAnalyticsMetadataFields(
  fields: GoogleAnalyticsMetadataField[],
  query: string | undefined
): GoogleAnalyticsMetadataField[] {
  const normalizedQuery = query?.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    return fields;
  }
  return fields.filter((field) =>
    [field.apiName, field.uiName, field.description, field.category]
      .filter(Boolean)
      .some((value) => value!.toLocaleLowerCase().includes(normalizedQuery))
  );
}

function valuesByHeader(
  headers: string[],
  values: Array<{ value?: string }> | undefined
): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((header, index) => {
    result[header] = values?.[index]?.value ?? "";
  });
  return result;
}

async function readGoogleErrorText(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message;
  } catch {
    return undefined;
  }
}

function googleCalendarEventPayload(
  input: GoogleCalendarEventInput | GoogleCalendarEventUpdateInput
): Record<string, unknown> {
  return {
    ...("summary" in input && input.summary !== undefined
      ? { summary: input.summary }
      : {}),
    ...("description" in input && input.description !== undefined
      ? { description: input.description }
      : {}),
    ...("location" in input && input.location !== undefined
      ? { location: input.location }
      : {}),
    ...("start" in input && input.start !== undefined
      ? { start: { dateTime: input.start, ...(input.timeZone ? { timeZone: input.timeZone } : {}) } }
      : {}),
    ...("end" in input && input.end !== undefined
      ? { end: { dateTime: input.end, ...(input.timeZone ? { timeZone: input.timeZone } : {}) } }
      : {})
  };
}

function sanitizeCalendarEvent(event: GoogleCalendarEventApiResponse): GoogleCalendarEvent {
  return {
    id: event.id!,
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
  };
}

function encodeGmailRawMessage(input: {
  to: string[];
  subject: string;
  body: string;
  cc?: string[];
  bcc?: string[];
}): string {
  const headers = [
    `To: ${input.to.join(", ")}`,
    ...(input.cc?.length ? [`Cc: ${input.cc.join(", ")}`] : []),
    ...(input.bcc?.length ? [`Bcc: ${input.bcc.join(", ")}`] : []),
    `Subject: ${input.subject}`,
    "Content-Type: text/plain; charset=UTF-8"
  ];
  return Buffer.from([...headers, "", input.body].join("\r\n"), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

type GoogleTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

type GoogleCalendarEventApiResponse = {
  id?: string;
  summary?: string;
  description?: string;
  htmlLink?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  location?: string;
};
