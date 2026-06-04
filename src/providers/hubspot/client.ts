import type { Config } from "../../config";

export type HubSpotTokenSet = {
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: string | null;
};

export type HubSpotAccessTokenInfo = {
  hubId: number | null;
  hubDomain?: string;
  user?: string;
  userId?: number;
  scopes: string[];
};

export type HubSpotObjectType = "contacts" | "companies" | "deals";

export type HubSpotCrmObject = {
  id: string;
  properties: Record<string, string | null>;
  createdAt?: string;
  updatedAt?: string;
  archived?: boolean;
};

export class HubSpotApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "HubSpotApiError";
  }
}

const hubSpotRequiredScopes = [
  "oauth",
  "crm.objects.companies.read",
  "crm.objects.contacts.read",
  "crm.objects.deals.read"
];

const hubSpotOptionalScopes = [
  "account-info.security.read",
  "automation.sequences.read",
  "business_units_view.read",
  "cms.domains.read",
  "cms.functions.read",
  "cms.knowledge_base.articles.read",
  "cms.membership.access_groups.read",
  "collector.graphql_schema.read",
  "communication_preferences.read",
  "communication_preferences.statuses.batch.read",
  "conversations.custom_channels.read",
  "conversations.read",
  "crm.lists.read",
  "crm.objects.appointments.read",
  "crm.objects.carts.read",
  "crm.objects.commercepayments.read",
  "crm.objects.courses.read",
  "crm.objects.custom.read",
  "crm.objects.goals.read",
  "crm.objects.invoices.read",
  "crm.objects.leads.read",
  "crm.objects.line_items.read",
  "crm.objects.listings.read",
  "crm.objects.marketing_events.read",
  "crm.objects.orders.read",
  "crm.objects.owners.read",
  "crm.objects.partner-clients.read",
  "crm.objects.partner-services.read",
  "crm.objects.quotes.read",
  "crm.objects.services.read",
  "crm.objects.subscriptions.read",
  "crm.objects.users.read",
  "crm.pipelines.orders.read",
  "crm.schemas.appointments.read",
  "crm.schemas.carts.read",
  "crm.schemas.commercepayments.read",
  "crm.schemas.companies.read",
  "crm.schemas.contacts.read",
  "crm.schemas.courses.read",
  "crm.schemas.custom.read",
  "crm.schemas.deals.read",
  "crm.schemas.invoices.read",
  "crm.schemas.line_items.read",
  "crm.schemas.listings.read",
  "crm.schemas.orders.read",
  "crm.schemas.quotes.read",
  "crm.schemas.services.read",
  "crm.schemas.subscriptions.read",
  "files.ui_hidden.read",
  "marketing.campaigns.read",
  "marketing.campaigns.revenue.read",
  "media_bridge.read",
  "scheduler.meetings.meeting-link.read",
  "settings.currencies.read",
  "settings.users.read",
  "settings.users.teams.read",
  "tax_rates.read"
];

const hubSpotObjectProperties: Record<HubSpotObjectType, string[]> = {
  contacts: [
    "firstname",
    "lastname",
    "email",
    "company",
    "createdate",
    "lastmodifieddate"
  ],
  companies: [
    "name",
    "domain",
    "industry",
    "createdate",
    "lastmodifieddate"
  ],
  deals: [
    "dealname",
    "amount",
    "dealstage",
    "pipeline",
    "closedate",
    "createdate",
    "hs_lastmodifieddate"
  ]
};

export function buildHubSpotOAuthUrl(config: Config, state: string): string {
  if (!config.hubspotClientId || !config.hubspotClientSecret) {
    throw new Error("HubSpot OAuth is not configured");
  }

  const url = new URL("https://app.hubspot.com/oauth/authorize");
  url.searchParams.set("client_id", config.hubspotClientId);
  url.searchParams.set("redirect_uri", `${config.baseUrl}/oauth/hubspot/callback`);
  url.searchParams.set("scope", hubSpotRequiredScopes.join(" "));
  url.searchParams.set("optional_scope", hubSpotOptionalScopes.join(" "));
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeHubSpotCode(
  config: Config,
  code: string
): Promise<HubSpotTokenSet> {
  if (!config.hubspotClientId || !config.hubspotClientSecret) {
    throw new Error("HubSpot OAuth is not configured");
  }

  const response = await fetch("https://api.hubapi.com/oauth/v1/token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.hubspotClientId,
      client_secret: config.hubspotClientSecret,
      code,
      redirect_uri: `${config.baseUrl}/oauth/hubspot/callback`
    })
  });

  const body = (await response.json()) as HubSpotTokenResponse;
  if (!response.ok || !body.access_token) {
    throw new Error(body.message ?? body.error_description ?? "HubSpot token exchange failed");
  }

  return hubSpotTokenSetFromResponse(body);
}

export async function refreshHubSpotAccessToken(
  config: Config,
  refreshToken: string
): Promise<HubSpotTokenSet> {
  if (!config.hubspotClientId || !config.hubspotClientSecret) {
    throw new Error("HubSpot OAuth is not configured");
  }

  const response = await fetch("https://api.hubapi.com/oauth/v1/token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: config.hubspotClientId,
      client_secret: config.hubspotClientSecret,
      refresh_token: refreshToken
    })
  });

  const body = (await response.json()) as HubSpotTokenResponse;
  if (!response.ok || !body.access_token) {
    throw new Error(body.message ?? body.error_description ?? "HubSpot token refresh failed");
  }

  return hubSpotTokenSetFromResponse(body, refreshToken);
}

