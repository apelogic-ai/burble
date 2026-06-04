import type { ProviderConnection } from "../db";
import {
  HubSpotApiError,
  isHubSpotAuthorizationError,
  type HubSpotApiReadInput,
  type HubSpotApiResource,
  type HubSpotAccessTokenInfo,
  type HubSpotCrmObject,
  type HubSpotObjectType,
  type HubSpotOwner,
  type HubSpotTokenSet,
  type HubSpotUser
} from "../providers/hubspot/client";
import type { ToolResult } from "./types";

export type HubSpotToolDeps = {
  getHubSpotAccessTokenInfo: (token: string) => Promise<HubSpotAccessTokenInfo>;
  searchHubSpotContacts: (
    token: string,
    input: { query: string; limit?: number }
  ) => Promise<HubSpotCrmObject[]>;
  searchHubSpotCompanies: (
    token: string,
    input: { query: string; limit?: number }
  ) => Promise<HubSpotCrmObject[]>;
  searchHubSpotDeals: (
    token: string,
    input: { query: string; limit?: number }
  ) => Promise<HubSpotCrmObject[]>;
  searchHubSpotReadableCrmObjects: (
    token: string,
    input: {
      objectType: HubSpotObjectType;
      query?: string;
      limit?: number;
      properties?: string[];
    }
  ) => Promise<HubSpotCrmObject[]>;
  listHubSpotOwners: (
    token: string,
    input?: { limit?: number; after?: string }
  ) => Promise<HubSpotOwner[]>;
  listHubSpotUsers: (
    token: string,
    input?: { limit?: number; after?: string }
  ) => Promise<HubSpotUser[]>;
  readHubSpotApiResource: (
    token: string,
    input: HubSpotApiReadInput
  ) => Promise<HubSpotApiResource>;
  refreshHubSpotAccessToken?: (refreshToken: string) => Promise<HubSpotTokenSet>;
  saveHubSpotConnection?: (connection: ProviderConnection) => void;
  now?: () => Date;
};

export type HubSpotToolContext = {
  connection: ProviderConnection;
};

type HubSpotAuthErrorContent = { error: string; message: string };
type HubSpotAuthErrorResult = ToolResult<HubSpotAuthErrorContent>;

export function createHubSpotTools(deps: HubSpotToolDeps) {
  return {
    getAuthenticatedUser: {
      async execute(
        context: HubSpotToolContext
      ): Promise<ToolResult<HubSpotAccessTokenInfo | HubSpotAuthErrorContent>> {
        const info = await withHubSpotToken(
          deps,
          context.connection,
          (accessToken) => deps.getHubSpotAccessTokenInfo(accessToken)
        );
        if (isHubSpotAuthErrorResult(info)) {
          return info;
        }

        return {
          classification: "user_private",
          content: info
        };
      }
    },

    searchContacts: {
      async execute(
        context: HubSpotToolContext & { input: { query: string; limit?: number } }
      ): Promise<ToolResult<HubSpotCrmObject[] | HubSpotAuthErrorContent>> {
        return hubSpotSearchResult(
          await withHubSpotToken(deps, context.connection, (accessToken) =>
            deps.searchHubSpotContacts(accessToken, context.input)
          )
        );
      }
    },

    searchCompanies: {
      async execute(
        context: HubSpotToolContext & { input: { query: string; limit?: number } }
      ): Promise<ToolResult<HubSpotCrmObject[] | HubSpotAuthErrorContent>> {
        return hubSpotSearchResult(
          await withHubSpotToken(deps, context.connection, (accessToken) =>
            deps.searchHubSpotCompanies(accessToken, context.input)
          )
        );
      }
    },

    searchDeals: {
      async execute(
        context: HubSpotToolContext & { input: { query: string; limit?: number } }
      ): Promise<ToolResult<HubSpotCrmObject[] | HubSpotAuthErrorContent>> {
        return hubSpotSearchResult(
          await withHubSpotToken(deps, context.connection, (accessToken) =>
            deps.searchHubSpotDeals(accessToken, context.input)
          )
        );
      }
    },

    searchCrmObjects: {
      async execute(
        context: HubSpotToolContext & {
          input: {
            objectType: HubSpotObjectType;
            query?: string;
            limit?: number;
            properties?: string[];
          };
        }
      ): Promise<ToolResult<HubSpotCrmObject[] | HubSpotAuthErrorContent>> {
        return hubSpotListResult(
          await withHubSpotToken(deps, context.connection, (accessToken) =>
            deps.searchHubSpotReadableCrmObjects(accessToken, context.input)
          )
        );
      }
    },

    listOwners: {
      async execute(
        context: HubSpotToolContext & { input?: { limit?: number; after?: string } }
      ): Promise<ToolResult<HubSpotOwner[] | HubSpotAuthErrorContent>> {
        return hubSpotListResult(
          await withHubSpotToken(deps, context.connection, (accessToken) =>
            deps.listHubSpotOwners(accessToken, context.input)
          )
        );
      }
    },

    listUsers: {
      async execute(
        context: HubSpotToolContext & { input?: { limit?: number; after?: string } }
      ): Promise<ToolResult<HubSpotUser[] | HubSpotAuthErrorContent>> {
        return hubSpotListResult(
          await withHubSpotToken(deps, context.connection, (accessToken) =>
            deps.listHubSpotUsers(accessToken, context.input)
          )
        );
      }
    },

    readApiResource: {
      async execute(
        context: HubSpotToolContext & { input: HubSpotApiReadInput }
      ): Promise<ToolResult<HubSpotApiResource | HubSpotAuthErrorContent>> {
        const result = await withHubSpotToken(deps, context.connection, (accessToken) =>
          deps.readHubSpotApiResource(accessToken, context.input)
        );
        if (isHubSpotAuthErrorResult(result)) {
          return result;
        }

        return {
          classification: "user_private",
          content: result
        };
      }
    }
  };
}

