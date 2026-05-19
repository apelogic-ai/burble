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

describe("createGitHubTools", () => {
  test("gets the authenticated GitHub user with caller token", async () => {
    const tools = createGitHubTools({
      getGitHubUser: async (token) => {
        expect(token).toBe("secret-token");
        return { login: "octocat" };
      },
      listAssignedIssues: async () => []
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
      }
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
});
