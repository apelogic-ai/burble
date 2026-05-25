import { describe, expect, test } from "bun:test";
import type { ProviderConnection } from "../../src/db";
import { createAiSdkAgentRunner } from "../../src/agent/runner";
import type { DirectLanguageModel } from "../../src/agent/providers";
import { collectAgentRun } from "../../src/agent/types";
import { createGitHubTools } from "../../src/tools/github";
import { createJiraTools } from "../../src/tools/jira";

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

const jiraConnection: ProviderConnection = {
  provider: "jira",
  email: "person@example.com",
  slackUserId: "U123",
  providerLogin: "5f123",
  accessToken: "jira-secret-token",
  connectedAt: "2026-05-19T00:00:00Z"
};

const principal = {
  workspaceId: "T123",
  slackUserId: "U123"
};

describe("createAiSdkAgentRunner", () => {
  test("builds an LLM runner that can execute sanitized GitHub tools", async () => {
    const model = { provider: "test", modelId: "model" } as DirectLanguageModel;
    const logs: string[] = [];
    const runner = createAiSdkAgentRunner({
      model: "openai:test-model",
      resolveModel: (modelId) => {
        expect(modelId).toBe("openai:test-model");
        return model;
      },
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
        expect(request.model).toBe(model);
        expect(request.experimental_telemetry).toEqual({
          isEnabled: false,
          recordInputs: false,
          recordOutputs: false
        });
        expect(request.prompt).toContain("what issues are assigned to me?");
        const tools = request.tools as unknown as Record<string, ExecutableTool>;
        const toolResult = await tools.github_list_assigned_issues.execute({});

        expect(JSON.stringify(toolResult)).not.toContain("secret-token");

        return {
          text: "- <https://github.com/acme/app/issues/1|Fix billing export>",
          usage: {
            inputTokens: 1200,
            outputTokens: 80,
            totalTokens: 1280,
            inputTokenDetails: {
              noCacheTokens: 900,
              cacheReadTokens: 300,
              cacheWriteTokens: undefined
            },
            outputTokenDetails: {
              textTokens: 55,
              reasoningTokens: 25
            }
          }
        };
      },
      logInfo: (message) => logs.push(message)
    });

    const response = await collectAgentRun(runner, {
      principal,
      text: "what issues are assigned to me?",
      connections: { github: connection }
    });

    expect(response).toEqual({
      classification: "user_private",
      text: "- <https://github.com/acme/app/issues/1|Fix billing export>",
      usage: {
        inputTokens: 1200,
        outputTokens: 80,
        totalTokens: 1280,
        cachedInputTokens: 300,
        reasoningTokens: 25
      }
    });
    expect(logs).toContain(
      "LLM call start model=openai:test-model provider=test modelId=model textLength=31"
    );
    expect(logs).toContain("LLM tool start name=github_list_assigned_issues");
    expect(logs).toContain(
      "LLM tool finish name=github_list_assigned_issues classification=user_private itemCount=1"
    );
    expect(logs).toContain(
      "LLM usage model=openai:test-model provider=test modelId=model inputTokens=1200 outputTokens=80 totalTokens=1280 cachedInputTokens=300 reasoningTokens=25"
    );
    expect(logs).toContain(
      "LLM call finish model=openai:test-model classification=user_private textLength=59"
    );
  });

  test("returns a connect instruction when a GitHub tool is used without auth", async () => {
    const runner = createAiSdkAgentRunner({
      model: "openai:test-model",
      resolveModel: () =>
        ({ provider: "test", modelId: "model" }) as DirectLanguageModel,
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

    const response = await collectAgentRun(runner, {
      principal,
      text: "who am I on GitHub?",
      connections: { github: null }
    });

    expect(response).toEqual({
      classification: "user_private",
      text: "Connect GitHub first: `@Burble connect github`."
    });
  });

  test("builds an LLM runner that can execute sanitized Jira tools", async () => {
    const runner = createAiSdkAgentRunner({
      model: "openai:test-model",
      resolveModel: () =>
        ({ provider: "test", modelId: "model" }) as DirectLanguageModel,
      githubTools: createGitHubTools({
        getGitHubUser: async () => ({ login: "octocat" }),
        listAssignedIssues: async () => [],
        searchIssues: async () => [],
        listMyPullRequests: async () => []
      }),
      jiraTools: createJiraTools({
        getJiraUser: async () => ({
          accountId: "5f123",
          displayName: "Leo"
        }),
        listAssignedJiraIssues: async () => [
          {
            key: "ENG-17",
            summary: "Fix deploy dashboard",
            url: "https://jira.example/browse/ENG-17",
            status: "In Progress"
          }
        ],
        searchJiraIssues: async () => []
      }),
      generateText: async (request) => {
        const tools = request.tools as unknown as Record<string, ExecutableTool>;
        const toolResult = await tools.jira_list_assigned_issues.execute({});

        expect(JSON.stringify(toolResult)).toContain("ENG-17");
        expect(JSON.stringify(toolResult)).not.toContain("jira-secret-token");

        return {
          text: "- <https://jira.example/browse/ENG-17|ENG-17 Fix deploy dashboard>"
        };
      }
    });

    const response = await collectAgentRun(runner, {
      principal,
      text: "what Jira tickets are assigned to me?",
      connections: { github: null, jira: jiraConnection }
    });

    expect(response).toEqual({
      classification: "user_private",
      text: "- <https://jira.example/browse/ENG-17|ENG-17 Fix deploy dashboard>"
    });
  });
});
