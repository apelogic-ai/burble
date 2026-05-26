import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import * as z from "zod/v4";
import type { Config } from "../config";
import type { AgentRuntimeRecord, Provider, TokenStore } from "../db";
import {
  getGitHubUser,
  listAssignedIssues,
  listMyPullRequests,
  searchIssues
} from "../github";
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
import {
  callUpstreamMcpTool,
  listUpstreamMcpTools,
  type UpstreamMcpTool,
  type UpstreamMcpToolResult
} from "./upstream-http-client";
import { createGitHubTools, type GitHubToolDeps } from "../tools/github";
import { searchSlackMessages, searchSlackUsers } from "../slack-api";
import {
  createJiraTools,
  isJiraAuthErrorResult,
  type JiraToolDeps,
  withFreshJiraToken
} from "../tools/jira";
import { createSlackTools, type SlackToolDeps } from "../tools/slack";
import type { ToolResult } from "../tools/types";
import type { RuntimeJwtIssuer } from "../runtime-jwt";
import {
  logAtlassianMcpCallFailure,
  logAtlassianMcpCallFinish,
  logAtlassianMcpCallStart
} from "./atlassian-logging";
import { verifyJiraAuthForOpaqueAtlassianMcpError } from "./atlassian-auth";

type ProviderMcpDeps = Partial<GitHubToolDeps> &
  Partial<JiraToolDeps> &
  Partial<SlackToolDeps> & {
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

export async function handleProviderMcpRequest(
  config: Config,
  store: TokenStore,
  runtimeJwtIssuer: RuntimeJwtIssuer,
  request: Request,
  deps: ProviderMcpDeps = {}
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

  const server = createProviderMcpServer(config, store, runtime, deps);
  const transport = new WebStandardStreamableHTTPServerTransport();

  await server.connect(transport);
  return transport.handleRequest(request);
}

function createProviderMcpServer(
  config: Config,
  store: TokenStore,
  runtime: AgentRuntimeRecord,
  deps: ProviderMcpDeps
): McpServer {
  const server = new McpServer({
    name: "burble-provider-tools",
    version: "0.1.0"
  });
  const githubTools = createGitHubTools({ ...defaultDeps, ...deps });
  const jiraTools = createJiraTools({
    ...defaultDeps,
    refreshJiraAccessToken: (refreshToken) =>
      refreshJiraAccessToken(config, refreshToken),
    saveJiraConnection: (connection) => store.upsertProviderConnection(connection),
    ...deps
  });
  const slackTools = createSlackTools({ ...defaultDeps, ...deps });

  server.registerTool(
    "github_get_authenticated_user",
    {
      title: "GitHub authenticated user",
      description: "Return the GitHub identity connected to this Slack user.",
      inputSchema: {}
    },
    async () =>
      mcpToolResult(
        await withConnection(store, runtime, "github", (connection) =>
          githubTools.getAuthenticatedUser.execute({ connection })
        )
      )
  );

  server.registerTool(
    "github_list_assigned_issues",
    {
      title: "GitHub assigned issues",
      description: "List GitHub issues assigned to this Slack user.",
      inputSchema: {}
    },
    async () =>
      mcpToolResult(
        await withConnection(store, runtime, "github", (connection) =>
          githubTools.listAssignedIssues.execute({ connection })
        )
      )
  );

  server.registerTool(
    "github_search_issues",
    {
      title: "GitHub issue search",
      description:
        "Search GitHub issues and pull requests visible to this Slack user's connected GitHub account.",
      inputSchema: {
        query: z.string().min(1).describe("GitHub search query")
      }
    },
    async ({ query }) =>
      mcpToolResult(
        await withConnection(store, runtime, "github", (connection) =>
          githubTools.searchIssues.execute({
            connection,
            input: { query }
          })
        )
      )
  );

  server.registerTool(
    "github_list_my_pull_requests",
    {
      title: "GitHub open pull requests",
      description:
        "List open GitHub pull requests authored by this Slack user's connected GitHub account.",
      inputSchema: {}
    },
    async () =>
      mcpToolResult(
        await withConnection(store, runtime, "github", (connection) =>
          githubTools.listMyPullRequests.execute({ connection })
        )
      )
  );

  server.registerTool(
    "jira_get_authenticated_user",
    {
      title: "Jira authenticated user",
      description: "Return the Jira identity connected to this Slack user.",
      inputSchema: {}
    },
    async () =>
      mcpToolResult(
        await withConnection(store, runtime, "jira", (connection) =>
          jiraTools.getAuthenticatedUser.execute({ connection })
        )
      )
  );

  server.registerTool(
    "jira_list_assigned_issues",
    {
      title: "Jira assigned issues",
      description: "List Jira issues assigned to this Slack user.",
      inputSchema: {}
    },
    async () =>
      mcpToolResult(
        await withConnection(store, runtime, "jira", (connection) =>
          jiraTools.listAssignedIssues.execute({ connection })
        )
      )
  );

  server.registerTool(
    "jira_list_accessible_resources",
    {
      title: "Jira accessible resources",
      description:
        "List Atlassian resources visible to this Slack user's connected Jira account. Use the resource url as Jira MCP cloudId for the Atlassian Rovo MCP server.",
      inputSchema: {}
    },
    async () =>
      mcpToolResult(
        await withConnection(store, runtime, "jira", (connection) =>
          jiraTools.listAccessibleResources.execute({ connection })
        )
      )
  );

  server.registerTool(
    "jira_list_visible_projects",
    {
      title: "Jira visible projects",
      description:
        "List Jira projects visible to this Slack user's connected Jira account. Use query='DM', action='create', and expandIssueTypes=true to confirm create access and issue types before creating a Jira issue.",
      inputSchema: {
        query: z.string().optional().describe("Optional project key or name search"),
        action: z
          .enum(["view", "browse", "edit", "create"])
          .optional()
          .describe("Optional Jira project action permission filter"),
        expandIssueTypes: z
          .boolean()
          .optional()
          .describe("Whether to include project issue types")
      }
    },
    async ({ query, action, expandIssueTypes }) =>
      mcpToolResult(
        await withConnection(store, runtime, "jira", (connection) =>
          jiraTools.listVisibleProjects.execute({
            connection,
            input: { query, action, expandIssueTypes }
          })
        )
      )
  );

  server.registerTool(
    "jira_search_users",
    {
      title: "Jira user search",
      description:
        "Search Jira users visible to this Slack user's connected Jira account. Use this to resolve assignee account IDs from emails or names.",
      inputSchema: {
        query: z.string().min(1).describe("Jira user email, display name, or query")
      }
    },
    async ({ query }) =>
      mcpToolResult(
        await withConnection(store, runtime, "jira", (connection) =>
          jiraTools.searchUsers.execute({
            connection,
            input: { query }
          })
        )
      )
  );

  server.registerTool(
    "jira_create_issue",
    {
      title: "Jira create issue",
      description:
        "Create a Jira issue via Jira REST with this Slack user's connected Jira account. Use after confirming project and issue type.",
      inputSchema: {
        projectKey: z.string().min(1).describe("Jira project key"),
        issueTypeName: z.string().optional().describe("Jira issue type name"),
        issueTypeId: z.string().optional().describe("Jira issue type ID"),
        summary: z.string().min(1).describe("Issue summary"),
        description: z.string().optional().describe("Plain text issue description"),
        assigneeAccountId: z
          .string()
          .optional()
          .describe("Optional Jira account ID for the assignee")
      }
    },
    async ({
      projectKey,
      issueTypeName,
      issueTypeId,
      summary,
      description,
      assigneeAccountId
    }) =>
      mcpToolResult(
        await withConnection(store, runtime, "jira", (connection) =>
          jiraTools.createIssue.execute({
            connection,
            input: {
              projectKey,
              ...(issueTypeName ? { issueTypeName } : {}),
              ...(issueTypeId ? { issueTypeId } : {}),
              summary,
              ...(description ? { description } : {}),
              ...(assigneeAccountId ? { assigneeAccountId } : {})
            }
          })
        )
      )
  );

  server.registerTool(
    "jira_edit_issue",
    {
      title: "Jira edit issue",
      description:
        "Edit Jira issue fields via Jira REST with this Slack user's connected Jira account.",
      inputSchema: {
        issueKey: z.string().min(1).describe("Jira issue key"),
        summary: z.string().optional().describe("New issue summary"),
        description: z.string().optional().describe("New plain text description"),
        assigneeAccountId: z
          .string()
          .nullable()
          .optional()
          .describe("Jira account ID for assignee, or null to unassign")
      }
    },
    async ({ issueKey, summary, description, assigneeAccountId }) =>
      mcpToolResult(
        await withConnection(store, runtime, "jira", (connection) =>
          jiraTools.editIssue.execute({
            connection,
            input: {
              issueKey,
              ...(summary ? { summary } : {}),
              ...(description !== undefined ? { description } : {}),
              ...(assigneeAccountId !== undefined ? { assigneeAccountId } : {})
            }
          })
        )
      )
  );

  server.registerTool(
    "jira_search_issues",
    {
      title: "Jira issue search",
      description:
        "Search Jira issues visible to this Slack user's connected Jira account.",
      inputSchema: {
        jql: z.string().min(1).describe("Jira JQL query")
      }
    },
    async ({ jql }) =>
      mcpToolResult(
        await withConnection(store, runtime, "jira", (connection) =>
          jiraTools.searchIssues.execute({
            connection,
            input: { jql }
          })
        )
      )
  );

  server.registerTool(
    "slack_search_users",
    {
      title: "Slack user search",
      description:
        "Search Slack users by display name, real name, username, or Slack user ID.",
      inputSchema: {
        query: z.string().min(1).describe("Slack user name, display name, or ID")
      }
    },
    async ({ query }) =>
      mcpToolResult(
        await withConnection(store, runtime, "slack", (connection) =>
          slackTools.searchUsers.execute({
            connection,
            input: { query }
          })
        )
      )
  );

  server.registerTool(
    "slack_search_messages",
    {
      title: "Slack message search",
      description:
        "Search Slack messages visible to this Slack user's connected Slack search token.",
      inputSchema: {
        query: z.string().min(1).describe("Slack search terms"),
        fromUserId: z
          .string()
          .optional()
          .describe("Optional Slack user ID to filter by author"),
        inChannel: z
          .string()
          .optional()
          .describe("Optional channel name without #, or channel ID"),
        limit: z.number().int().positive().max(20).optional()
      }
    },
    async ({ query, fromUserId, inChannel, limit }) =>
      mcpToolResult(
        await withConnection(store, runtime, "slack", (connection) =>
          slackTools.searchMessages.execute({
            connection,
            input: {
              query,
              ...(fromUserId ? { fromUserId } : {}),
              ...(inChannel ? { inChannel } : {}),
              ...(limit ? { limit } : {})
            }
          })
        )
      )
  );

  server.registerTool(
    "atlassian_list_mcp_tools",
    {
      title: "Atlassian MCP tools",
      description:
        "List allowed tool metadata advertised by the upstream Atlassian MCP server for this Slack user's connected Jira account.",
      inputSchema: {}
    },
    async () =>
      mcpToolResult(
        await withConnection<
          | Array<{ name: string; title?: string; description?: string }>
          | { error: string; message: string }
        >(store, runtime, "jira", async (connection) => {
          const tools = await withFreshJiraToken(
            {
              ...defaultDeps,
              refreshJiraAccessToken: (refreshToken) =>
                refreshJiraAccessToken(config, refreshToken),
              saveJiraConnection: (updatedConnection) =>
                store.upsertProviderConnection(updatedConnection),
              ...deps
            },
            connection,
            (accessToken) =>
              (deps.listAtlassianMcpTools ?? defaultListAtlassianMcpTools)({
                url: config.atlassianMcpUrl,
                accessToken
              })
          );
          if (isJiraAuthErrorResult(tools)) {
            return tools;
          }

          return {
            classification: "user_private",
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
        })
      )
  );

  server.registerTool(
    "atlassian_call_mcp_tool",
    {
      title: "Atlassian MCP allowed tool call",
      description:
        "Call an allowlisted upstream Atlassian MCP tool with this Slack user's connected Jira identity.",
      inputSchema: {
        name: z.string().min(1).describe("Upstream Atlassian MCP tool name"),
        arguments: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("JSON arguments for the upstream MCP tool")
      }
    },
    async ({ name, arguments: args }) =>
      mcpToolResult(
        await withConnection<
          | { toolName: string; result: UpstreamMcpToolResult }
          | { error: string; message: string }
        >(store, runtime, "jira", async (connection) => {
          if (!isAllowedAtlassianMcpToolName(name)) {
            return {
              classification: "user_private",
              content: {
                error: "atlassian_mcp_tool_not_allowed",
                message: `Atlassian MCP tool \`${name}\` is not enabled for use.`
              }
            };
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
              logAtlassianMcpCallStart("mcp", runtime.id, name, args);
              try {
                const upstreamResult = await (deps.callAtlassianMcpTool ??
                  defaultCallAtlassianMcpTool)({
                  url: config.atlassianMcpUrl,
                  accessToken,
                  name,
                  arguments: args
                });
                logAtlassianMcpCallFinish("mcp", runtime.id, name, upstreamResult);
                await verifyJiraAuthForOpaqueAtlassianMcpError(
                  upstreamResult,
                  accessToken,
                  { getJiraUser: deps.getJiraUser ?? defaultDeps.getJiraUser }
                );
                return upstreamResult;
              } catch (error) {
                logAtlassianMcpCallFailure("mcp", runtime.id, name, error);
                throw error;
              }
            }
          );
          if (isJiraAuthErrorResult(result)) {
            return result;
          }

          return {
            classification: "user_private",
            content: {
              toolName: name,
              result: sanitizeUpstreamMcpToolResult(result)
            }
          };
        })
      )
  );

  return server;
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

export function isAllowedAtlassianMcpToolName(name: string): boolean {
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

export const isReadOnlyAtlassianMcpToolName = isAllowedAtlassianMcpToolName;

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

async function withConnection<TContent>(
  store: TokenStore,
  runtime: AgentRuntimeRecord,
  provider: Provider,
  callback: (
    connection: NonNullable<ReturnType<TokenStore["getConnectionForSlackUser"]>>
  ) => Promise<ToolResult<TContent>>
): Promise<ToolResult<TContent | { error: string; message: string }>> {
  const connection = store.getConnectionForSlackUser(provider, runtime.slackUserId);
  if (!connection) {
    return {
      classification: "user_private",
      content: {
        error: `${provider}_not_connected`,
        message:
          provider === "github"
            ? "Connect GitHub first."
            : provider === "jira"
              ? "Connect Jira first."
              : "Connect Slack search first: `/auth slack`."
      }
    };
  }

  return callback(connection);
}

function mcpToolResult(result: ToolResult<unknown>) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(result)
      }
    ]
  };
}
