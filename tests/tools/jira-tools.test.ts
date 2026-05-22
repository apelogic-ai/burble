import { describe, expect, test } from "bun:test";
import type { ProviderConnection } from "../../src/db";
import { createJiraTools } from "../../src/tools/jira";

const connection: ProviderConnection = {
  provider: "jira",
  email: "person@example.com",
  slackUserId: "U123",
  providerLogin: "person@atlassian.example",
  accessToken: "jira-token",
  connectedAt: "2026-05-22T00:00:00Z"
};

describe("createJiraTools", () => {
  test("gets the authenticated Jira user with caller token", async () => {
    const tools = createJiraTools({
      getJiraUser: async (token) => {
        expect(token).toBe("jira-token");
        return {
          accountId: "account-123",
          displayName: "Person Example",
          emailAddress: "person@example.com"
        };
      },
      listAssignedJiraIssues: async () => [],
      searchJiraIssues: async () => []
    });

    const result = await tools.getAuthenticatedUser.execute({ connection });

    expect(result).toEqual({
      classification: "user_private",
      content: {
        accountId: "account-123",
        displayName: "Person Example"
      }
    });
    expect(JSON.stringify(result)).not.toContain("jira-token");
  });

  test("lists assigned Jira issues with capped sanitized content", async () => {
    const tools = createJiraTools({
      getJiraUser: async () => ({
        accountId: "account-123",
        displayName: "Person Example"
      }),
      listAssignedJiraIssues: async (token) => {
        expect(token).toBe("jira-token");
        return [
          {
            key: "ENG-123",
            summary: "Fix deploy dashboard",
            url: "https://example.atlassian.net/browse/ENG-123",
            status: "In Progress"
          }
        ];
      },
      searchJiraIssues: async () => []
    });

    const result = await tools.listAssignedIssues.execute({ connection });

    expect(result).toEqual({
      classification: "user_private",
      content: [
        {
          key: "ENG-123",
          title: "Fix deploy dashboard",
          url: "https://example.atlassian.net/browse/ENG-123",
          status: "In Progress"
        }
      ]
    });
    expect(JSON.stringify(result)).not.toContain("jira-token");
  });

  test("searches Jira issues with caller token and sanitized results", async () => {
    const tools = createJiraTools({
      getJiraUser: async () => ({
        accountId: "account-123",
        displayName: "Person Example"
      }),
      listAssignedJiraIssues: async () => [],
      searchJiraIssues: async (token, jql) => {
        expect(token).toBe("jira-token");
        expect(jql).toBe("project = ENG AND status != Done");
        return [
          {
            key: "ENG-124",
            summary: "Investigate queue lag",
            url: "https://example.atlassian.net/browse/ENG-124"
          }
        ];
      }
    });

    const result = await tools.searchIssues.execute({
      connection,
      input: { jql: "project = ENG AND status != Done" }
    });

    expect(result).toEqual({
      classification: "user_private",
      content: [
        {
          key: "ENG-124",
          title: "Investigate queue lag",
          url: "https://example.atlassian.net/browse/ENG-124"
        }
      ]
    });
    expect(JSON.stringify(result)).not.toContain("jira-token");
  });
});
