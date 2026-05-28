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
    "jira_get_issue",
    {
      title: "Jira get issue",
      description: "Get a Jira issue by key, including summary, status, labels, and text description.",
      inputSchema: {
        issueKey: z.string().min(1).describe("Jira issue key")
      }
    },
    async ({ issueKey }) =>
      mcpToolResult(
        await withConnection(input.store, input.runtime, "jira", (connection) =>
          jiraTools.getIssue.execute({
            connection,
            input: { issueKey }
          })
        )
      )
  );

  input.server.registerTool(
    "jira_update_issue",
    {
      title: "Jira update issue",
      description:
        "Update Jira issue fields: summary, description, assignee, or full labels set.",
      inputSchema: {
        issueKey: z.string().min(1).describe("Jira issue key"),
        summary: z.string().min(1).optional(),
        description: z.string().optional(),
        assigneeAccountId: z
          .string()
          .nullable()
          .optional()
          .describe("Jira account ID for assignee, or null to unassign"),
        labels: z.array(z.string().min(1)).max(50).optional()
      }
    },
    async ({ issueKey, summary, description, assigneeAccountId, labels }) =>
      mcpToolResult(
        await withConnection(input.store, input.runtime, "jira", (connection) =>
          jiraTools.updateIssue.execute({
            connection,
            input: {
              issueKey,
              ...(summary !== undefined ? { summary } : {}),
              ...(description !== undefined ? { description } : {}),
              ...(assigneeAccountId !== undefined ? { assigneeAccountId } : {}),
              ...(labels !== undefined ? { labels } : {})
            }
          })
        )
      )
  );

  input.server.registerTool(
    "jira_add_comment",
    {
      title: "Jira add comment",
      description: "Add a plain-text comment to a Jira issue.",
      inputSchema: {
        issueKey: z.string().min(1).describe("Jira issue key"),
        body: z.string().min(1).max(65_536).describe("Comment body")
      }
    },
    async ({ issueKey, body }) =>
      mcpToolResult(
        await withConnection(input.store, input.runtime, "jira", (connection) =>
          jiraTools.addComment.execute({
            connection,
            input: { issueKey, body }
          })
        )
      )
  );

  input.server.registerTool(
    "jira_transition_issue",
    {
      title: "Jira transition issue",
      description:
        "Transition a Jira issue by transition id or by matching available transition name.",
      inputSchema: {
        issueKey: z.string().min(1).describe("Jira issue key"),
        transitionId: z.string().min(1).optional(),
        transitionName: z.string().min(1).optional()
      }
    },
    async ({ issueKey, transitionId, transitionName }) =>
      mcpToolResult(
        await withConnection(input.store, input.runtime, "jira", (connection) =>
          jiraTools.transitionIssue.execute({
            connection,
            input: {
              issueKey,
              ...(transitionId ? { transitionId } : {}),
              ...(transitionName ? { transitionName } : {})
            }
          })
        )
      )
  );

  input.server.registerTool(
    "jira_add_labels",
    {
      title: "Jira add labels",
      description: "Add labels to a Jira issue.",
      inputSchema: {
        issueKey: z.string().min(1).describe("Jira issue key"),
        labels: z.array(z.string().min(1)).min(1).max(50)
      }
    },
    async ({ issueKey, labels }) =>
      mcpToolResult(
        await withConnection(input.store, input.runtime, "jira", (connection) =>
          jiraTools.addLabels.execute({
            connection,
            input: { issueKey, labels }
          })
        )
      )
  );

  input.server.registerTool(
    "jira_remove_labels",
    {
      title: "Jira remove labels",
      description: "Remove labels from a Jira issue.",
      inputSchema: {
        issueKey: z.string().min(1).describe("Jira issue key"),
        labels: z.array(z.string().min(1)).min(1).max(50)
      }
    },
    async ({ issueKey, labels }) =>
      mcpToolResult(
        await withConnection(input.store, input.runtime, "jira", (connection) =>
          jiraTools.removeLabels.execute({
            connection,
            input: { issueKey, labels }
          })
        )
      )
  );

  input.server.registerTool(
    "jira_link_issues",
    {
      title: "Jira link issues",
      description: "Create a Jira issue link between two issues.",
      inputSchema: {
        inwardIssueKey: z.string().min(1).describe("Inward Jira issue key"),
        outwardIssueKey: z.string().min(1).describe("Outward Jira issue key"),
        typeName: z
          .string()
          .min(1)
          .optional()
          .describe("Jira issue link type name. Defaults to Relates."),
        comment: z.string().max(65_536).optional()
      }
    },
    async ({ inwardIssueKey, outwardIssueKey, typeName, comment }) =>
      mcpToolResult(
        await withConnection(input.store, input.runtime, "jira", (connection) =>
          jiraTools.linkIssues.execute({
            connection,
            input: {
              inwardIssueKey,
              outwardIssueKey,
              ...(typeName ? { typeName } : {}),
              ...(comment !== undefined ? { comment } : {})
            }
          })
        )
      )
  );

  input.server.registerTool(
    "jira_create_subtask",
    {
      title: "Jira create subtask",
      description:
        "Create a Jira subtask under an existing parent issue. Confirm the subtask issue type first when possible.",
      inputSchema: {
        parentIssueKey: z.string().min(1).describe("Parent Jira issue key"),
        summary: z.string().min(1).describe("Subtask summary"),
        projectKey: z.string().min(1).optional().describe("Optional Jira project key"),
        issueTypeName: z.string().min(1).optional().describe("Subtask issue type name"),
        issueTypeId: z.string().min(1).optional().describe("Subtask issue type ID"),
        description: z.string().optional().describe("Plain text subtask description"),
        assigneeAccountId: z.string().optional().describe("Optional Jira assignee account ID")
      }
    },
    async ({
      parentIssueKey,
      summary,
      projectKey,
      issueTypeName,
      issueTypeId,
      description,
      assigneeAccountId
    }) =>
      mcpToolResult(
        await withConnection(input.store, input.runtime, "jira", (connection) =>
          jiraTools.createSubtask.execute({
            connection,
            input: {
              parentIssueKey,
              summary,
              ...(projectKey ? { projectKey } : {}),
              ...(issueTypeName ? { issueTypeName } : {}),
              ...(issueTypeId ? { issueTypeId } : {}),
              ...(description !== undefined ? { description } : {}),
              ...(assigneeAccountId ? { assigneeAccountId } : {})
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
