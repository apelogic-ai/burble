import type { McpIdentityIssuer } from "../mcp-identity";
import {
  disconnectMcpGwGitHubAuth,
  getMcpGwGitHubAuthStatus,
  startMcpGwGitHubAuth,
  type McpGwGitHubAuthFetch,
  type McpGwGitHubAuthStatus,
} from "./mcp-gw-github-auth-client";
import { resolveMcpUserAssertion } from "./user-assertion";

export type McpGwGitHubAuthPrincipal = {
  workspaceId: string;
  slackUserId: string;
};

export type McpGwGitHubAuthService = {
  start(
    principal: McpGwGitHubAuthPrincipal,
    input?: { redirectAfter?: string },
  ): Promise<{ authorizationUrl: string }>;
  status(principal: McpGwGitHubAuthPrincipal): Promise<McpGwGitHubAuthStatus>;
  disconnect(principal: McpGwGitHubAuthPrincipal): Promise<void>;
};

export function createMcpGwGitHubAuthService(input: {
  mcpUrl: string;
  audience: string;
  issuer: McpIdentityIssuer;
  getSlackEmail: (slackUserId: string) => Promise<string>;
  fetch?: McpGwGitHubAuthFetch;
  requestTimeoutMs?: number;
}): McpGwGitHubAuthService {
  const clientConfig = async (principal: McpGwGitHubAuthPrincipal) => {
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
      return startMcpGwGitHubAuth(
        await clientConfig(principal),
        startInput,
      );
    },
    async status(principal) {
      return getMcpGwGitHubAuthStatus(await clientConfig(principal));
    },
    async disconnect(principal) {
      await disconnectMcpGwGitHubAuth(await clientConfig(principal));
    },
  };
}
