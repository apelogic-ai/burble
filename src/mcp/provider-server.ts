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
} from "../providers/github/client";
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
} from "../providers/google/client";
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
} from "../providers/jira/client";
import { searchSlackMessages, searchSlackUsers } from "../providers/slack/client";
import type { RuntimeJwtIssuer } from "../runtime-jwt";
import type { RuntimeJwtClaims } from "../runtime-jwt";
import {
  buildRuntimeManifestForRecord,
  enabledManifestToolNames
} from "../agent/runtime-policy";
import type { RuntimeManifest } from "../agent/runtime-manifest";
import { assertScheduledJobCapabilityMatchesRuntime } from "../agent/scheduled-job-auth";
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

  const manifest = buildRuntimeManifestForRecord({ config, store, runtime });
  const jobClaimValidation = validateJobScopedProviderMcpClaims(
    store,
    runtime,
    auth.claims
  );
  if (jobClaimValidation.response) {
    return jobClaimValidation.response;
  }

  const routeValidation = await validateProviderMcpRoute(
    request,
    store,
    runtime,
    manifest
  );
  if (routeValidation.response) {
    return routeValidation.response;
  }

  const enabledTools = enabledToolsForClaims(manifest, auth.claims);
  const jobScopeValidation = await validateJobScopedProviderMcpToolAccess(
    routeValidation.request,
    store,
    runtime,
    auth.claims,
    enabledTools
  );
  if (jobScopeValidation.response) {
    return jobScopeValidation.response;
  }

  const server = createProviderMcpServer(config, store, runtime, deps, scope, {
    enabledTools
  });
  const transport = new WebStandardStreamableHTTPServerTransport();

  await server.connect(transport);
  return transport.handleRequest(routeValidation.request);
}

function createProviderMcpServer(
  config: Config,
  store: TokenStore,
  runtime: AgentRuntimeRecord,
  deps: ProviderMcpDeps,
  scope: ProviderMcpScope,
  policy: {
    enabledTools: ReadonlySet<string>;
  }
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
    registerGitHubMcpTools({ server, store, runtime, deps: allDeps, policy });
  }
  if (scope === "all" || scope === "google") {
    registerGoogleMcpTools({ server, store, runtime, deps: allDeps, policy });
  }
  if (scope === "all" || scope === "jira") {
    registerJiraMcpTools({ server, store, runtime, deps: allDeps, policy });
  }
  if (scope === "all" || scope === "slack") {
    registerSlackMcpTools({ server, store, runtime, deps: allDeps, policy });
  }
  if (scope === "all" || scope === "atlassian") {
    registerAtlassianMcpTools({
      server,
      config,
      store,
      runtime,
      deps: allDeps,
      policy
    });
  }

  return server;
}

function authorizeProviderMcpRequest(
  config: Config,
  store: TokenStore,
  runtimeJwtIssuer: RuntimeJwtIssuer,
  request: Request
): {
  runtime: AgentRuntimeRecord | null;
  claims: RuntimeJwtClaims | null;
  reason?: "missing_bearer" | "invalid_jwt";
} {
  const bearerToken = readBearerToken(request);
  if (!bearerToken) {
    return { runtime: null, claims: null, reason: "missing_bearer" };
  }

  const claims = runtimeJwtIssuer.verifyRuntimeJwt({
    token: bearerToken,
    audience:
      config.agentRuntimeMcpAudience ??
      config.agentRuntimeMcpGatewayUrl ??
      `${config.runtimeJwtIssuer}/mcp`
  });
  if (!claims) {
    return { runtime: null, claims: null, reason: "invalid_jwt" };
  }

  const runtime = store.getAgentRuntime(claims.runtime_id);
  if (
    !runtime ||
    runtime.workspaceId !== claims.workspace_id ||
    runtime.slackUserId !== claims.slack_user_id
  ) {
    return { runtime: null, claims: null, reason: "invalid_jwt" };
  }

  return { runtime, claims };
}

function enabledToolsForClaims(
  manifest: RuntimeManifest,
  claims: RuntimeJwtClaims | null
): ReadonlySet<string> {
  const enabledTools = enabledManifestToolNames(manifest);
  if (!claims?.allowed_tools) {
    return enabledTools;
  }
  return new Set(
    claims.allowed_tools.filter((toolName) => enabledTools.has(toolName))
  );
}

function validateJobScopedProviderMcpClaims(
  store: TokenStore,
  runtime: AgentRuntimeRecord,
  claims: RuntimeJwtClaims | null
): { response: Response | null } {
  if (!claims?.job_id) {
    return { response: null };
  }

  const capability = store.getAgentJobCapability(claims.job_id);
  if (!capability) {
    return {
      response: forbiddenJsonResponse(
        "Scheduled job capability not found or inactive"
      )
    };
  }

  try {
    assertScheduledJobCapabilityMatchesRuntime(runtime, capability);
  } catch {
    return {
      response: forbiddenJsonResponse(
        "Scheduled job capability does not match runtime"
      )
    };
  }

  if (!claims.allowed_tools?.length) {
    return {
      response: forbiddenJsonResponse(
        "Scheduled job runtime token must include allowed tools"
      )
    };
  }

  const requiredTools = new Set(capability.requiredTools);
  if (claims.allowed_tools.some((toolName) => !requiredTools.has(toolName))) {
    return {
      response: forbiddenJsonResponse(
        "Scheduled job runtime token exceeds stored tool capability"
      )
    };
  }

  return { response: null };
}

