import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { AgentRuntimeRecord, TokenStore } from "../db";
import type { JiraToolDeps } from "../tools/jira";
import { createJiraTools } from "../tools/jira";
import { mcpToolResult, type ProviderMcpDeps, withConnection } from "./provider-context";

export function registerJiraMcpTools(input: {
  server: McpServer;
  store: TokenStore;
  runtime: AgentRuntimeRecord;
  deps: JiraToolDeps & ProviderMcpDeps;
}): void {
  const jiraTools = createJiraTools(input.deps);

  input.server.registerTool(
    "jira_get_authenticated_user",
    {
      title: "Jira authenticated user",
      description: "Return the Jira identity connected to this Slack user.",
      inputSchema: {}
    },
    async () =>
      mcpToolResult(
        await withConnection(input.store, input.runtime, "jira", (connection) =>
          jiraTools.getAuthenticatedUser.execute({ connection })
        )
      )
  );

  input.server.registerTool(
    "jira_list_assigned_issues",
    {
      title: "Jira assigned issues",
      description: "List Jira issues assigned to this Slack user.",
      inputSchema: {}
    },
    async () =>
      mcpToolResult(
        await withConnection(input.store, input.runtime, "jira", (connection) =>
          jiraTools.listAssignedIssues.execute({ connection })
        )
      )
  );

  input.server.registerTool(
    "jira_list_accessible_resources",
    {
      title: "Jira accessible resources",
      description:
        "List Atlassian resources visible to this Slack user's connected Jira account. Use the resource url as Jira MCP cloudId for the Atlassian Rovo MCP server.",
      inputSchema: {}
    },
    async () =>
      mcpToolResult(
        await withConnection(input.store, input.runtime, "jira", (connection) =>
          jiraTools.listAccessibleResources.execute({ connection })
        )
      )
  );

  input.server.registerTool(
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
        await withConnection(input.store, input.runtime, "jira", (connection) =>
          jiraTools.listVisibleProjects.execute({
            connection,
            input: { query, action, expandIssueTypes }
          })
        )
      )
  );

  input.server.registerTool(
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
        await withConnection(input.store, input.runtime, "jira", (connection) =>
          jiraTools.searchUsers.execute({
            connection,
            input: { query }
          })
        )
      )
  );

  input.server.registerTool(
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
        await withConnection(input.store, input.runtime, "jira", (connection) =>
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

  input.server.registerTool(
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
        await withConnection(input.store, input.runtime, "jira", (connection) =>
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

  input.server.registerTool(
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
        await withConnection(input.store, input.runtime, "jira", (connection) =>
          jiraTools.searchIssues.execute({
            connection,
            input: { jql }
          })
        )
      )
  );
}
