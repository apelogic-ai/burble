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
  getJiraUser,
  listAssignedJiraIssues,
  refreshJiraAccessToken,
  searchJiraIssues
} from "./jira";
import {
  callUpstreamMcpTool,
  listUpstreamMcpTools,
  type UpstreamMcpTool,
  type UpstreamMcpToolResult
} from "./mcp/upstream-http-client";
import { createGitHubTools } from "./tools/github";
import {
  createJiraTools,
  isJiraAuthErrorResult,
  type JiraToolDeps,
  withFreshJiraToken
} from "./tools/jira";
import type { ToolResult } from "./tools/types";

type ToolGatewayDeps = Partial<Parameters<typeof createGitHubTools>[0]> &
  Partial<JiraToolDeps> & {
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
};

const defaultDeps = {
  getGitHubUser,
  listAssignedIssues,
  searchIssues,
  listMyPullRequests,
  getJiraUser,
  listAssignedJiraIssues,
  searchJiraIssues
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
            : "Connect Jira first."
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
          const upstreamResult = await (deps.callAtlassianMcpTool ??
            defaultCallAtlassianMcpTool)({
            url: config.atlassianMcpUrl,
            accessToken,
            name: atlassianInput.name,
            arguments: atlassianInput.arguments
          });

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
    toolName === "jira.listAssignedIssues" ||
    toolName === "jira.searchIssues" ||
    toolName === "atlassian.listMcpTools" ||
    toolName === "atlassian.callMcpTool"
  );
}

function readToolProvider(toolName: string): "github" | "jira" {
  return toolName.startsWith("jira.") || toolName.startsWith("atlassian.")
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