export async function withHubSpotToken<T>(
  deps: HubSpotToolDeps,
  connection: ProviderConnection,
  callback: (accessToken: string) => Promise<T>
): Promise<T | HubSpotAuthErrorResult> {
  let current = await refreshIfNeeded(deps, connection);

  try {
    return await callback(current.accessToken);
  } catch (error) {
    if (!isHubSpotAuthorizationError(error)) {
      if (error instanceof HubSpotApiError) {
        return hubSpotApiErrorResult(error);
      }
      throw error;
    }

    const refreshed = await refreshConnection(deps, current);
    if (!refreshed) {
      return hubSpotAuthError();
    }

    current = refreshed;
    try {
      return await callback(current.accessToken);
    } catch (retryError) {
      if (isHubSpotAuthorizationError(retryError)) {
        return hubSpotAuthError();
      }
      if (retryError instanceof HubSpotApiError) {
        return hubSpotApiErrorResult(retryError);
      }
      throw retryError;
    }
  }
}

async function refreshIfNeeded(
  deps: HubSpotToolDeps,
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
  deps: HubSpotToolDeps,
  connection: ProviderConnection
): Promise<ProviderConnection | null> {
  if (!connection.refreshToken || !deps.refreshHubSpotAccessToken) {
    return null;
  }

  const tokenSet = await deps.refreshHubSpotAccessToken(connection.refreshToken);
  const refreshed = {
    ...connection,
    accessToken: tokenSet.accessToken,
    refreshToken: tokenSet.refreshToken ?? connection.refreshToken,
    accessTokenExpiresAt: tokenSet.accessTokenExpiresAt
  };
  deps.saveHubSpotConnection?.(refreshed);
  return refreshed;
}

function hubSpotSearchResult(
  result: HubSpotCrmObject[] | HubSpotAuthErrorResult
): ToolResult<HubSpotCrmObject[] | HubSpotAuthErrorContent> {
  if (isHubSpotAuthErrorResult(result)) {
    return result;
  }

  return {
    classification: "user_private",
    content: result.slice(0, 20)
  };
}

function hubSpotListResult<T>(
  result: T[] | HubSpotAuthErrorResult
): ToolResult<T[] | HubSpotAuthErrorContent> {
  if (isHubSpotAuthErrorResult(result)) {
    return result;
  }

  return {
    classification: "user_private",
    content: result.slice(0, 100)
  };
}

function hubSpotAuthError(): HubSpotAuthErrorResult {
  return {
    classification: "user_private",
    content: {
      error: "hubspot_auth_required",
      message: "Reconnect HubSpot: `/auth hubspot`."
    }
  };
}

function hubSpotApiErrorResult(error: HubSpotApiError): HubSpotAuthErrorResult {
  if (error.status === 403) {
    return {
      classification: "user_private",
      content: {
        error: "hubspot_permission_denied",
        message:
          "HubSpot denied this request. Check that the connected HubSpot app has the required CRM read scopes."
      }
    };
  }

  return {
    classification: "user_private",
    content: {
      error: "hubspot_api_error",
      message: `HubSpot request failed (${error.status}): ${error.message}`
    }
  };
}

export function isHubSpotAuthErrorResult(
  value: unknown
): value is HubSpotAuthErrorResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "content" in value &&
    typeof (value as { content?: { error?: unknown } }).content?.error === "string"
  );
}
