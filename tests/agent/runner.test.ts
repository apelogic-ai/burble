import { describe, expect, test } from "bun:test";
import type { ProviderConnection } from "../../src/db";
import { createAiSdkAgentRunner } from "../../src/agent/runner";
import { createGitHubTools } from "../../src/tools/github";

type ExecutableTool = {
  execute: (input: unknown) => Promise<unknown>;
};

const connection: ProviderConnection = {
  provider: "github",
  email: "person@example.com",
  slackUserId: "U123",
  providerLogin: "octocat",
  accessToken: "secret-token",
  connectedAt: "2026-05-19T00:00:00Z"
};

describe("createAiSdkAgentRunner", () => {
  test("builds an LLM runner that can execute sanitized GitHub tools", async () => {
    const runner = createAiSdkAgentRunner({
      model: "test/model",
      githubTools: createGitHubTools({
        getGitHubUser: async () => ({ login: "octocat" }),
        listAssignedIssues: async () => [
          {
            title: "Fix billing export",
            html_url: "https://github.com/acme/app/issues/1"
          }
        ],
        searchIssues: async () => [],
        listMyPullRequests: async () => []
      }),
      generateText: async (request) => {
        expect(request.prompt).toContain("what issues are assigned to me?");
        const tools = request.tools as unknown as Record<string, ExecutableTool>;
        const toolResult = await tools.github_list_assigned_issues.execute({});

        expect(JSON.stringify(toolResult)).not.toContain("secret-token");

        return {
          text: "- <https://github.com/acme/app/issues/1|Fix billing export>"
        };
      }
    });

    const response = await runner({
      text: "what issues are assigned to me?",
      connections: { github: connection }
    });

    expect(response).toEqual({
      classification: "user_private",
      text: "- <https://github.com/acme/app/issues/1|Fix billing export>"
    });
  });

  test("returns a connect instruction when a GitHub tool is used without auth", async () => {
    const runner = createAiSdkAgentRunner({
      model: "test/model",
      githubTools: createGitHubTools({
        getGitHubUser: async () => ({ login: "octocat" }),
        listAssignedIssues: async () => [],
        searchIssues: async () => [],
        listMyPullRequests: async () => []
      }),
      generateText: async (request) => {
        const tools = request.tools as unknown as Record<string, ExecutableTool>;
        const toolResult = await tools.github_get_authenticated_user.execute({});

        expect(JSON.stringify(toolResult)).toContain("@Burble connect github");

        return {
          text: "Connect GitHub first: `@Burble connect github`."
        };
      }
    });

    const response = await runner({
      text: "who am I on GitHub?",
      connections: { github: null }
    });

    expect(response).toEqual({
      classification: "user_private",
      text: "Connect GitHub first: `@Burble connect github`."
    });
  });
});