async function validateJobScopedProviderMcpToolAccess(
  request: Request,
  store: TokenStore,
  runtime: AgentRuntimeRecord,
  claims: RuntimeJwtClaims | null,
  enabledTools: ReadonlySet<string>
): Promise<{ response: Response | null }> {
  if (!claims?.allowed_tools || request.method !== "POST") {
    return { response: null };
  }

  let payload: unknown;
  try {
    payload = await request.clone().json();
  } catch {
    return { response: null };
  }

  const call = readJsonRpcToolCall(payload);
  if (!call || enabledTools.has(call.name)) {
    return { response: null };
  }

  store.recordAgentRuntimeEvent({
    runtimeId: runtime.id,
    eventType: "runtime_tool_called",
    summary: {
      tool: call.name,
      allowed: false,
      reason: "job_scope_denied",
      jobId: claims.job_id ?? null
    }
  });

  return {
    response: mcpJsonRpcErrorResponse(
      readJsonRpcId(payload),
      -32020,
      `Tool ${call.name} is not available to this job.`
    )
  };
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
  runtime: AgentRuntimeRecord,
  manifest: RuntimeManifest
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

  const confirmationValidation = validateProviderMcpConfirmation(
    payload,
    manifest
  );
  if (confirmationValidation.response) {
    return {
      request,
      response: confirmationValidation.response
    };
  }

  const routeId = readProviderMcpRouteId(payload);
  if (!routeId) {
    return {
      request: confirmationValidation.request
        ? replaceRequestJsonBody(request, confirmationValidation.request)
        : request,
      response: null
    };
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
    request: replaceRequestJsonBody(
      request,
      stripProviderMcpRouteId(confirmationValidation.request ?? payload)
    ),
    response: null
  };
}

function validateProviderMcpConfirmation(
  payload: unknown,
  manifest: RuntimeManifest
): { request: unknown | null; response: Response | null } {
  const call = readJsonRpcToolCall(payload);
  if (!call) {
    return { request: null, response: null };
  }

  const tool = manifest.tools.find((entry) => entry.name === call.name);
  if (!tool || !tool.enabled || tool.confirmation === "none") {
    return {
      request: stripProviderMcpConfirmation(payload),
      response: null
    };
  }

  const confirmation = readProviderMcpConfirmation(payload);
  if (!confirmation) {
    return {
      request: null,
      response: mcpJsonRpcErrorResponse(
        readJsonRpcId(payload),
        -32010,
        `Tool ${call.name} requires ${tool.confirmation} confirmation.`
      )
    };
  }

  if (
    confirmation.policyHash !== manifest.policyHash ||
    confirmation.tool !== call.name ||
    (tool.confirmation === "strong"
      ? confirmation.level !== "strong"
      : confirmation.level !== "explicit" && confirmation.level !== "strong")
  ) {
    return {
      request: null,
      response: mcpJsonRpcErrorResponse(
        readJsonRpcId(payload),
        -32011,
        `Tool ${call.name} confirmation does not match the active runtime policy.`
      )
    };
  }

  return {
    request: stripProviderMcpConfirmation(payload),
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

function readProviderMcpConfirmation(payload: unknown): {
  tool: string;
  policyHash: string;
  level: "explicit" | "strong";
} | null {
  if (!isJsonRpcToolCall(payload)) {
    return null;
  }
  const args = payload.params.arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return null;
  }
  const confirmation = (args as Record<string, unknown>).confirmation;
  if (
    !confirmation ||
    typeof confirmation !== "object" ||
    Array.isArray(confirmation)
  ) {
    return null;
  }
  const record = confirmation as Record<string, unknown>;
  if (
    typeof record.tool === "string" &&
    typeof record.policyHash === "string" &&
    (record.level === "explicit" || record.level === "strong")
  ) {
    return {
      tool: record.tool,
      policyHash: record.policyHash,
      level: record.level
    };
  }
  return null;
}

function stripProviderMcpConfirmation(payload: unknown): unknown {
  if (!isJsonRpcToolCall(payload)) {
    return payload;
  }
  const args = payload.params.arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return payload;
  }
  const {
    confirmation: _confirmation,
    ...rest
  } = args as Record<string, unknown>;
  return {
    ...payload,
    params: {
      ...payload.params,
      arguments: rest
    }
  };
}

function readJsonRpcToolCall(payload: unknown): { name: string } | null {
  if (!isJsonRpcToolCall(payload)) {
    return null;
  }
  const name = payload.params.name;
  return typeof name === "string" && name.trim() ? { name } : null;
}

function isJsonRpcToolCall(
  payload: unknown
): payload is {
  id?: unknown;
  method: "tools/call";
  params: { name?: unknown; arguments?: unknown };
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

function forbiddenJsonResponse(errorDescription: string): Response {
  return Response.json(
    {
      error: "forbidden",
      error_description: errorDescription
    },
    { status: 403 }
  );
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
