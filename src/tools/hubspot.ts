import type { ProviderConnection } from "../db";
import {
  isHubSpotAuthorizationError,
  type HubSpotAccessTokenInfo,
  type HubSpotCrmObject,
  type HubSpotTokenSet
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
    }
  };
}

export async function withHubSpotToken<T>(
  deps: HubSpotToolDeps,
  connection: ProviderConnection,
  callback: (accessToken: string) => Promise<T>
): Promise<T | HubSpotAuthErrorResult> {
  try {
    return await callback(connection.accessToken);
  } catch (error) {
    if (
      isHubSpotAuthorizationError(error) &&
      connection.refreshToken &&
      deps.refreshHubSpotAccessToken
    ) {
      const token = await deps.refreshHubSpotAccessToken(connection.refreshToken);
      const updatedConnection = {
        ...connection,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken ?? connection.refreshToken,
        accessTokenExpiresAt: token.accessTokenExpiresAt
      };
      deps.saveHubSpotConnection?.(updatedConnection);
      try {
        return await callback(updatedConnection.accessToken);
      } catch (retryError) {
        if (isHubSpotAuthorizationError(retryError)) {
          return hubSpotAuthError();
        }
        throw retryError;
      }
    }

    if (isHubSpotAuthorizationError(error)) {
      return hubSpotAuthError();
    }
    throw error;
  }
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

function hubSpotAuthError(): HubSpotAuthErrorResult {
  return {
    classification: "user_private",
    content: {
      error: "hubspot_auth_required",
      message: "Reconnect HubSpot: `/auth hubspot`."
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
