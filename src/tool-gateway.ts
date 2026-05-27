import type { Config } from "./config";
import type { AgentRuntimeRecord, TokenStore } from "./db";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  getGitHubUser,
  listAssignedIssues,
  listMyPullRequests,
  searchIssues
} from "./github";
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
} from "./jira";
import {
  callUpstreamMcpTool,
  listUpstreamMcpTools,
  type UpstreamMcpTool,
  type UpstreamMcpToolResult
} from "./mcp/upstream-http-client";
import { searchSlackMessages, searchSlackUsers } from "./slack-api";
import { createGitHubTools } from "./tools/github";
import {
  createJiraTools,
  isJiraAuthErrorResult,
  type JiraToolDeps,
  withFreshJiraToken
} from "./tools/jira";
import { createSlackTools, type SlackToolDeps } from "./tools/slack";
import type { ToolResult } from "./tools/types";
import {
  logAtlassianMcpCallFailure,
  logAtlassianMcpCallFinish,
  logAtlassianMcpCallStart
} from "./mcp/atlassian-logging";
import { verifyJiraAuthForOpaqueAtlassianMcpError } from "./mcp/atlassian-auth";

type ToolGatewayDeps = Partial<Parameters<typeof createGitHubTools>[0]> &
  Partial<JiraToolDeps> &
  Partial<SlackToolDeps> & {
    postActiveConversationMessage?: (input: {
      transport: "slack";
      channelId: string;
      text: string;
      threadTs?: string;
    }) => Promise<{
      transport: "slack";
      channelId: string;
      messageId?: string;
    }>;
    listAtlassianMcpTools?: (input: {
      url: string;
      accessToken: string;
    }) => Promise<UpstreamMcpTool[]>;
    callAtlassianMcpTool?: (input: {
      url: string;
      accessToken: string;
      name: string;
      arguments?: Record<string, unknown>;
    }) => Promise<UpstreamMcpToolResult>;
  };

type ToolGatewayBody = {
  user?: {
    email?: unknown;
  };
  input?: unknown;
  conversation?: unknown;
};

