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

const hubSpotScopes = [
  "oauth",
  "crm.objects.contacts.read",
  "crm.objects.companies.read",
  "crm.objects.deals.read"
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
  url.searchParams.set("scope", hubSpotScopes.join(" "));
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
  const response = await fetch(
    `https://api.hubapi.com/oauth/v1/access-tokens/${encodeURIComponent(token)}`,
    {
      headers: hubSpotHeaders(token)
    }
  );
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
  return error instanceof HubSpotApiError && [401, 403].includes(error.status);
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
