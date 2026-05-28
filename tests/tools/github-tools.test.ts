import { describe, expect, test } from "bun:test";
import { createGitHubTools } from "../../src/tools/github";
import type { ProviderConnection } from "../../src/db";

const connection: ProviderConnection = {
  provider: "github",
  email: "person@example.com",
  slackUserId: "U123",
  providerLogin: "octocat",
  accessToken: "secret-token",
  connectedAt: "2026-05-19T00:00:00Z"
};

const githubWriteStubs = {
  createIssue: async () => ({
    html_url: "https://github.com/acme/app/issues/1",
    title: "Issue",
    number: 1
  }),
  commentOnIssueOrPullRequest: async () => ({
    html_url: "https://github.com/acme/app/issues/1#issuecomment-1",
    id: 1
  }),
  createPullRequest: async () => ({
    html_url: "https://github.com/acme/app/pull/1",
    title: "PR",
    number: 1
  }),
  updatePullRequest: async () => ({
    html_url: "https://github.com/acme/app/pull/1",
    title: "PR",
    number: 1
  }),
  addLabels: async () => ({
    html_url: "https://github.com/acme/app/issues/1",
    number: 1
  }),
  removeLabels: async () => ({
    html_url: "https://github.com/acme/app/issues/1",
    number: 1
  }),
  requestReview: async () => ({
    html_url: "https://github.com/acme/app/pull/1",
    title: "PR",
    number: 1
  })
};

