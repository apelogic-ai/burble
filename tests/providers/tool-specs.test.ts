import { describe, expect, test } from "bun:test";
import { githubProviderToolSpecs } from "../../src/providers/github/tool-specs";
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

    const schema = providerToolInputSchema(createIssue!);

    expect(schema.repo.safeParse("acme/app").success).toBe(true);
    expect(schema.title.safeParse("").success).toBe(false);
    expect(schema.labels.safeParse(["bug"]).success).toBe(true);
    expect(schema.labels.safeParse(Array.from({ length: 21 }, () => "bug")).success).toBe(
      false
    );
  });
});