export async function getHubSpotAccessTokenInfo(
  token: string
): Promise<HubSpotAccessTokenInfo> {
  let response: Response;
  try {
    response = await fetch(
      `https://api.hubapi.com/oauth/v1/access-tokens/${encodeURIComponent(token)}`,
      {
        headers: hubSpotHeaders(token)
      }
    );
  } catch (error) {
    throw redactHubSpotAccessTokenTransportError(error, token);
  }
  const body = (await response.json()) as HubSpotAccessTokenInfoResponse;
  if (!response.ok) {
    throw hubSpotError(response, "HubSpot account lookup failed", body.message);
  }

  return {
    hubId: typeof body.hub_id === "number" ? body.hub_id : null,
    ...(body.hub_domain ? { hubDomain: body.hub_domain } : {}),
    ...(body.user ? { user: body.user } : {}),
    ...(typeof body.user_id === "number" ? { userId: body.user_id } : {}),
    scopes: Array.isArray(body.scopes) ? body.scopes : []
  };
}

export async function searchHubSpotCrmObjects(
  token: string,
  objectType: HubSpotObjectType,
  input: { query: string; limit?: number }
): Promise<HubSpotCrmObject[]> {
  const response = await fetch(
    `https://api.hubapi.com/crm/v3/objects/${objectType}/search`,
    {
      method: "POST",
      headers: {
        ...hubSpotHeaders(token),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query: input.query.trim(),
        limit: clampLimit(input.limit, 10, 20),
        properties: hubSpotObjectProperties[objectType]
      })
    }
  );
  const body = (await response.json()) as {
    results?: HubSpotCrmObject[];
    message?: string;
  };
  if (!response.ok) {
    throw hubSpotError(response, `HubSpot ${objectType} search failed`, body.message);
  }

  return (body.results ?? []).map(sanitizeHubSpotCrmObject);
}

export const searchHubSpotContacts = (
  token: string,
  input: { query: string; limit?: number }
) => searchHubSpotCrmObjects(token, "contacts", input);

export const searchHubSpotCompanies = (
  token: string,
  input: { query: string; limit?: number }
) => searchHubSpotCrmObjects(token, "companies", input);

export const searchHubSpotDeals = (
  token: string,
  input: { query: string; limit?: number }
) => searchHubSpotCrmObjects(token, "deals", input);

export function isHubSpotAuthorizationError(error: unknown): boolean {
  return error instanceof HubSpotApiError && error.status === 401;
}

function hubSpotTokenSetFromResponse(
  body: HubSpotTokenResponse,
  fallbackRefreshToken?: string
): HubSpotTokenSet {
  const expiresInSeconds =
    typeof body.expires_in === "number" ? body.expires_in : null;
  const accessToken = body.access_token;
  if (!accessToken) {
    throw new Error("HubSpot token response did not include an access token");
  }
  return {
    accessToken,
    refreshToken: body.refresh_token ?? fallbackRefreshToken ?? null,
    accessTokenExpiresAt: expiresInSeconds
      ? new Date(Date.now() + expiresInSeconds * 1000).toISOString()
      : null
  };
}

function hubSpotHeaders(token: string): HeadersInit {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${token}`
  };
}

function hubSpotError(
  response: Response,
  fallback: string,
  message?: string
): HubSpotApiError {
  return new HubSpotApiError(message ?? fallback, response.status);
}

function redactHubSpotAccessTokenTransportError(
  error: unknown,
  token: string
): Error {
  const fallback = "HubSpot account lookup request failed";
  if (!(error instanceof Error)) {
    return new Error(fallback);
  }

  const sanitized = new Error(
    redactSecrets(error.message || fallback, [
      token,
      encodeURIComponent(token)
    ])
  );
  sanitized.name = error.name;
  return sanitized;
}

function redactSecrets(value: string, secrets: string[]): string {
  return secrets.reduce(
    (current, secret) =>
      secret ? current.split(secret).join("[redacted]") : current,
    value
  );
}

function sanitizeHubSpotCrmObject(object: HubSpotCrmObject): HubSpotCrmObject {
  return {
    id: String(object.id),
    properties: sanitizeProperties(object.properties ?? {}),
    ...(object.createdAt ? { createdAt: object.createdAt } : {}),
    ...(object.updatedAt ? { updatedAt: object.updatedAt } : {}),
    ...(typeof object.archived === "boolean" ? { archived: object.archived } : {})
  };
}

function sanitizeProperties(
  properties: Record<string, string | null>
): Record<string, string | null> {
  return Object.fromEntries(
    Object.entries(properties).filter(
      ([, value]) => value === null || typeof value === "string"
    )
  );
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (!value || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Math.floor(value)));
}

type HubSpotTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error_description?: string;
  message?: string;
};

type HubSpotAccessTokenInfoResponse = {
  hub_id?: number;
  hub_domain?: string;
  user?: string;
  user_id?: number;
  scopes?: string[];
  message?: string;
};