describe("createGitHubTools", () => {
  test("gets the authenticated GitHub user with caller token", async () => {
    const tools = createGitHubTools({
      getGitHubUser: async (token) => {
        expect(token).toBe("secret-token");
        return { login: "octocat" };
      },
      listAssignedIssues: async () => [],
      searchIssues: async () => [],
      listMyPullRequests: async () => [],
      ...githubWriteStubs
    });

    const result = await tools.getAuthenticatedUser.execute({ connection });

    expect(result).toEqual({
      classification: "user_private",
      content: {
        login: "octocat"
      }
    });
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  test("lists assigned issues with capped sanitized content", async () => {
    const tools = createGitHubTools({
      getGitHubUser: async () => ({ login: "octocat" }),
      listAssignedIssues: async (token) => {
        expect(token).toBe("secret-token");
        return [
          {
            html_url: "https://github.com/acme/app/issues/1",
            title: "Fix billing export"
          }
        ];
      },
      searchIssues: async () => [],
      listMyPullRequests: async () => [],
      ...githubWriteStubs
    });

    const result = await tools.listAssignedIssues.execute({ connection });

    expect(result).toEqual({
      classification: "user_private",
      content: [
        {
          url: "https://github.com/acme/app/issues/1",
          title: "Fix billing export"
        }
      ]
    });
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  test("searches issues with caller token and sanitized query results", async () => {
    const tools = createGitHubTools({
      getGitHubUser: async () => ({ login: "octocat" }),
      listAssignedIssues: async () => [],
      searchIssues: async (token, query) => {
        expect(token).toBe("secret-token");
        expect(query).toBe("repo:acme/app label:billing");
        return [
          {
            html_url: "https://github.com/acme/app/issues/2",
            title: "Repair billing search"
          }
        ];
      },
      listMyPullRequests: async () => [],
      ...githubWriteStubs
    });

    const result = await tools.searchIssues.execute({
      connection,
      input: { query: "repo:acme/app label:billing" }
    });

    expect(result).toEqual({
      classification: "user_private",
      content: [
        {
          url: "https://github.com/acme/app/issues/2",
          title: "Repair billing search"
        }
      ]
    });
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  test("lists my pull requests with caller token and sanitized results", async () => {
    const tools = createGitHubTools({
      getGitHubUser: async () => ({ login: "octocat" }),
      listAssignedIssues: async () => [],
      searchIssues: async () => [],
      listMyPullRequests: async (token, options) => {
        expect(token).toBe("secret-token");
        expect(options).toEqual({
          limit: 10,
          state: "open",
          sort: "updated",
          order: "desc"
        });
        return [
          {
            html_url: "https://github.com/acme/app/pull/3",
            title: "Add workspace auth"
          }
        ];
      },
      ...githubWriteStubs
    });

    const result = await tools.listMyPullRequests.execute({ connection });

    expect(result).toEqual({
      classification: "user_private",
      content: [
        {
          url: "https://github.com/acme/app/pull/3",
          title: "Add workspace auth"
        }
      ]
    });
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  test("passes pull request list options and caps sanitized results", async () => {
    const tools = createGitHubTools({
      getGitHubUser: async () => ({ login: "octocat" }),
      listAssignedIssues: async () => [],
      searchIssues: async () => [],
      listMyPullRequests: async (token, options) => {
        expect(token).toBe("secret-token");
        expect(options).toEqual({
          limit: 2,
          state: "closed",
          sort: "created",
          order: "asc",
          owner: "example-org"
        });
        return [
          {
            html_url: "https://github.com/acme/app/pull/3",
            title: "Add workspace auth"
          },
          {
            html_url: "https://github.com/acme/app/pull/4",
            title: "Refine workspace auth"
          },
          {
            html_url: "https://github.com/acme/app/pull/5",
            title: "Extra item"
          }
        ];
      },
      ...githubWriteStubs
    });

    const result = await tools.listMyPullRequests.execute({
      connection,
      input: {
        limit: 2,
        state: "closed",
        sort: "created",
        order: "asc",
        owner: "example-org"
      }
    });

    expect(result.content).toEqual([
      {
        url: "https://github.com/acme/app/pull/3",
        title: "Add workspace auth"
      },
      {
        url: "https://github.com/acme/app/pull/4",
        title: "Refine workspace auth"
      }
    ]);
  });

  test("creates a GitHub issue with sanitized output", async () => {
    const tools = createGitHubTools({
      getGitHubUser: async () => ({ login: "octocat" }),
      listAssignedIssues: async () => [],
      searchIssues: async () => [],
      listMyPullRequests: async () => [],
      ...githubWriteStubs,
      createIssue: async (token, input) => {
        expect(token).toBe("secret-token");
        expect(input).toEqual({
          repo: "acme/app",
          title: "New issue",
          body: "Body",
          labels: ["bug"],
          assignees: ["octocat"]
        });
        return {
          html_url: "https://github.com/acme/app/issues/9",
          title: "New issue",
          number: 9
        };
      }
    });

    const result = await tools.createIssue.execute({
      connection,
      input: {
        repo: "acme/app",
        title: "New issue",
        body: "Body",
        labels: ["bug"],
        assignees: ["octocat"]
      }
    });

    expect(result).toEqual({
      classification: "user_private",
      content: {
        title: "New issue",
        url: "https://github.com/acme/app/issues/9",
        number: 9
      }
    });
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  test("comments on a GitHub issue or pull request", async () => {
    const tools = createGitHubTools({
      getGitHubUser: async () => ({ login: "octocat" }),
      listAssignedIssues: async () => [],
      searchIssues: async () => [],
      listMyPullRequests: async () => [],
      ...githubWriteStubs,
      commentOnIssueOrPullRequest: async (token, input) => {
        expect(token).toBe("secret-token");
        expect(input).toEqual({
          repo: "acme/app",
          number: 9,
          body: "Looks good"
        });
        return {
          html_url: "https://github.com/acme/app/pull/9#issuecomment-1",
          id: 123
        };
      }
    });

    const result = await tools.commentOnIssueOrPullRequest.execute({
      connection,
      input: { repo: "acme/app", number: 9, body: "Looks good" }
    });

    expect(result).toEqual({
      classification: "user_private",
      content: {
        url: "https://github.com/acme/app/pull/9#issuecomment-1",
        id: 123
      }
    });
  });

  test("creates and updates GitHub pull request metadata", async () => {
    const tools = createGitHubTools({
      getGitHubUser: async () => ({ login: "octocat" }),
      listAssignedIssues: async () => [],
      searchIssues: async () => [],
      listMyPullRequests: async () => [],
      ...githubWriteStubs,
      createPullRequest: async (token, input) => {
        expect(token).toBe("secret-token");
        expect(input).toEqual({
          repo: "acme/app",
          title: "New PR",
          head: "feature",
          base: "main",
          draft: true
        });
        return {
          html_url: "https://github.com/acme/app/pull/10",
          title: "New PR",
          number: 10,
          draft: true
        };
      },
      updatePullRequest: async (token, input) => {
        expect(token).toBe("secret-token");
        expect(input).toEqual({
          repo: "acme/app",
          number: 10,
          title: "Updated PR",
          draft: false
        });
        return {
          html_url: "https://github.com/acme/app/pull/10",
          title: "Updated PR",
          number: 10,
          draft: false
        };
      }
    });

    await expect(
      tools.createPullRequest.execute({
        connection,
        input: {
          repo: "acme/app",
          title: "New PR",
          head: "feature",
          base: "main",
          draft: true
        }
      })
    ).resolves.toEqual({
      classification: "user_private",
      content: {
        title: "New PR",
        url: "https://github.com/acme/app/pull/10",
        number: 10,
        draft: true
      }
    });

    await expect(
      tools.updatePullRequest.execute({
        connection,
        input: {
          repo: "acme/app",
          number: 10,
          title: "Updated PR",
          draft: false
        }
      })
    ).resolves.toEqual({
      classification: "user_private",
      content: {
        title: "Updated PR",
        url: "https://github.com/acme/app/pull/10",
        number: 10,
        draft: false
      }
    });
  });

  test("adds/removes labels and requests review", async () => {
    const tools = createGitHubTools({
      getGitHubUser: async () => ({ login: "octocat" }),
      listAssignedIssues: async () => [],
      searchIssues: async () => [],
      listMyPullRequests: async () => [],
      ...githubWriteStubs,
      addLabels: async (token, input) => {
        expect(token).toBe("secret-token");
        expect(input).toEqual({
          repo: "acme/app",
          number: 10,
          labels: ["ready"]
        });
        return {
          html_url: "https://github.com/acme/app/issues/10",
          number: 10
        };
      },
      removeLabels: async (token, input) => {
        expect(token).toBe("secret-token");
        expect(input).toEqual({
          repo: "acme/app",
          number: 10,
          labels: ["wip"]
        });
        return {
          html_url: "https://github.com/acme/app/issues/10",
          number: 10
        };
      },
      requestReview: async (token, input) => {
        expect(token).toBe("secret-token");
        expect(input).toEqual({
          repo: "acme/app",
          number: 10,
          reviewers: ["octocat"]
        });
        return {
          html_url: "https://github.com/acme/app/pull/10",
          title: "New PR",
          number: 10
        };
      }
    });

    expect(
      await tools.addLabels.execute({
        connection,
        input: { repo: "acme/app", number: 10, labels: ["ready"] }
      })
    ).toEqual({
      classification: "user_private",
      content: {
        url: "https://github.com/acme/app/issues/10",
        number: 10
      }
    });

    expect(
      await tools.removeLabels.execute({
        connection,
        input: { repo: "acme/app", number: 10, labels: ["wip"] }
      })
    ).toEqual({
      classification: "user_private",
      content: {
        url: "https://github.com/acme/app/issues/10",
        number: 10
      }
    });

    expect(
      await tools.requestReview.execute({
        connection,
        input: { repo: "acme/app", number: 10, reviewers: ["octocat"] }
      })
    ).toEqual({
      classification: "user_private",
      content: {
        title: "New PR",
        url: "https://github.com/acme/app/pull/10",
        number: 10
      }
    });
  });
});
