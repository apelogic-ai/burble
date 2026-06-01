import { describe, expect, test } from "bun:test";
import type { ProviderConnection } from "../../src/db";
import { createAiSdkAgentRunner } from "../../src/agent/runner";
import type { DirectLanguageModel } from "../../src/agent/providers";
import { collectAgentRun } from "../../src/agent/types";
import { createGitHubTools } from "../../src/tools/github";
import { createJiraTools } from "../../src/tools/jira";
import type { ObservabilityEventInput } from "../../src/observability";

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

  test("emits observability events for local LLM calls", async () => {
    const model = { provider: "test", modelId: "model" } as DirectLanguageModel;
    const observabilityEvents: ObservabilityEventInput[] = [];
    const runner = createAiSdkAgentRunner({
      model: "openai:test-model",
      resolveModel: () => model,
      githubTools: createGitHubTools({
        getGitHubUser: async () => ({ login: "octocat" }),
        listAssignedIssues: async () => [],
        searchIssues: async () => [],
        listMyPullRequests: async () => []
      }),
      generateText: async () => ({
        text: "Hello from the model.",
        usage: {
          inputTokens: 20,
          outputTokens: 5,
          totalTokens: 25,
          inputTokenDetails: {
            noCacheTokens: 20,
            cacheReadTokens: undefined,
            cacheWriteTokens: undefined
          },
          outputTokenDetails: {
            textTokens: 5,
            reasoningTokens: undefined
          }
        }
      }),
      observability: {
        emit: (event) => {
          observabilityEvents.push(event);
        }
      }
    });

    const response = await collectAgentRun(runner, {
      principal,
      text: "say hello",
      connections: { github: connection }
    });

    expect(response.text).toBe("Hello from the model.");
    expect(observabilityEvents.map((event) => event.name)).toEqual([
      "llm.call.started",
      "llm.call.completed"
    ]);
    expect(observabilityEvents[0]).toMatchObject({
      workspaceId: "T123",
      principalId: "T123:U123",
      model: "openai:test-model",
      provider: "test",
      attributes: {
        modelId: "model",
        textLength: 9
      }
    });
    expect(observabilityEvents[1]).toMatchObject({
      workspaceId: "T123",
      principalId: "T123:U123",
      model: "openai:test-model",
      provider: "test",
      classification: "public",
      status: "ok",
      usage: {
        inputTokens: 20,
        outputTokens: 5,
        totalTokens: 25
      },
      attributes: {
        textLength: 21
      }
    });
    expect(observabilityEvents[0].callId).toBeString();
    expect(observabilityEvents[1].callId).toBe(observabilityEvents[0].callId);
    expect(JSON.stringify(observabilityEvents)).not.toContain("secret-token");
    expect(JSON.stringify(observabilityEvents)).not.toContain("say hello");
  });

  test("includes current Slack channel history status in the prompt", async () => {
    const model = { provider: "test", modelId: "model" } as DirectLanguageModel;
    const runner = createAiSdkAgentRunner({
      model: "openai:test-model",
      resolveModel: () => model,
      githubTools: createGitHubTools({
        getGitHubUser: async () => ({ login: "octocat" }),
        listAssignedIssues: async () => [],
        searchIssues: async () => [],
        listMyPullRequests: async () => []
      }),
      generateText: async (request) => {
        expect(request.prompt).toContain("Current Slack channel ID: C123");
        expect(request.prompt).toContain(
          "Current Slack channel history: available (1 recent messages)"
        );
        expect(request.prompt).toContain("Slack user <@U456>: hello president");
        return { text: "The channel mentioned president once." };
      }
    });

    const response = await collectAgentRun(runner, {
      principal,
      text: "summarize current channel",
      context: {
        currentChannel: {
          id: "C123",
          isDirectMessage: false,
          historyAvailable: true
        },
        recentMessages: [
          {
            author: "user",
            speaker: "<@U456>",
            text: "hello president"
          }
        ]
      },
      connections: { github: null }
    });

    expect(response.text).toBe("The channel mentioned president once.");
  });

  test("bounds recent Slack channel history in the prompt", async () => {
    const model = { provider: "test", modelId: "model" } as DirectLanguageModel;
    const runner = createAiSdkAgentRunner({
      model: "openai:test-model",
      resolveModel: () => model,
      githubTools: createGitHubTools({
        getGitHubUser: async () => ({ login: "octocat" }),
        listAssignedIssues: async () => [],
        searchIssues: async () => [],
        listMyPullRequests: async () => []
      }),
      generateText: async (request) => {
        expect(request.prompt).toContain(
          "Current Slack channel history: available (12 of 20 recent messages included)"
        );
        expect(request.prompt).not.toContain("old context 1");
        expect(request.prompt).toContain("recent context 20");
        expect(request.prompt).not.toContain("x".repeat(350));
        return { text: "Bounded." };
      }
    });

    const response = await collectAgentRun(runner, {
      principal,
      text: "summarize current channel",
      context: {
        currentChannel: {
          id: "C123",
          isDirectMessage: false,
          historyAvailable: true
        },
        recentMessages: Array.from({ length: 20 }, (_, index) => ({
          author: "user" as const,
          speaker: "<@U456>",
          text:
            index === 19
              ? `recent context ${index + 1} ${"x".repeat(500)}`
              : `${index === 0 ? "old" : "recent"} context ${index + 1}`
        }))
      },
      connections: { github: null }
    });

    expect(response.text).toBe("Bounded.");
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
          displayName: "Example User"
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
