import type { McpIdentityIssuer } from "../mcp-identity";
import {
  disconnectMcpGwGoogleAuth,
  getMcpGwGoogleAuthStatus,
  startMcpGwGoogleAuth,
  type McpGwGoogleAuthFetch,
  type McpGwGoogleAuthStatus,
} from "./mcp-gw-google-auth-client";
import { resolveMcpUserAssertion } from "./user-assertion";

export type McpGwGoogleAuthPrincipal = {
  workspaceId: string;
  slackUserId: string;
};

export type McpGwGoogleAuthService = {
  start(
    principal: McpGwGoogleAuthPrincipal,
    input?: { redirectAfter?: string },
  ): Promise<{ authorizationUrl: string }>;
  status(
    principal: McpGwGoogleAuthPrincipal,
  ): Promise<McpGwGoogleAuthStatus>;
  disconnect(principal: McpGwGoogleAuthPrincipal): Promise<void>;
};

export function createMcpGwGoogleAuthService(input: {
  mcpUrl: string;
  audience: string;
  issuer: McpIdentityIssuer;
  getSlackEmail: (slackUserId: string) => Promise<string>;
  fetch?: McpGwGoogleAuthFetch;
  requestTimeoutMs?: number;
}): McpGwGoogleAuthService {
  const clientConfig = async (principal: McpGwGoogleAuthPrincipal) => {
    const assertion = await resolveMcpUserAssertion({
      workspaceId: principal.workspaceId,
      slackUserId: principal.slackUserId,
      audience: input.audience,
      issuer: input.issuer,
      getSlackEmail: input.getSlackEmail,
    });
    return {
      mcpUrl: input.mcpUrl,
      bearerToken: assertion.token,
      ...(input.fetch ? { fetch: input.fetch } : {}),
      ...(input.requestTimeoutMs
        ? { requestTimeoutMs: input.requestTimeoutMs }
        : {}),
    };
  };

  return {
    async start(principal, startInput = {}) {
      return startMcpGwGoogleAuth(
        await clientConfig(principal),
        startInput,
      );
    },
    async status(principal) {
      return getMcpGwGoogleAuthStatus(await clientConfig(principal));
    },
    async disconnect(principal) {
      await disconnectMcpGwGoogleAuth(await clientConfig(principal));
    },
  };
}
