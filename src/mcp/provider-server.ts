import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Config } from "../config";
import type { AgentRuntimeRecord, ProviderConnection, TokenStore } from "../db";
import {
  getGitHubUser,
  listAssignedIssues,
  listMyPullRequests,
  searchIssues
} from "../github";
import {
  getGoogleUser,
  refreshGoogleAccessToken,
  searchGoogleCalendarEvents,
  searchGoogleDriveFiles,
  searchGoogleMailMessages
} from "../google";
import {
  createJiraIssue,
  editJiraIssue,
  getJiraUser,
  listJiraAccessibleResources,
  listAssignedJiraIssues,
  listVisibleJiraProjects,
  refreshJiraAccessToken,
  searchJiraUsers,
  searchJiraIssues
} from "../jira";
import { searchSlackMessages, searchSlackUsers } from "../slack-api";
import type { RuntimeJwtIssuer } from "../runtime-jwt";
import {
  isAllowedAtlassianMcpToolName,
  isReadOnlyAtlassianMcpToolName,
  registerAtlassianMcpTools
} from "./provider-atlassian";
import {
  type ProviderMcpDeps,
  type ProviderMcpScope
} from "./provider-context";
import { registerGitHubMcpTools } from "./provider-github";
import { registerGoogleMcpTools } from "./provider-google";
import { registerJiraMcpTools } from "./provider-jira";
import { registerSlackMcpTools } from "./provider-slack";

export { isAllowedAtlassianMcpToolName, isReadOnlyAtlassianMcpToolName };

const defaultDeps = {
  getGitHubUser,
  listAssignedIssues,
  searchIssues,
  listMyPullRequests,
  getGoogleUser,
  searchGoogleDriveFiles,
  searchGoogleCalendarEvents,
  searchGoogleMailMessages,
  getJiraUser,
  listJiraAccessibleResources,
  listAssignedJiraIssues,
  listVisibleJiraProjects,
  searchJiraUsers,
  createJiraIssue,
  editJiraIssue,
  searchJiraIssues,
  searchSlackMessages,
  searchSlackUsers
};

export async function handleProviderMcpRequest(
  config: Config,
  store: TokenStore,
  runtimeJwtIssuer: RuntimeJwtIssuer,
  request: Request,
  deps: ProviderMcpDeps = {},
  scope: ProviderMcpScope = "all"
): Promise<Response> {
  const auth = authorizeProviderMcpRequest(
    config,
    store,
    runtimeJwtIssuer,
    request
  );
  const runtime = auth.runtime;
  if (!runtime) {
    return Response.json(
      {
        error: "unauthorized",
        error_description:
          auth.reason === "missing_bearer"
            ? "Runtime JWT token required"
            : "Runtime JWT token invalid"
      },
      { status: 401 }
    );
  }

  const server = createProviderMcpServer(config, store, runtime, deps, scope);
  const transport = new WebStandardStreamableHTTPServerTransport();

  await server.connect(transport);
  return transport.handleRequest(request);
}

function createProviderMcpServer(
  config: Config,
  store: TokenStore,
  runtime: AgentRuntimeRecord,
  deps: ProviderMcpDeps,
  scope: ProviderMcpScope
): McpServer {
  const server = new McpServer({
    name: `burble-provider-tools-${scope}`,
    version: "0.1.0"
  });

  const allDeps = {
    ...defaultDeps,
    refreshJiraAccessToken: (refreshToken: string) =>
      refreshJiraAccessToken(config, refreshToken),
    saveJiraConnection: (connection: ProviderConnection) =>
      store.upsertProviderConnection(connection),
    refreshGoogleAccessToken: (refreshToken: string) =>
      refreshGoogleAccessToken(config, refreshToken),
    saveGoogleConnection: (connection: ProviderConnection) =>
      store.upsertProviderConnection(connection),
    ...deps
  };

  if (scope === "all" || scope === "github") {
    registerGitHubMcpTools({ server, store, runtime, deps: allDeps });
  }
  if (scope === "all" || scope === "google") {
    registerGoogleMcpTools({ server, store, runtime, deps: allDeps });
  }
  if (scope === "all" || scope === "jira") {
    registerJiraMcpTools({ server, store, runtime, deps: allDeps });
  }
  if (scope === "all" || scope === "slack") {
    registerSlackMcpTools({ server, store, runtime, deps: allDeps });
  }
  if (scope === "all" || scope === "atlassian") {
    registerAtlassianMcpTools({ server, config, store, runtime, deps: allDeps });
  }

  return server;
}

function authorizeProviderMcpRequest(
  config: Config,
  store: TokenStore,
  runtimeJwtIssuer: RuntimeJwtIssuer,
  request: Request
): { runtime: AgentRuntimeRecord | null; reason?: "missing_bearer" | "invalid_jwt" } {
  const bearerToken = readBearerToken(request);
  if (!bearerToken) {
    return { runtime: null, reason: "missing_bearer" };
  }

  const claims = runtimeJwtIssuer.verifyRuntimeJwt({
    token: bearerToken,
    audience:
      config.agentRuntimeMcpAudience ??
      config.agentRuntimeMcpGatewayUrl ??
      `${config.runtimeJwtIssuer}/mcp`
  });
  if (!claims) {
    return { runtime: null, reason: "invalid_jwt" };
  }

  const runtime = store.getAgentRuntime(claims.runtime_id);
  if (
    !runtime ||
    runtime.workspaceId !== claims.workspace_id ||
    runtime.slackUserId !== claims.slack_user_id
  ) {
    return { runtime: null, reason: "invalid_jwt" };
  }

  return { runtime };
}

function readBearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization")?.trim();
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }

  const token = authorization.slice("Bearer ".length).trim();
  return token ? token : null;
}
