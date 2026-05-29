import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentRuntimeRecord, ProviderConnection, TokenStore } from "../db";
import { jiraProviderToolSpecs } from "../providers/jira/tool-specs";
import { providerToolInputSchema } from "../providers/tool-specs";
import { createJiraTools } from "../tools/jira";
import type { ToolResult } from "../tools/types";
import { mcpToolResult, type ProviderMcpDeps, withConnection } from "./provider-context";
import {
  isProviderMcpToolEnabled,
  type ProviderMcpToolPolicy
} from "./provider-policy";

type JiraTools = ReturnType<typeof createJiraTools>;
type JiraToolArgs = Record<string, unknown>;
type JiraMcpHandler = (
  connection: ProviderConnection,
  args: JiraToolArgs
) => Promise<ToolResult<unknown>>;

export function registerJiraMcpTools(input: {
  server: McpServer;
  store: TokenStore;
  runtime: AgentRuntimeRecord;
  deps: Parameters<typeof createJiraTools>[0] & ProviderMcpDeps;
  policy?: ProviderMcpToolPolicy;
}): void {
  const jiraTools = createJiraTools(input.deps);
  const handlers = createJiraMcpHandlers(jiraTools);

  for (const spec of jiraProviderToolSpecs) {
    if (!isProviderMcpToolEnabled(input.policy, spec.name)) {
      continue;
    }
    const handler = handlers[spec.implementation];
    if (!handler) {
      throw new Error(`Missing Jira MCP handler for ${spec.implementation}`);
    }

    input.server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: providerToolInputSchema(spec)
      },
      async (args) =>
        mcpToolResult(
          await withConnection(input.store, input.runtime, "jira", (connection) =>
            handler(connection, args as JiraToolArgs)
          )
        )
    );
  }
}

function createJiraMcpHandlers(jiraTools: JiraTools): Record<string, JiraMcpHandler> {
  return {
    getAuthenticatedUser: (connection) =>
      jiraTools.getAuthenticatedUser.execute({ connection }),

    listAssignedIssues: (connection) =>
      jiraTools.listAssignedIssues.execute({ connection }),

    listAccessibleResources: (connection) =>
      jiraTools.listAccessibleResources.execute({ connection }),

    listVisibleProjects: (connection, args) =>
      jiraTools.listVisibleProjects.execute({
        connection,
        input: {
          ...optionalStringField(args, "query"),
          ...optionalStringField<"view" | "browse" | "edit" | "create">(args, "action"),
          ...optionalBooleanField(args, "expandIssueTypes")
        }
      }),

    searchUsers: (connection, args) =>
      jiraTools.searchUsers.execute({
        connection,
        input: { query: stringArg(args, "query") }
      }),

    createIssue: (connection, args) =>
      jiraTools.createIssue.execute({
        connection,
        input: {
          projectKey: stringArg(args, "projectKey"),
          ...optionalTruthyStringField(args, "issueTypeName"),
          ...optionalTruthyStringField(args, "issueTypeId"),
          summary: stringArg(args, "summary"),
          ...optionalTruthyStringField(args, "description"),
          ...optionalTruthyStringField(args, "assigneeAccountId")
        }
      }),

    editIssue: (connection, args) =>
      jiraTools.editIssue.execute({
        connection,
        input: {
          issueKey: stringArg(args, "issueKey"),
          ...optionalTruthyStringField(args, "summary"),
          ...optionalStringField(args, "description"),
          ...optionalNullableStringField(args, "assigneeAccountId")
        }
      }),

    getIssue: (connection, args) =>
      jiraTools.getIssue.execute({
        connection,
        input: { issueKey: stringArg(args, "issueKey") }
      }),

    updateIssue: (connection, args) =>
      jiraTools.updateIssue.execute({
        connection,
        input: {
          issueKey: stringArg(args, "issueKey"),
          ...optionalStringField(args, "summary"),
          ...optionalStringField(args, "description"),
          ...optionalNullableStringField(args, "assigneeAccountId"),
          ...optionalStringArrayField(args, "labels")
        }
      }),

    addComment: (connection, args) =>
      jiraTools.addComment.execute({
        connection,
        input: {
          issueKey: stringArg(args, "issueKey"),
          body: stringArg(args, "body")
        }
      }),

    transitionIssue: (connection, args) =>
      jiraTools.transitionIssue.execute({
        connection,
        input: {
          issueKey: stringArg(args, "issueKey"),
          ...optionalTruthyStringField(args, "transitionId"),
          ...optionalTruthyStringField(args, "transitionName")
        }
      }),

    addLabels: (connection, args) =>
      jiraTools.addLabels.execute({
        connection,
        input: {
          issueKey: stringArg(args, "issueKey"),
          labels: stringArrayArg(args, "labels")
        }
      }),

    removeLabels: (connection, args) =>
      jiraTools.removeLabels.execute({
        connection,
        input: {
          issueKey: stringArg(args, "issueKey"),
          labels: stringArrayArg(args, "labels")
        }
      }),

    linkIssues: (connection, args) =>
      jiraTools.linkIssues.execute({
        connection,
        input: {
          inwardIssueKey: stringArg(args, "inwardIssueKey"),
          outwardIssueKey: stringArg(args, "outwardIssueKey"),
          ...optionalTruthyStringField(args, "typeName"),
          ...optionalStringField(args, "comment")
        }
      }),

    createSubtask: (connection, args) =>
      jiraTools.createSubtask.execute({
        connection,
        input: {
          parentIssueKey: stringArg(args, "parentIssueKey"),
          summary: stringArg(args, "summary"),
          ...optionalTruthyStringField(args, "projectKey"),
          ...optionalTruthyStringField(args, "issueTypeName"),
          ...optionalTruthyStringField(args, "issueTypeId"),
          ...optionalStringField(args, "description"),
          ...optionalTruthyStringField(args, "assigneeAccountId")
        }
      }),

    searchIssues: (connection, args) =>
      jiraTools.searchIssues.execute({
        connection,
        input: { jql: stringArg(args, "jql") }
      })
  };
}

function stringArg(args: JiraToolArgs, key: string): string {
  return args[key] as string;
}

function stringArrayArg(args: JiraToolArgs, key: string): string[] {
  return args[key] as string[];
}

function optionalStringField<T extends string = string>(
  args: JiraToolArgs,
  key: string
): Partial<Record<string, T>> {
  return args[key] !== undefined ? { [key]: args[key] as T } : {};
}

function optionalTruthyStringField<T extends string = string>(
  args: JiraToolArgs,
  key: string
): Partial<Record<string, T>> {
  return args[key] ? { [key]: args[key] as T } : {};
}

function optionalNullableStringField(
  args: JiraToolArgs,
  key: string
): Partial<Record<string, string | null>> {
  return args[key] !== undefined ? { [key]: args[key] as string | null } : {};
}

function optionalBooleanField(
  args: JiraToolArgs,
  key: string
): Partial<Record<string, boolean>> {
  return args[key] !== undefined ? { [key]: args[key] as boolean } : {};
}

function optionalStringArrayField(
  args: JiraToolArgs,
  key: string
): Partial<Record<string, string[]>> {
  return args[key] !== undefined ? { [key]: args[key] as string[] } : {};
}