const defaultDeps = {
  getGitHubUser,
  listAssignedIssues,
  searchIssues,
  listMyPullRequests,
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

type ToolGatewayAuth =
  | { kind: "legacy" }
  | { kind: "runtime"; runtime: AgentRuntimeRecord };

export async function handleToolGatewayRequest(
  config: Config,
  store: TokenStore,
  toolName: string,
  request: Request,
  deps: ToolGatewayDeps = {}
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const auth = authorizeToolGateway(config, store, request);
  if (!auth) {
    return new Response("Unauthorized", { status: 401 });
  }

  if (!isKnownTool(toolName)) {
    return new Response("Unknown tool", { status: 404 });
  }

  const body = await readToolGatewayBody(request);
  if (toolName === "conversation.sendMessage") {
    if (auth.kind !== "runtime") {
      return new Response("Runtime auth required", { status: 403 });
    }
    if (!isConversationSendInput(body?.input)) {
      return new Response("Invalid tool input", { status: 400 });
    }
    const sendInput = body.input;
    const destination = sendInput.routeId
      ? resolveConversationRouteDestination(store, auth.runtime, sendInput.routeId)
      : resolveActiveConversationDestination(auth.runtime, body?.conversation);
    if (!destination.ok) {
      return new Response(destination.message, { status: destination.status });
    }

    const result = await (deps.postActiveConversationMessage ??
      ((input) => defaultPostActiveConversationMessage(config, input)))({
      transport: destination.transport,
      channelId: destination.channelId,
      text: sendInput.text,
      ...(destination.threadTs ? { threadTs: destination.threadTs } : {})
    });

    return jsonResponseWithAudit(store, auth, toolName, {
      classification: "user_private",
      content: {
        ok: true,
        transport: result.transport,
        conversationId: result.channelId,
        ...(sendInput.routeId ? { routeId: sendInput.routeId } : {}),
        ...(result.messageId ? { messageId: result.messageId } : {})
      }
    });
  }

  if (!body || typeof body.user?.email !== "string") {
    return new Response("Invalid tool input", { status: 400 });
  }

  const provider = readToolProvider(toolName);
  const connection = store.getConnection(provider, body.user.email);
  if (!connection) {
    return jsonResponse({
      classification: "user_private",
      content: {
        error: `${provider}_not_connected`,
        message:
          provider === "github"
            ? "Connect GitHub first: `@Burble connect github`."
            : provider === "jira"
              ? "Connect Jira first."
              : "Connect Slack search first: `/auth slack`."
      }
    });
  }
  if (auth.kind === "runtime" && connection.slackUserId !== auth.runtime.slackUserId) {
    return new Response("Runtime principal mismatch", { status: 403 });
  }

  const tools = createGitHubTools({ ...defaultDeps, ...deps });
  const jiraTools = createJiraTools({
    ...defaultDeps,
    refreshJiraAccessToken: (refreshToken) =>
      refreshJiraAccessToken(config, refreshToken),
    saveJiraConnection: (connection) => store.upsertProviderConnection(connection),
    ...deps
  });
  const slackTools = createSlackTools({ ...defaultDeps, ...deps });

  switch (toolName) {
    case "github.getAuthenticatedUser":
      return jsonResponseWithAudit(
        store,
        auth,
        toolName,
        await tools.getAuthenticatedUser.execute({ connection })
      );

    case "github.listAssignedIssues":
      return jsonResponseWithAudit(
        store,
        auth,
        toolName,
        await tools.listAssignedIssues.execute({ connection })
      );

    case "github.searchIssues": {
      if (!isSearchIssuesInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return jsonResponseWithAudit(
        store,
        auth,
        toolName,
        await tools.searchIssues.execute({
          connection,
          input: { query: body.input.query }
        })
      );
    }

    case "github.listMyPullRequests":
      return jsonResponseWithAudit(
        store,
        auth,
        toolName,
        await tools.listMyPullRequests.execute({ connection })
      );

    case "jira.getAuthenticatedUser":
      return jsonResponseWithAudit(
        store,
        auth,
        toolName,
        await jiraTools.getAuthenticatedUser.execute({ connection })
      );

    case "jira.listAccessibleResources":
      return jsonResponseWithAudit(
        store,
        auth,
        toolName,
        await jiraTools.listAccessibleResources.execute({ connection })
      );

    case "jira.listVisibleProjects": {
      if (!isListVisibleJiraProjectsInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return jsonResponseWithAudit(
        store,
        auth,
        toolName,
        await jiraTools.listVisibleProjects.execute({
          connection,
          input: body.input
        })
      );
    }

    case "jira.searchUsers": {
      if (!isSearchJiraUsersInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return jsonResponseWithAudit(
        store,
        auth,
        toolName,
        await jiraTools.searchUsers.execute({
          connection,
          input: { query: body.input.query }
        })
      );
    }

    case "jira.createIssue": {
      if (!isCreateJiraIssueInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return jsonResponseWithAudit(
        store,
        auth,
        toolName,
        await jiraTools.createIssue.execute({
          connection,
          input: body.input
        })
      );
    }

    case "jira.editIssue": {
      if (!isEditJiraIssueInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return jsonResponseWithAudit(
        store,
        auth,
        toolName,
        await jiraTools.editIssue.execute({
          connection,
          input: body.input
        })
      );
    }

    case "jira.listAssignedIssues":
      return jsonResponseWithAudit(
        store,
        auth,
        toolName,
        await jiraTools.listAssignedIssues.execute({ connection })
      );

    case "jira.searchIssues": {
      if (!isSearchJiraIssuesInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return jsonResponseWithAudit(
        store,
        auth,
        toolName,
        await jiraTools.searchIssues.execute({
          connection,
          input: { jql: body.input.jql }
        })
      );
    }

    case "slack.searchUsers": {
      if (!isSearchSlackUsersInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return jsonResponseWithAudit(
        store,
        auth,
        toolName,
        await slackTools.searchUsers.execute({
          connection,
          input: { query: body.input.query }
        })
      );
    }

    case "slack.searchMessages": {
      if (!isSearchSlackMessagesInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return jsonResponseWithAudit(
        store,
        auth,
        toolName,
        await slackTools.searchMessages.execute({
          connection,
          input: body.input
        })
      );
    }

    case "atlassian.listMcpTools": {
      const result = await withFreshJiraToken(
        {
          ...defaultDeps,
          refreshJiraAccessToken: (refreshToken) =>
            refreshJiraAccessToken(config, refreshToken),
          saveJiraConnection: (updatedConnection) =>
            store.upsertProviderConnection(updatedConnection),
          ...deps
        },
        connection,
        async (accessToken) => {
          const tools = await (deps.listAtlassianMcpTools ??
            defaultListAtlassianMcpTools)({
            url: config.atlassianMcpUrl,
            accessToken
          });

          return {
            classification: "user_private" as const,
            content: tools
              .filter((tool) => isAllowedAtlassianMcpToolName(tool.name))
              .slice(0, 50)
              .map((tool) => ({
                name: tool.name,
                ...(tool.title ? { title: tool.title } : {}),
                ...(tool.description ? { description: tool.description } : {}),
                ...("inputSchema" in tool
                  ? { inputSchema: sanitizeMcpInputSchema(tool.inputSchema) }
                  : {})
              }))
          };
        }
      );

      return jsonResponseWithAudit(
        store,
        auth,
        toolName,
        isJiraAuthErrorResult(result) ? result : result
      );
    }

    case "atlassian.callMcpTool": {
      if (!isAtlassianMcpToolCallInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }
      const atlassianInput = body.input;

      if (!isAllowedAtlassianMcpToolName(atlassianInput.name)) {
        return jsonResponseWithAudit(store, auth, toolName, {
          classification: "user_private",
          content: {
            error: "atlassian_mcp_tool_not_allowed",
            message: `Atlassian MCP tool \`${atlassianInput.name}\` is not enabled for use.`
          }
        });
      }

      const result = await withFreshJiraToken(
        {
          ...defaultDeps,
          refreshJiraAccessToken: (refreshToken) =>
            refreshJiraAccessToken(config, refreshToken),
          saveJiraConnection: (updatedConnection) =>
            store.upsertProviderConnection(updatedConnection),
          ...deps
        },
        connection,
        async (accessToken) => {
          logAtlassianMcpCallStart(
            "http",
            auth.kind === "runtime" ? auth.runtime.id : "legacy",
            atlassianInput.name,
            atlassianInput.arguments
          );
          let upstreamResult: UpstreamMcpToolResult;
          try {
            upstreamResult = await (deps.callAtlassianMcpTool ??
              defaultCallAtlassianMcpTool)({
              url: config.atlassianMcpUrl,
              accessToken,
              name: atlassianInput.name,
              arguments: atlassianInput.arguments
            });
          } catch (error) {
            logAtlassianMcpCallFailure(
              "http",
              auth.kind === "runtime" ? auth.runtime.id : "legacy",
              atlassianInput.name,
              error
            );
            throw error;
          }
          logAtlassianMcpCallFinish(
            "http",
            auth.kind === "runtime" ? auth.runtime.id : "legacy",
            atlassianInput.name,
            upstreamResult
          );
          await verifyJiraAuthForOpaqueAtlassianMcpError(
            upstreamResult,
            accessToken,
            { getJiraUser: deps.getJiraUser ?? defaultDeps.getJiraUser }
          );

          return {
            classification: "user_private" as const,
            content: {
              toolName: atlassianInput.name,
              result: sanitizeUpstreamMcpToolResult(upstreamResult)
            }
          };
        }
      );

      return jsonResponseWithAudit(
        store,
        auth,
        toolName,
        isJiraAuthErrorResult(result) ? result : result
      );
    }
  }

  return new Response("Unknown tool", { status: 404 });
}

function authorizeToolGateway(
  config: Config,
  store: TokenStore,
  request: Request
): ToolGatewayAuth | null {
  const bearerToken = readBearerToken(request);
  if (!config.internalApiToken && !bearerToken) {
    return { kind: "legacy" };
  }

  if (config.internalApiToken && bearerToken === config.internalApiToken) {
    return { kind: "legacy" };
  }

  const runtimeId = request.headers.get("x-burble-runtime-id")?.trim();
  if (!runtimeId || !bearerToken) {
    return null;
  }

  const runtime = store.getAgentRuntime(runtimeId);
  if (!runtime || !isRuntimeTokenValid(bearerToken, runtime.authTokenHash)) {
    return null;
  }

  return { kind: "runtime", runtime };
}

function readBearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization")?.trim();
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }

  const token = authorization.slice("Bearer ".length).trim();
  return token ? token : null;
}

function isRuntimeTokenValid(token: string, tokenHash: string): boolean {
  const actual = createHash("sha256").update(token).digest("hex");
  if (actual.length !== tokenHash.length) {
    return false;
  }

  return timingSafeEqual(Buffer.from(actual), Buffer.from(tokenHash));
}

function isKnownTool(toolName: string): boolean {
  return (
    toolName === "github.getAuthenticatedUser" ||
    toolName === "github.listAssignedIssues" ||
    toolName === "github.searchIssues" ||
    toolName === "github.listMyPullRequests" ||
    toolName === "jira.getAuthenticatedUser" ||
    toolName === "jira.listAccessibleResources" ||
    toolName === "jira.listVisibleProjects" ||
    toolName === "jira.searchUsers" ||
    toolName === "jira.createIssue" ||
    toolName === "jira.editIssue" ||
    toolName === "jira.listAssignedIssues" ||
    toolName === "jira.searchIssues" ||
    toolName === "slack.searchUsers" ||
    toolName === "slack.searchMessages" ||
    toolName === "conversation.sendMessage" ||
    toolName === "atlassian.listMcpTools" ||
    toolName === "atlassian.callMcpTool"
  );
}

function readToolProvider(toolName: string): "github" | "jira" | "slack" {
  return toolName.startsWith("slack.")
    ? "slack"
    : toolName.startsWith("jira.") || toolName.startsWith("atlassian.")
    ? "jira"
    : "github";
}

async function readToolGatewayBody(
  request: Request
): Promise<ToolGatewayBody | null> {
  try {
    return (await request.json()) as ToolGatewayBody;
  } catch {
    return null;
  }
}

function isSearchIssuesInput(input: unknown): input is { query: string } {
  return (
    typeof input === "object" &&
    input !== null &&
    "query" in input &&
    typeof input.query === "string" &&
    input.query.trim().length > 0
  );
}

function isSearchJiraIssuesInput(input: unknown): input is { jql: string } {
  return (
    typeof input === "object" &&
    input !== null &&
    "jql" in input &&
    typeof input.jql === "string" &&
    input.jql.trim().length > 0
  );
}

function isSearchJiraUsersInput(input: unknown): input is { query: string } {
  return (
    typeof input === "object" &&
    input !== null &&
    "query" in input &&
    typeof input.query === "string" &&
    input.query.trim().length > 0
  );
}

function isSearchSlackUsersInput(input: unknown): input is { query: string } {
  return isSearchJiraUsersInput(input);
}

function isSearchSlackMessagesInput(input: unknown): input is {
  query: string;
  fromUserId?: string;
  inChannel?: string;
  limit?: number;
} {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return false;
  }
  const record = input as Record<string, unknown>;
  return (
    typeof record.query === "string" &&
    record.query.trim().length > 0 &&
    optionalString(record.fromUserId) &&
    optionalString(record.inChannel) &&
    (record.limit === undefined ||
      (typeof record.limit === "number" &&
        Number.isInteger(record.limit) &&
        record.limit > 0 &&
        record.limit <= 20))
  );
}

function isCreateJiraIssueInput(input: unknown): input is {
  projectKey: string;
  issueTypeName?: string;
  issueTypeId?: string;
  summary: string;
  description?: string;
  assigneeAccountId?: string;
} {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return false;
  }
  const record = input as Record<string, unknown>;
  return (
    typeof record.projectKey === "string" &&
    record.projectKey.trim().length > 0 &&
    ((typeof record.issueTypeName === "string" &&
      record.issueTypeName.trim().length > 0) ||
      (typeof record.issueTypeId === "string" &&
        record.issueTypeId.trim().length > 0)) &&
    typeof record.summary === "string" &&
    record.summary.trim().length > 0 &&
    optionalString(record.description) &&
    optionalString(record.assigneeAccountId)
  );
}

function isEditJiraIssueInput(input: unknown): input is {
  issueKey: string;
  summary?: string;
  description?: string;
  assigneeAccountId?: string | null;
} {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return false;
  }
  const record = input as Record<string, unknown>;
  return (
    typeof record.issueKey === "string" &&
    record.issueKey.trim().length > 0 &&
    optionalString(record.summary) &&
    optionalString(record.description) &&
    (record.assigneeAccountId === undefined ||
      record.assigneeAccountId === null ||
      typeof record.assigneeAccountId === "string") &&
    (typeof record.summary === "string" ||
      typeof record.description === "string" ||
      typeof record.assigneeAccountId === "string" ||
      record.assigneeAccountId === null)
  );
}

function isListVisibleJiraProjectsInput(
  input: unknown
): input is {
  query?: string;
  action?: "view" | "browse" | "edit" | "create";
  expandIssueTypes?: boolean;
} {
  if (input === undefined) {
    return true;
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return false;
  }

  const record = input as Record<string, unknown>;
  return (
    (!("query" in record) ||
      record.query === undefined ||
      typeof record.query === "string") &&
    (!("action" in record) ||
      record.action === undefined ||
      record.action === "view" ||
      record.action === "browse" ||
      record.action === "edit" ||
      record.action === "create") &&
    (!("expandIssueTypes" in record) ||
      record.expandIssueTypes === undefined ||
      typeof record.expandIssueTypes === "boolean")
  );
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isConversationSendInput(
  input: unknown
): input is { text: string; routeId?: string } {
  return (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    "text" in input &&
    typeof input.text === "string" &&
    input.text.trim().length > 0 &&
    input.text.length <= 4000 &&
    (!("routeId" in input) ||
      input.routeId === undefined ||
      (typeof input.routeId === "string" && input.routeId.trim().length > 0))
  );
}

function isActiveConversation(conversation: unknown): conversation is {
  source: "slack";
  workspaceId: string;
  channelId: string;
  rootId: string;
  isDirectMessage: boolean;
} {
  if (
    typeof conversation !== "object" ||
    conversation === null ||
    Array.isArray(conversation)
  ) {
    return false;
  }

  const record = conversation as Record<string, unknown>;
  return (
    record.source === "slack" &&
    typeof record.workspaceId === "string" &&
    record.workspaceId.trim().length > 0 &&
    typeof record.channelId === "string" &&
    record.channelId.trim().length > 0 &&
    typeof record.rootId === "string" &&
    record.rootId.trim().length > 0 &&
    typeof record.isDirectMessage === "boolean"
  );
}

function readConversationThread(conversation: {
  rootId: string;
}): { threadTs?: string } {
  const match = conversation.rootId.match(/^(?:channel|dm):[^:]+:thread:(.+)$/);
  const threadTs = match?.[1]?.trim();
  return threadTs ? { threadTs } : {};
}

function resolveActiveConversationDestination(
  runtime: AgentRuntimeRecord,
  conversation: unknown
):
  | {
      ok: true;
      transport: "slack";
      channelId: string;
      threadTs?: string;
    }
  | { ok: false; status: number; message: string } {
  if (!isActiveConversation(conversation)) {
    return { ok: false, status: 400, message: "Invalid tool input" };
  }
  if (conversation.workspaceId !== runtime.workspaceId) {
    return {
      ok: false,
      status: 403,
      message: "Runtime principal mismatch"
    };
  }

  return {
    ok: true,
    transport: conversation.source,
    channelId: conversation.channelId,
    ...readConversationThread(conversation)
  };
}

function resolveConversationRouteDestination(
  store: TokenStore,
  runtime: AgentRuntimeRecord,
  routeId: string
):
  | {
      ok: true;
      transport: "slack";
      channelId: string;
      threadTs?: string;
    }
  | { ok: false; status: number; message: string } {
  const route = store.getConversationRoute(routeId);
  if (!route) {
    return { ok: false, status: 404, message: "Conversation route not found" };
  }
  if (route.revokedAt) {
    return { ok: false, status: 410, message: "Conversation route revoked" };
  }
  if (
    route.workspaceId !== runtime.workspaceId ||
    route.slackUserId !== runtime.slackUserId
  ) {
    return {
      ok: false,
      status: 403,
      message: "Runtime principal mismatch"
    };
  }
  if (route.transport !== "slack") {
    return {
      ok: false,
      status: 400,
      message: "Unsupported conversation transport"
    };
  }

  const destination = readSlackRouteDestination(route.destinationJson);
  if (!destination) {
    return {
      ok: false,
      status: 400,
      message: "Invalid conversation route"
    };
  }

  return {
    ok: true,
    transport: "slack",
    ...destination
  };
}

function readSlackRouteDestination(
  destinationJson: string
): { channelId: string; threadTs?: string } | null {
  try {
    const parsed = JSON.parse(destinationJson) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }

    const record = parsed as Record<string, unknown>;
    if (
      typeof record.channelId !== "string" ||
      record.channelId.trim().length === 0
    ) {
      return null;
    }
    if (
      "threadTs" in record &&
      record.threadTs !== undefined &&
      typeof record.threadTs !== "string"
    ) {
      return null;
    }

    return {
      channelId: record.channelId,
      ...(typeof record.threadTs === "string" && record.threadTs.trim()
        ? { threadTs: record.threadTs }
        : {})
    };
  } catch {
    return null;
  }
}

function isAtlassianMcpToolCallInput(
  input: unknown
): input is { name: string; arguments?: Record<string, unknown> } {
  if (
    typeof input !== "object" ||
    input === null ||
    !("name" in input) ||
    typeof input.name !== "string" ||
    input.name.trim().length === 0
  ) {
    return false;
  }

  return (
    !("arguments" in input) ||
    input.arguments === undefined ||
    (typeof input.arguments === "object" &&
      input.arguments !== null &&
      !Array.isArray(input.arguments))
  );
}

function defaultListAtlassianMcpTools(input: {
  url: string;
  accessToken: string;
}): Promise<UpstreamMcpTool[]> {
  return listUpstreamMcpTools({
    url: input.url,
    authorization: `Bearer ${input.accessToken}`,
    clientName: "burble-atlassian-mcp-facade",
    clientVersion: "0.1.0"
  });
}

function defaultCallAtlassianMcpTool(input: {
  url: string;
  accessToken: string;
  name: string;
  arguments?: Record<string, unknown>;
}): Promise<UpstreamMcpToolResult> {
  return callUpstreamMcpTool(
    {
      url: input.url,
      authorization: `Bearer ${input.accessToken}`,
      clientName: "burble-atlassian-mcp-facade",
      clientVersion: "0.1.0"
    },
    {
      name: input.name,
      arguments: input.arguments
    }
  );
}

async function defaultPostActiveConversationMessage(
  config: Config,
  input: {
    transport: "slack";
    channelId: string;
    text: string;
    threadTs?: string;
  }
): Promise<{ transport: "slack"; channelId: string; messageId?: string }> {
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.slackBotToken}`,
      "content-type": "application/json; charset=utf-8"
    },
    body: JSON.stringify({
      channel: input.channelId,
      text: input.text,
      ...(input.threadTs ? { thread_ts: input.threadTs } : {})
    })
  });

  const body = (await response.json()) as {
    ok?: boolean;
    error?: string;
    channel?: string;
    ts?: string;
  };
  if (!response.ok || !body.ok) {
    throw new Error(
      `Slack message send failed: ${body.error ?? `HTTP ${response.status}`}`
    );
  }

  return {
    transport: "slack",
    channelId: body.channel ?? input.channelId,
    ...(body.ts ? { messageId: body.ts } : {})
  };
}

const allowedMutatingAtlassianMcpTools = new Set([
  "addcommenttojiraissue",
  "addworklogtojiraissue",
  "createjiraissue",
  "editjiraissue",
  "transitionjiraissue"
]);

function isAllowedAtlassianMcpToolName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  if (allowedMutatingAtlassianMcpTools.has(normalized)) {
    return true;
  }

  if (
    /(create|update|delete|remove|transition|assign|comment|attach|add|set|edit|move|link)/.test(
      normalized
    )
  ) {
    return false;
  }

  return /^(get|list|search|find|read|lookup|fetch|describe)/.test(normalized);
}

function sanitizeUpstreamMcpToolResult(
  result: UpstreamMcpToolResult
): UpstreamMcpToolResult {
  return {
    ...(Array.isArray(result.content)
      ? { content: result.content.slice(0, 20).map(sanitizeMcpContentItem) }
      : {}),
    ...(typeof result.isError === "boolean" ? { isError: result.isError } : {})
  };
}

function sanitizeMcpInputSchema(schema: unknown): unknown {
  if (schema === undefined) {
    return undefined;
  }

  try {
    const text = JSON.stringify(schema);
    return text.length <= 12_000 ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeMcpContentItem(item: unknown): unknown {
  if (!item || typeof item !== "object") {
    return item;
  }

  const record = item as Record<string, unknown>;
  if (record.type === "text" && typeof record.text === "string") {
    return {
      type: "text",
      text: record.text.slice(0, 12_000)
    };
  }

  return record;
}

function jsonResponse(result: ToolResult<unknown>): Response {
  return Response.json(result, {
    headers: {
      "cache-control": "no-store"
    }
  });
}

function jsonResponseWithAudit(
  store: TokenStore,
  auth: ToolGatewayAuth,
  toolName: string,
  result: ToolResult<unknown>
): Response {
  if (auth.kind === "runtime") {
    store.recordAgentRuntimeEvent({
      runtimeId: auth.runtime.id,
      eventType: "runtime_tool_called",
      summary: {
        toolName,
        classification: result.classification,
        itemCount: Array.isArray(result.content) ? result.content.length : null
      }
    });
  }

  return jsonResponse(result);
}
