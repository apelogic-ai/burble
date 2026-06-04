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

export const hubSpotReadableCrmObjectTypes = [
  "appointments",
  "carts",
  "commercepayments",
  "companies",
  "contacts",
  "courses",
  "deals",
  "goals",
  "invoices",
  "leads",
  "line_items",
  "listings",
  "marketing_events",
  "orders",
  "partner-clients",
  "partner-services",
  "quotes",
  "services",
  "subscriptions",
  "users"
] as const;

export type HubSpotObjectType = (typeof hubSpotReadableCrmObjectTypes)[number];

export type HubSpotCrmObject = {
  id: string;
  properties: Record<string, string | null>;
  createdAt?: string;
  updatedAt?: string;
  archived?: boolean;
};

export type HubSpotOwner = {
  id: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  userId?: number;
  userIdIncludingInactive?: number;
  archived?: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type HubSpotUser = {
  id: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  roleIds?: string[];
  primaryTeamId?: string;
  secondaryTeamIds?: string[];
};

export type HubSpotApiReadInput = {
  path: string;
  query?: Record<string, string | number | boolean | Array<string | number | boolean>>;
};

export type HubSpotApiResource = {
  path: string;
  query: Record<string, string | string[]>;
  content: unknown;
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

const hubSpotObjectProperties: Partial<Record<HubSpotObjectType, string[]>> = {
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
  return searchHubSpotReadableCrmObjects(token, {
    objectType,
    query: input.query,
    limit: input.limit
  });
}

export async function searchHubSpotReadableCrmObjects(
  token: string,
  input: {
    objectType: HubSpotObjectType;
    query?: string;
    limit?: number;
    properties?: string[];
  }
): Promise<HubSpotCrmObject[]> {
  if (!isHubSpotReadableCrmObjectType(input.objectType)) {
    throw new HubSpotApiError(`Unsupported HubSpot CRM object type: ${input.objectType}`, 400);
  }

  const query = typeof input.query === "string" ? input.query.trim() : "";
  const properties = sanitizeRequestedProperties(
    input.properties,
    hubSpotObjectProperties[input.objectType] ?? ["createdate", "lastmodifieddate"]
  );
  const response = await fetch(
    `https://api.hubapi.com/crm/v3/objects/${input.objectType}/search`,
    {
      method: "POST",
      headers: {
        ...hubSpotHeaders(token),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ...(query ? { query } : {}),
        limit: clampLimit(input.limit, 10, 20),
        properties,
        sorts: [{ propertyName: "createdate", direction: "DESCENDING" }]
      })
    }
  );
  const body = (await response.json()) as {
    results?: HubSpotCrmObject[];
    message?: string;
  };
  if (!response.ok) {
    throw hubSpotError(
      response,
      `HubSpot ${input.objectType} search failed`,
      body.message
    );
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

export async function listHubSpotOwners(
  token: string,
  input: { limit?: number; after?: string } = {}
): Promise<HubSpotOwner[]> {
  const url = new URL("https://api.hubapi.com/crm/v3/owners/");
  url.searchParams.set("limit", String(clampLimit(input.limit, 20, 100)));
  url.searchParams.set("archived", "false");
  if (input.after) {
    url.searchParams.set("after", input.after);
  }

  const response = await fetch(url, { headers: hubSpotHeaders(token) });
  const body = (await response.json()) as {
    results?: HubSpotOwnerResponse[];
    message?: string;
  };
  if (!response.ok) {
    throw hubSpotError(response, "HubSpot owners lookup failed", body.message);
  }

  return (body.results ?? []).map(sanitizeHubSpotOwner);
}

export async function listHubSpotUsers(
  token: string,
  input: { limit?: number; after?: string } = {}
): Promise<HubSpotUser[]> {
  const url = new URL("https://api.hubapi.com/settings/v3/users");
  url.searchParams.set("limit", String(clampLimit(input.limit, 20, 100)));
  if (input.after) {
    url.searchParams.set("after", input.after);
  }

  const response = await fetch(url, { headers: hubSpotHeaders(token) });
  const body = (await response.json()) as {
    results?: HubSpotUserResponse[];
    message?: string;
  };
  if (!response.ok) {
    throw hubSpotError(response, "HubSpot users lookup failed", body.message);
  }

  return (body.results ?? []).map(sanitizeHubSpotUser);
}

export async function readHubSpotApiResource(
  token: string,
  input: HubSpotApiReadInput
): Promise<HubSpotApiResource> {
  const path = validateHubSpotApiReadPath(input.path);
  const query = sanitizeHubSpotApiReadQuery(input.query);
  const url = new URL(`https://api.hubapi.com${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        url.searchParams.append(key, item);
      }
    } else {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url, { headers: hubSpotHeaders(token) });
  const content = await response.json();
  if (!response.ok) {
    const message =
      typeof content === "object" &&
      content !== null &&
      typeof (content as { message?: unknown }).message === "string"
        ? (content as { message: string }).message
        : undefined;
    throw hubSpotError(response, "HubSpot API resource read failed", message);
  }

  return {
    path,
    query,
    content: sanitizeHubSpotApiResource(content)
  };
}

export function isHubSpotReadableCrmObjectType(
  value: unknown
): value is HubSpotObjectType {
  return (
    typeof value === "string" &&
    (hubSpotReadableCrmObjectTypes as readonly string[]).includes(value)
  );
}

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

function sanitizeRequestedProperties(
  properties: string[] | undefined,
  fallback: string[]
): string[] {
  if (!properties?.length) {
    return fallback;
  }

  return properties
    .map((property) => property.trim())
    .filter((property) => /^[A-Za-z0-9_./-]{1,100}$/.test(property))
    .slice(0, 20);
}

function sanitizeHubSpotOwner(owner: HubSpotOwnerResponse): HubSpotOwner {
  return {
    id: String(owner.id),
    ...(typeof owner.email === "string" ? { email: owner.email } : {}),
    ...(typeof owner.firstName === "string" ? { firstName: owner.firstName } : {}),
    ...(typeof owner.lastName === "string" ? { lastName: owner.lastName } : {}),
    ...(typeof owner.userId === "number" ? { userId: owner.userId } : {}),
    ...(typeof owner.userIdIncludingInactive === "number"
      ? { userIdIncludingInactive: owner.userIdIncludingInactive }
      : {}),
    ...(typeof owner.archived === "boolean" ? { archived: owner.archived } : {}),
    ...(typeof owner.createdAt === "string" ? { createdAt: owner.createdAt } : {}),
    ...(typeof owner.updatedAt === "string" ? { updatedAt: owner.updatedAt } : {})
  };
}

function sanitizeHubSpotUser(user: HubSpotUserResponse): HubSpotUser {
  return {
    id: String(user.id),
    ...(typeof user.email === "string" ? { email: user.email } : {}),
    ...(typeof user.firstName === "string" ? { firstName: user.firstName } : {}),
    ...(typeof user.lastName === "string" ? { lastName: user.lastName } : {}),
    ...(Array.isArray(user.roleIds)
      ? { roleIds: user.roleIds.filter((id): id is string => typeof id === "string") }
      : {}),
    ...(typeof user.primaryTeamId === "string"
      ? { primaryTeamId: user.primaryTeamId }
      : {}),
    ...(Array.isArray(user.secondaryTeamIds)
      ? {
          secondaryTeamIds: user.secondaryTeamIds.filter(
            (id): id is string => typeof id === "string"
          )
        }
      : {})
  };
}

function validateHubSpotApiReadPath(path: string): string {
  const trimmed = path.trim();
  if (
    !trimmed.startsWith("/") ||
    trimmed.startsWith("//") ||
    trimmed.includes("..") ||
    trimmed.includes("\\") ||
    trimmed.length > 300 ||
    !/^\/[A-Za-z0-9._~!$&'()*+,;=:@/-]+$/.test(trimmed)
  ) {
    throw new HubSpotApiError("Invalid HubSpot API read path", 400);
  }

  const allowedPrefixes = [
    "/account-info/",
    "/automation/",
    "/business-units/",
    "/cms/",
    "/collector/",
    "/communication-preferences/",
    "/conversations/",
    "/crm/",
    "/files/",
    "/marketing/",
    "/media-bridge/",
    "/scheduler/",
    "/settings/",
    "/tax-rates/"
  ];
  if (!allowedPrefixes.some((prefix) => trimmed.startsWith(prefix))) {
    throw new HubSpotApiError("Unsupported HubSpot API read path", 400);
  }

  return trimmed;
}

function sanitizeHubSpotApiReadQuery(
  query: HubSpotApiReadInput["query"] = {}
): Record<string, string | string[]> {
  return Object.fromEntries(
    Object.entries(query)
      .filter(([key]) => /^[A-Za-z0-9_.-]{1,100}$/.test(key))
      .slice(0, 30)
      .map(([key, value]) => [
        key,
        Array.isArray(value)
          ? value.slice(0, 20).map((item) => String(item)).filter((item) => item.length <= 500)
          : String(value).slice(0, 500)
      ])
  );
}

function sanitizeHubSpotApiResource(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.slice(0, 200).map(sanitizeHubSpotApiResource);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 200)
      .map(([key, item]) => [key, sanitizeHubSpotApiResource(item)])
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

type HubSpotOwnerResponse = {
  id: string | number;
  email?: string;
  firstName?: string;
  lastName?: string;
  userId?: number;
  userIdIncludingInactive?: number;
  archived?: boolean;
  createdAt?: string;
  updatedAt?: string;
};

type HubSpotUserResponse = {
  id: string | number;
  email?: string;
  firstName?: string;
  lastName?: string;
  roleIds?: unknown[];
  primaryTeamId?: string;
  secondaryTeamIds?: unknown[];
};
