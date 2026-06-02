import { describe, expect, test } from "bun:test";
import {
  allowedMutatingAtlassianMcpTools,
  atlassianProviderToolSpecs
} from "../../src/providers/atlassian/tool-specs";
import { githubProviderToolSpecs } from "../../src/providers/github/tool-specs";
import { googleProviderToolSpecs } from "../../src/providers/google/tool-specs";
import { jiraProviderToolSpecs } from "../../src/providers/jira/tool-specs";
import { slackProviderToolSpecs } from "../../src/providers/slack/tool-specs";
import { providerToolInputSchema } from "../../src/providers/tool-specs";

describe("provider tool specs", () => {
  test("loads GitHub MCP tool metadata from YAML", () => {
    const names = githubProviderToolSpecs.map((tool) => tool.name);

    expect(names).toContain("github_list_my_pull_requests");
    expect(names).toContain("github_create_issue");
    expect(names).toContain("github_request_review");
    expect(
      githubProviderToolSpecs.every(
        (tool) =>
          tool.provider === "github" &&
          tool.alias.startsWith("github.") &&
          tool.implementation.length > 0
      )
    ).toBe(true);
  });

  test("converts YAML inputs to validating Zod schemas", () => {
    const createIssue = githubProviderToolSpecs.find(
      (tool) => tool.name === "github_create_issue"
    );
    expect(createIssue).toBeDefined();
    expect(createIssue?.risk).toBe("low_write");
    expect(createIssue?.confirmation).toBe("none");

    const schema = providerToolInputSchema(createIssue!);

    expect(schema.repo.safeParse("acme/app").success).toBe(true);
    expect(schema.title.safeParse("").success).toBe(false);
    expect(schema.labels.safeParse(["bug"]).success).toBe(true);
    expect(schema.labels.safeParse(Array.from({ length: 21 }, () => "bug")).success).toBe(
      false
    );
  });

  test("loads Google MCP tool metadata from YAML", () => {
    const names = googleProviderToolSpecs.map((tool) => tool.name);

    expect(names).toContain("google_search_drive_files");
    expect(names).toContain("google_create_calendar_event");
    expect(names).toContain("gmail_create_draft");
    expect(
      googleProviderToolSpecs.find(
        (tool) => tool.name === "google_append_to_drive_text_file"
      )?.aliases
    ).toContain("google.appendToDriveTextFile");
    expect(
      googleProviderToolSpecs.every(
        (tool) =>
          tool.provider === "google" &&
          (tool.alias.startsWith("google.") || tool.alias.startsWith("gmail.")) &&
          tool.implementation.length > 0
      )
    ).toBe(true);
  });

  test("validates email array item formats from YAML", () => {
    const createDraft = googleProviderToolSpecs.find(
      (tool) => tool.name === "gmail_create_draft"
    );
    expect(createDraft).toBeDefined();
    expect(createDraft?.risk).toBe("low_write");

    const schema = providerToolInputSchema(createDraft!);

    expect(schema.to.safeParse(["person@example.com"]).success).toBe(true);
    expect(schema.to.safeParse(["not-an-email"]).success).toBe(false);
  });

  test("loads Jira MCP tool metadata from YAML", () => {
    const names = jiraProviderToolSpecs.map((tool) => tool.name);

    expect(names).toContain("jira_search_issues");
    expect(names).toContain("jira_create_issue");
    expect(names).toContain("jira_add_comment");
    expect(
      jiraProviderToolSpecs.every(
        (tool) =>
          tool.provider === "jira" &&
          tool.alias.startsWith("jira.") &&
          tool.implementation.length > 0
      )
    ).toBe(true);
  });

  test("validates nullable Jira fields from YAML", () => {
    const editIssue = jiraProviderToolSpecs.find(
      (tool) => tool.name === "jira_edit_issue"
    );
    expect(editIssue).toBeDefined();
    expect(editIssue?.risk).toBe("moderate_write");

    const schema = providerToolInputSchema(editIssue!);

    expect(schema.assigneeAccountId.safeParse("acct-123").success).toBe(true);
    expect(schema.assigneeAccountId.safeParse(null).success).toBe(true);
  });

  test("loads Slack MCP tool metadata from YAML", () => {
    const names = slackProviderToolSpecs.map((tool) => tool.name);

    expect(names).toContain("slack_search_users");
    expect(names).toContain("slack_search_messages");
    expect(
      slackProviderToolSpecs.every(
        (tool) =>
          tool.provider === "slack" &&
          tool.alias.startsWith("slack.") &&
          tool.implementation.length > 0
      )
    ).toBe(true);
  });

  test("loads Atlassian facade metadata and policy from YAML", () => {
    const names = atlassianProviderToolSpecs.map((tool) => tool.name);

    expect(names).toEqual([
      "atlassian_list_mcp_tools",
      "atlassian_call_mcp_tool"
    ]);
    expect(allowedMutatingAtlassianMcpTools.has("createjiraissue")).toBe(true);
  });

  test("validates object inputs from YAML", () => {
    const callTool = atlassianProviderToolSpecs.find(
      (tool) => tool.name === "atlassian_call_mcp_tool"
    );
    expect(callTool).toBeDefined();

    const schema = providerToolInputSchema(callTool!);

    expect(schema.arguments.safeParse({ jql: "assignee = currentUser()" }).success).toBe(
      true
    );
    expect(schema.arguments.safeParse("not-json-object").success).toBe(false);
  });
});
