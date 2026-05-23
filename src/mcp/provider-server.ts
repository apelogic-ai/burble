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
  getJiraUser,
  listAssignedJiraIssues,
  refreshJiraAccessToken,
  searchJiraIssues
} from "../jira";
import {
  listUpstreamMcpTools,
  type UpstreamMcpTool
} from "./upstream-http-client";
import { createGitHubTools, type GitHubToolDeps } from "../tools/github";
import {
  createJiraTools,
  isJiraAuthErrorResult,
  type JiraToolDeps,
  withFreshJiraToken
} from "../tools/jira";
import type { ToolResult } from "../tools/types";
import type { RuntimeJwtIssuer } from "../runtime-jwt";

type ProviderMcpDeps = Partial<GitHubToolDeps> &
  Partial<JiraToolDeps> & {
    listAtlassianMcpTools?: (input: {
      url: string;
      accessToken: string;
    }) => Promise<UpstreamMcpTool[]>;
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

export async function handleProviderMcpRequest(
  config: Config,
  store: TokenStore,
  runtimeJwtIssuer: RuntimeJwtIssuer,
  request: Request,
  deps: ProviderMcpDeps = {}
): Promise<Response> {
  const runtime = authorizeProviderMcpRequest(
    config,
    store,
    runtimeJwtIssuer,
    request
  );
  if (!runtime) {
    return new Response("Unauthorized", { status: 401 });
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
    "atlassian_list_mcp_tools",
    {
      title: "Atlassian MCP tools",
      description:
        "List read-only tool metadata advertised by the upstream Atlassian MCP server for this Slack user's connected Jira account.",
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
            content: tools.slice(0, 50).map((tool) => ({
              name: tool.name,
              ...(tool.title ? { title: tool.title } : {}),
              ...(tool.description ? { description: tool.description } : {})
            }))
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

function authorizeProviderMcpRequest(
  config: Config,
  store: TokenStore,
  runtimeJwtIssuer: RuntimeJwtIssuer,
  request: Request
): AgentRuntimeRecord | null {
  const bearerToken = readBearerToken(request);
  if (!bearerToken) {
    return null;
  }

  const claims = runtimeJwtIssuer.verifyRuntimeJwt({
    token: bearerToken,
    audience:
      config.agentRuntimeMcpAudience ??
      config.agentRuntimeMcpGatewayUrl ??
      `${config.runtimeJwtIssuer}/mcp`
  });
  if (!claims) {
    return null;
  }

  const runtime = store.getAgentRuntime(claims.runtime_id);
  if (
    !runtime ||
    runtime.workspaceId !== claims.workspace_id ||
    runtime.slackUserId !== claims.slack_user_id
  ) {
    return null;
  }

  return runtime;
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
            : "Connect Jira first."
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
