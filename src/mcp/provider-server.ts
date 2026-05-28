import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Config } from "../config";
import type { AgentRuntimeRecord, ProviderConnection, TokenStore } from "../db";
import {
  addGitHubIssueLabels,
  closeGitHubIssue,
  commentOnGitHubIssueOrPullRequest,
  createGitHubBranch,
  createGitHubIssue,
  createGitHubPullRequest,
  createOrUpdateGitHubFile,
  getGitHubFile,
  getGitHubIssue,
  getGitHubPullRequest,
  getGitHubUser,
  listAssignedIssues,
  listMyPullRequests,
  removeGitHubIssueLabels,
  reopenGitHubIssue,
  requestGitHubPullRequestReview,
  searchIssues,
  updateGitHubIssue,
  updateGitHubPullRequest
} from "../github";
import {
  appendGoogleDriveTextFile,
  createGmailDraft,
  createGoogleCalendarEvent,
  createGoogleDriveFolder,
  createGoogleDriveTextFile,
  getGoogleDriveFile,
  getGoogleUser,
  moveGoogleDriveFile,
  refreshGoogleAccessToken,
  searchGoogleCalendarEvents,
  searchGoogleDriveFiles,
  searchGoogleMailMessages,
  updateGoogleCalendarEvent,
  updateGoogleDriveTextFile
} from "../google";
import {
  addJiraIssueComment,
  addJiraIssueLabels,
  createJiraSubtask,
  createJiraIssue,
  editJiraIssue,
  getJiraIssue,
  getJiraUser,
  linkJiraIssues,
  listJiraAccessibleResources,
  listAssignedJiraIssues,
  listVisibleJiraProjects,
  refreshJiraAccessToken,
  removeJiraIssueLabels,
  searchJiraUsers,
  searchJiraIssues,
  transitionJiraIssue,
  updateJiraIssue
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
  getIssue: getGitHubIssue,
  getPullRequest: getGitHubPullRequest,
  createIssue: createGitHubIssue,
  updateIssue: updateGitHubIssue,
  closeIssue: closeGitHubIssue,
  reopenIssue: reopenGitHubIssue,
  commentOnIssueOrPullRequest: commentOnGitHubIssueOrPullRequest,
  createPullRequest: createGitHubPullRequest,
  updatePullRequest: updateGitHubPullRequest,
  addLabels: addGitHubIssueLabels,
  removeLabels: removeGitHubIssueLabels,
  requestReview: requestGitHubPullRequestReview,
  getFile: getGitHubFile,
  createOrUpdateFile: createOrUpdateGitHubFile,
  createBranch: createGitHubBranch,
  getGoogleUser,
  searchGoogleDriveFiles,
  createGoogleDriveTextFile,
  getGoogleDriveFile,
  updateGoogleDriveTextFile,
  appendGoogleDriveTextFile,
  createGoogleDriveFolder,
  moveGoogleDriveFile,
  searchGoogleCalendarEvents,
  createGoogleCalendarEvent,
  updateGoogleCalendarEvent,
  searchGoogleMailMessages,
  createGmailDraft,
  getJiraUser,
  listJiraAccessibleResources,
  listAssignedJiraIssues,
  listVisibleJiraProjects,
  searchJiraUsers,
  createJiraIssue,
  editJiraIssue,
  getJiraIssue,
  updateJiraIssue,
  addJiraIssueComment,
  transitionJiraIssue,
  addJiraIssueLabels,
  removeJiraIssueLabels,
  linkJiraIssues,
  createJiraSubtask,
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
  store.touchAgentRuntime(runtime.id);

  const routeValidation = await validateProviderMcpRoute(request, store, runtime);
  if (routeValidation.response) {
    return routeValidation.response;
  }

  const server = createProviderMcpServer(config, store, runtime, deps, scope);
  const transport = new WebStandardStreamableHTTPServerTransport();

  await server.connect(transport);
  return transport.handleRequest(routeValidation.request);
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

async function validateProviderMcpRoute(
  request: Request,
  store: TokenStore,
  runtime: AgentRuntimeRecord
): Promise<{ request: Request; response: Response | null }> {
  if (request.method !== "POST") {
    return { request, response: null };
  }

  let payload: unknown;
  try {
    payload = await request.clone().json();
  } catch {
    return { request, response: null };
  }

  const routeId = readProviderMcpRouteId(payload);
  if (!routeId) {
    return { request, response: null };
  }

  const route = store.getConversationRoute(routeId);
  if (!route || route.revokedAt) {
    return {
      request,
      response: mcpJsonRpcErrorResponse(
        readJsonRpcId(payload),
        -32001,
        "Conversation route is not available."
      )
    };
  }

  if (
    route.workspaceId !== runtime.workspaceId ||
    route.slackUserId !== runtime.slackUserId
  ) {
    return {
      request,
      response: mcpJsonRpcErrorResponse(
        readJsonRpcId(payload),
        -32002,
        "Conversation route does not belong to this runtime principal."
      )
    };
  }

  const destination = parseRouteDestination(route.destinationJson);
  if (
    typeof destination.runtimeId === "string" &&
    destination.runtimeId !== runtime.id
  ) {
    return {
      request,
      response: mcpJsonRpcErrorResponse(
        readJsonRpcId(payload),
        -32003,
        "Conversation route is bound to a different runtime."
      )
    };
  }

  return {
    request: replaceRequestJsonBody(request, stripProviderMcpRouteId(payload)),
    response: null
  };
}

function readProviderMcpRouteId(payload: unknown): string | null {
  if (!isJsonRpcToolCall(payload)) {
    return null;
  }
  const args = payload.params.arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return null;
  }
  const routeId = (args as Record<string, unknown>).routeId;
  return typeof routeId === "string" && routeId.trim() ? routeId : null;
}

function stripProviderMcpRouteId(payload: unknown): unknown {
  if (!isJsonRpcToolCall(payload)) {
    return payload;
  }
  const args = payload.params.arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return payload;
  }
  const { routeId: _routeId, ...rest } = args as Record<string, unknown>;
  return {
    ...payload,
    params: {
      ...payload.params,
      arguments: rest
    }
  };
}

function isJsonRpcToolCall(
  payload: unknown
): payload is {
  id?: unknown;
  method: "tools/call";
  params: { arguments?: unknown };
} {
  return (
    typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload) &&
    (payload as { method?: unknown }).method === "tools/call" &&
    typeof (payload as { params?: unknown }).params === "object" &&
    (payload as { params?: unknown }).params !== null &&
    !Array.isArray((payload as { params?: unknown }).params)
  );
}

function readJsonRpcId(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  return (payload as { id?: unknown }).id ?? null;
}

function parseRouteDestination(destinationJson: string): Record<string, unknown> {
  try {
    const destination = JSON.parse(destinationJson);
    return destination &&
      typeof destination === "object" &&
      !Array.isArray(destination)
      ? (destination as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function replaceRequestJsonBody(request: Request, payload: unknown): Request {
  const headers = new Headers(request.headers);
  headers.delete("content-length");

  return new Request(request.url, {
    method: request.method,
    headers,
    body: JSON.stringify(payload)
  });
}

function mcpJsonRpcErrorResponse(
  id: unknown,
  code: number,
  message: string
): Response {
  const payload = {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message
    }
  };
  return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store"
    }
  });
}
