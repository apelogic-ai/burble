import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  allowedMutatingAtlassianMcpTools,
  atlassianProviderToolSpecs
} from "../../src/providers/atlassian/tool-specs";
import { githubProviderToolSpecs } from "../../src/providers/github/tool-specs";
import { googleProviderToolSpecs } from "../../src/providers/google/tool-specs";
import { hubspotProviderToolSpecs } from "../../src/providers/hubspot/tool-specs";
import { jiraProviderToolSpecs } from "../../src/providers/jira/tool-specs";
import { slackProviderToolSpecs } from "../../src/providers/slack/tool-specs";
import { providerToolCatalog } from "../../src/providers/catalog";
import { buildRuntimeProviderToolHints } from "../../src/providers/runtime-tool-hints";
import { providerToolInputSchema } from "../../src/providers/tool-specs";

type HermesProviderToolHints = {
  providers: Array<{
    provider: string;
    tools: Array<{
      name: string;
      alias: string;
      description: string;
      input: Record<string, unknown>;
    }>;
  }>;
};

describe("provider tool specs", () => {
  test("does not give dynamic MCP bridges provider-wide execution coverage", () => {
    expect(
      "grantCoverage" in
        githubProviderToolSpecs.find(
          (tool) => tool.name === "github_call_mcp_tool"
        )!
    ).toBe(false);
    expect(
      "grantCoverage" in
        atlassianProviderToolSpecs.find(
          (tool) => tool.name === "atlassian_call_mcp_tool"
        )!
    ).toBe(false);
  });

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
    expect(names).not.toContain("google_list_shared_drive_files");
    expect(names).toContain("google_list_shared_drives");
    expect(names).toContain("google_docs_create_document");
    expect(names).toContain("google_create_calendar_event");
    expect(names).toContain("gmail_create_draft");
    expect(names).toContain("google_analytics_run_report");
    expect(names).toContain("google_slides_probe_template");
    expect(names).toContain("google_slides_copy_presentation");
    expect(names).toContain("google_slides_create_slide");
    expect(names).toContain("google_slides_fill_placeholders");
    expect(
      googleProviderToolSpecs
        .find((tool) => tool.name === "google_search_drive_files")
        ?.input.scope
    ).toEqual({
      type: "enum",
      optional: true,
      values: ["all", "shared_with_me", "shared_drive", "all_shared_drives"],
      description: expect.any(String)
    });
    expect(
      googleProviderToolSpecs.find(
        (tool) => tool.name === "google_slides_copy_presentation"
      )?.risk
    ).toBe("low_write");
    expect(
      googleProviderToolSpecs.find(
        (tool) => tool.name === "google_slides_fill_placeholders"
      )?.risk
    ).toBe("low_write");
    expect(
      googleProviderToolSpecs.find(
        (tool) => tool.name === "google_slides_fill_placeholders"
      )?.retrySafe
    ).toBe(false);
    expect(
      googleProviderToolSpecs.find(
        (tool) => tool.name === "google_get_drive_file"
      )?.stateRefInputs
    ).toEqual(["fileId"]);
    expect(
      googleProviderToolSpecs.find(
        (tool) => tool.name === "google_append_to_drive_text_file"
      )?.dependsOn
    ).toEqual(["google_get_drive_file"]);
    expect(
      googleProviderToolSpecs.find(
        (tool) => tool.name === "google_append_to_drive_text_file"
      )?.stateRefInputs
    ).toEqual(["fileId"]);
    expect(
      googleProviderToolSpecs.find(
        (tool) => tool.name === "google_append_to_drive_text_file"
      )?.stateRefRequired
    ).toBe(true);
    expect(
      googleProviderToolSpecs.find(
        (tool) => tool.name === "google_get_drive_file"
      )?.stateRefRequired
    ).toBeUndefined();
    expect(
      googleProviderToolSpecs.find(
        (tool) => tool.name === "google_slides_create_slide"
      )?.risk
    ).toBe("low_write");
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

  test("validates object array item formats from YAML", () => {
    const fillPlaceholders = googleProviderToolSpecs.find(
      (tool) => tool.name === "google_slides_fill_placeholders"
    );
    expect(fillPlaceholders).toBeDefined();

    const schema = providerToolInputSchema(fillPlaceholders!);

    expect(
      schema.replacements.safeParse([
        { placeholderType: "TITLE", text: "ApeLogic" }
      ]).success
    ).toBe(true);
    expect(
      schema.replacements.safeParse([{ placeholderType: "TITLE" }]).success
    ).toBe(false);
    expect(schema.replacements.safeParse([]).success).toBe(false);
  });

  test("validates Google Slides create slide schema from YAML", () => {
    const createSlide = googleProviderToolSpecs.find(
      (tool) => tool.name === "google_slides_create_slide"
    );
    expect(createSlide).toBeDefined();

    const schema = providerToolInputSchema(createSlide!);

    expect(schema.presentationId.safeParse("deck-123").success).toBe(true);
    expect(schema.insertionIndex.safeParse(2).success).toBe(true);
    expect(schema.insertionIndex.safeParse(-1).success).toBe(false);
    expect(
      schema.replacements.safeParse([
        { placeholderType: "TITLE", text: "Test slide 3" },
        { placeholderType: "BODY", index: 0, text: "Left text" },
        { placeholderType: "BODY", index: 1, text: "Right text" }
      ]).success
    ).toBe(true);
    expect(
      schema.replacements.safeParse([{ placeholderType: "TITLE" }]).success
    ).toBe(false);
  });

  test("keeps Hermes provider hints sourced from the provider tool catalog", () => {
    const hints = JSON.parse(
      readFileSync(
        new URL(
          "../../runtimes/nemo-hermes/runtime/provider-tool-hints.json",
          import.meta.url
        ),
        "utf8"
      )
    ) as HermesProviderToolHints;

    expect(hints).toEqual(buildRuntimeProviderToolHints(providerToolCatalog));
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

  test("loads HubSpot MCP tool metadata from YAML", () => {
    const names = hubspotProviderToolSpecs.map((tool) => tool.name);

    expect(names).toEqual([
      "hubspot_get_authenticated_user",
      "hubspot_search_contacts",
      "hubspot_search_companies",
      "hubspot_search_deals",
      "hubspot_search_crm_objects",
      "hubspot_list_owners",
      "hubspot_list_users",
      "hubspot_read_api_resource"
    ]);
    expect(
      hubspotProviderToolSpecs.every(
        (tool) =>
          tool.provider === "hubspot" &&
          tool.alias.startsWith("hubspot.") &&
          tool.implementation.length > 0
      )
    ).toBe(true);

    const searchContacts = hubspotProviderToolSpecs.find(
      (tool) => tool.name === "hubspot_search_contacts"
    );
    expect(searchContacts).toBeDefined();
    const schema = providerToolInputSchema(searchContacts!);
    expect(schema.query.safeParse("acme").success).toBe(true);
    expect(schema.query.safeParse("").success).toBe(false);
    expect(schema.limit.safeParse(20).success).toBe(true);
    expect(schema.limit.safeParse(21).success).toBe(false);

    const searchCrmObjects = hubspotProviderToolSpecs.find(
      (tool) => tool.name === "hubspot_search_crm_objects"
    );
    expect(searchCrmObjects).toBeDefined();
    const crmObjectSchema = providerToolInputSchema(searchCrmObjects!);
    expect(crmObjectSchema.objectType.safeParse("users").success).toBe(true);
    expect(crmObjectSchema.objectType.safeParse("tickets").success).toBe(false);

    const readApiResource = hubspotProviderToolSpecs.find(
      (tool) => tool.name === "hubspot_read_api_resource"
    );
    expect(readApiResource).toBeDefined();
    const readSchema = providerToolInputSchema(readApiResource!);
    expect(readSchema.path.safeParse("/crm/v3/schemas/deals").success).toBe(true);
    expect(readSchema.query.safeParse({ archived: false }).success).toBe(true);
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
