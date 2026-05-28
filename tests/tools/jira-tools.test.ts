import { describe, expect, test } from "bun:test";
import type { ProviderConnection } from "../../src/db";
import { JiraApiError } from "../../src/jira";
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

  test("lists accessible Jira resources with sanitized content", async () => {
    const tools = createJiraTools({
      getJiraUser: async () => ({
        accountId: "account-123",
        displayName: "Person Example"
      }),
      listJiraAccessibleResources: async (token) => {
        expect(token).toBe("jira-token");
        return [
          {
            id: "cloud-123",
            name: "Example Jira Site",
            url: "https://example.atlassian.net",
            scopes: ["read:jira-work", "write:jira-work"]
          },
          {
            id: "conf-123",
            name: "Docs",
            url: "https://docs.atlassian.net",
            scopes: ["read:confluence-content.summary"]
          }
        ];
      },
      listAssignedJiraIssues: async () => [],
      searchJiraIssues: async () => []
    });

    const result = await tools.listAccessibleResources.execute({ connection });

    expect(result).toEqual({
      classification: "user_private",
      content: [
        {
          id: "cloud-123",
          name: "Example Jira Site",
          url: "https://example.atlassian.net"
        }
      ]
    });
    expect(JSON.stringify(result)).not.toContain("jira-token");
  });

  test("lists visible Jira projects with sanitized issue types", async () => {
    const tools = createJiraTools({
      getJiraUser: async () => ({
        accountId: "account-123",
        displayName: "Person Example"
      }),
      listVisibleJiraProjects: async (token, input) => {
        expect(token).toBe("jira-token");
        expect(input).toEqual({
          query: "DM",
          action: "create",
          expandIssueTypes: true
        });
        return [
          {
            id: "10000",
            key: "DM",
            name: "DM Workspace",
            url: "https://example.atlassian.net/jira/projects/DM",
            issueTypes: [
              {
                id: "10001",
                name: "Task",
                description: "A unit of work",
                subtask: false
              }
            ]
          }
        ];
      },
      listAssignedJiraIssues: async () => [],
      searchJiraIssues: async () => []
    });

    const result = await tools.listVisibleProjects.execute({
      connection,
      input: { query: "DM", action: "create", expandIssueTypes: true }
    });

    expect(result).toEqual({
      classification: "user_private",
      content: [
        {
          id: "10000",
          key: "DM",
          name: "DM Workspace",
          url: "https://example.atlassian.net/jira/projects/DM",
          issueTypes: [
            {
              id: "10001",
              name: "Task",
              description: "A unit of work",
              subtask: false
            }
          ]
        }
      ]
    });
    expect(JSON.stringify(result)).not.toContain("jira-token");
  });

  test("searches Jira users with sanitized content", async () => {
    const tools = createJiraTools({
      getJiraUser: async () => ({
        accountId: "account-123",
        displayName: "Person Example"
      }),
      searchJiraUsers: async (token, query) => {
        expect(token).toBe("jira-token");
        expect(query).toBe("alex.reviewer@example.com");
        return [
          {
            accountId: "acct-example",
            displayName: "Alex Reviewer",
            emailAddress: "alex.reviewer@example.com"
          }
        ];
      },
      listAssignedJiraIssues: async () => [],
      searchJiraIssues: async () => []
    });

    const result = await tools.searchUsers.execute({
      connection,
      input: { query: "alex.reviewer@example.com" }
    });

    expect(result).toEqual({
      classification: "user_private",
      content: [
        {
          accountId: "acct-example",
          displayName: "Alex Reviewer",
          emailAddress: "alex.reviewer@example.com"
        }
      ]
    });
    expect(JSON.stringify(result)).not.toContain("jira-token");
  });

  test("creates Jira issues with sanitized content", async () => {
    const tools = createJiraTools({
      getJiraUser: async () => ({
        accountId: "account-123",
        displayName: "Person Example"
      }),
      createJiraIssue: async (token, input) => {
        expect(token).toBe("jira-token");
        expect(input).toEqual({
          projectKey: "DM",
          issueTypeName: "Task",
          summary: "test ticket from slack",
          assigneeAccountId: "acct-example"
        });
        return {
          key: "DM-100",
          summary: input.summary,
          url: "https://example.atlassian.net/browse/DM-100"
        };
      },
      listAssignedJiraIssues: async () => [],
      searchJiraIssues: async () => []
    });

    const result = await tools.createIssue.execute({
      connection,
      input: {
        projectKey: "DM",
        issueTypeName: "Task",
        summary: "test ticket from slack",
        assigneeAccountId: "acct-example"
      }
    });

    expect(result).toEqual({
      classification: "user_private",
      content: {
        key: "DM-100",
        title: "test ticket from slack",
        url: "https://example.atlassian.net/browse/DM-100"
      }
    });
    expect(JSON.stringify(result)).not.toContain("jira-token");
  });

  test("edits Jira issues with sanitized content", async () => {
    const tools = createJiraTools({
      getJiraUser: async () => ({
        accountId: "account-123",
        displayName: "Person Example"
      }),
      editJiraIssue: async (token, input) => {
        expect(token).toBe("jira-token");
        expect(input).toEqual({
          issueKey: "DM-100",
          summary: "updated title",
          assigneeAccountId: null
        });
        return {
          key: "DM-100",
          summary: "updated title",
          url: "https://example.atlassian.net/browse/DM-100"
        };
      },
      listAssignedJiraIssues: async () => [],
      searchJiraIssues: async () => []
    });

    const result = await tools.editIssue.execute({
      connection,
      input: {
        issueKey: "DM-100",
        summary: "updated title",
        assigneeAccountId: null
      }
    });

    expect(result).toEqual({
      classification: "user_private",
      content: {
        key: "DM-100",
        title: "updated title",
        url: "https://example.atlassian.net/browse/DM-100"
      }
    });
    expect(JSON.stringify(result)).not.toContain("jira-token");
  });

  test("refreshes an expired Jira token and persists the rotated token", async () => {
    const saved: ProviderConnection[] = [];
    const tools = createJiraTools({
      getJiraUser: async () => ({
        accountId: "account-123",
        displayName: "Person Example"
      }),
      listAssignedJiraIssues: async (token) => {
        expect(token).toBe("new-jira-token");
        return [
          {
            key: "ENG-125",
            summary: "Refresh token support",
            url: "https://example.atlassian.net/browse/ENG-125"
          }
        ];
      },
      searchJiraIssues: async () => [],
      refreshJiraAccessToken: async (refreshToken) => {
        expect(refreshToken).toBe("old-refresh-token");
        return {
          accessToken: "new-jira-token",
          refreshToken: "new-refresh-token",
          accessTokenExpiresAt: "2026-05-23T07:00:00.000Z"
        };
      },
      saveJiraConnection: (refreshed) => saved.push(refreshed),
      now: () => new Date("2026-05-23T06:00:00.000Z")
    });

    const result = await tools.listAssignedIssues.execute({
      connection: {
        ...connection,
        refreshToken: "old-refresh-token",
        accessTokenExpiresAt: "2026-05-23T06:00:30.000Z"
      }
    });

    expect(result.content).toEqual([
      {
        key: "ENG-125",
        title: "Refresh token support",
        url: "https://example.atlassian.net/browse/ENG-125"
      }
    ]);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      accessToken: "new-jira-token",
      refreshToken: "new-refresh-token",
      accessTokenExpiresAt: "2026-05-23T07:00:00.000Z"
    });
  });

  test("asks for reconnect when Jira returns 401 without a refresh token", async () => {
    const tools = createJiraTools({
      getJiraUser: async () => ({
        accountId: "account-123",
        displayName: "Person Example"
      }),
      listAssignedJiraIssues: async () => {
        throw new JiraApiError("expired", 401);
      },
      searchJiraIssues: async () => []
    });

    const result = await tools.listAssignedIssues.execute({ connection });

    expect(result).toEqual({
      classification: "user_private",
      content: {
        error: "jira_authorization_failed",
        message: "Jira authorization expired. Reconnect Jira with `@Burble connect jira`."
      }
    });
  });
});
