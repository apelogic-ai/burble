import { describe, expect, test } from "bun:test";
import { handleConversation } from "../../src/conversation/orchestrator";
import type { ConversationDeps, ConversationRequest } from "../../src/conversation/types";
import type { AgentInput, AgentOutput, AgentRunner } from "../../src/agent/types";
import { createGitHubTools } from "../../src/tools/github";

const baseRequest: ConversationRequest = {
  source: "slack",
  workspaceId: "T123",
  channelId: "C123",
  messageTs: "1710000000.000100",
  isDirectMessage: false,
  user: {
    slackUserId: "U123",
    email: "person@example.com"
  },
  text: "who am I on GitHub?"
};

function createDeps(overrides: Partial<ConversationDeps> = {}): ConversationDeps {
  const connection = {
    provider: "github" as const,
    email: "person@example.com",
    slackUserId: "U123",
    providerLogin: "octocat",
    accessToken: "secret-token",
    connectedAt: "2026-05-19T00:00:00Z"
  };
  const githubTools = createGitHubTools({
    getGitHubUser: async () => ({ login: "octocat" }),
    listAssignedIssues: async () => [
      {
        html_url: "https://github.com/acme/app/issues/1",
        title: "Fix billing export"
      }
    ],
    searchIssues: async () => [
      {
        html_url: "https://github.com/acme/app/issues/2",
        title: "Search result issue"
      }
    ],
    listMyPullRequests: async () => [
      {
        html_url: "https://github.com/acme/app/pull/3",
        title: "Add workspace auth"
      }
    ]
  });

  return {
    createGitHubOAuthUrl: () => "https://example.test/oauth/github",
    getConnection: () => connection,
    githubTools,
    ...overrides
  };
}

function stubAgentRunner(
  run: (input: AgentInput) => Promise<AgentOutput> | AgentOutput
): AgentRunner {
  return {
    name: "stub",
    capabilities: {
      streaming: false,
      toolEvents: false,
      remote: false
    },
    async *run(input) {
      yield { type: "final", response: await run(input) };
    }
  };
}

describe("handleConversation", () => {
  test("returns a private GitHub connect link", async () => {
    const response = await handleConversation(
      { ...baseRequest, text: "connect github" },
      createDeps()
    );

    expect(response).toMatchObject({
      visibility: "ephemeral",
      classification: "user_private",
      text: "<https://example.test/oauth/github|Connect your GitHub account>"
    });
  });

  test("asks the user to connect GitHub before GitHub data requests", async () => {
    const response = await handleConversation(
      baseRequest,
      createDeps({ getConnection: () => null })
    );

    expect(response.visibility).toBe("ephemeral");
    expect(response.text).toBe("Connect GitHub first: `@Burble connect github`.");
  });

  test("answers GitHub identity requests without leaking tokens", async () => {
    const response = await handleConversation(baseRequest, createDeps());

    expect(response.visibility).toBe("ephemeral");
    expect(response.text).toBe(
      "Authenticated to GitHub as `octocat` for Slack email person@example.com."
    );
    expect(JSON.stringify(response)).not.toContain("secret-token");
  });

  test("answers assigned issue requests privately in channels", async () => {
    const response = await handleConversation(
      { ...baseRequest, text: "what issues are assigned to me?" },
      createDeps()
    );

    expect(response.visibility).toBe("ephemeral");
    expect(response.text).toContain("Fix billing export");
  });

  test("answers pull request requests privately in channels", async () => {
    const response = await handleConversation(
      { ...baseRequest, text: "show my pull requests" },
      createDeps()
    );

    expect(response.visibility).toBe("ephemeral");
    expect(response.text).toContain("Add workspace auth");
  });

  test("answers simple issue search requests privately in channels", async () => {
    const response = await handleConversation(
      { ...baseRequest, text: "search github issues for billing" },
      createDeps()
    );

    expect(response.visibility).toBe("ephemeral");
    expect(response.text).toContain("Search result issue");
  });

  test("leaves private GitHub data visible in direct messages", async () => {
    const response = await handleConversation(
      {
        ...baseRequest,
        channelId: "D123",
        isDirectMessage: true,
        text: "what issues are assigned to me?"
      },
      createDeps()
    );

    expect(response.visibility).toBe("public");
    expect(response.classification).toBe("user_private");
  });

  test("returns help for unknown deterministic requests", async () => {
    const response = await handleConversation(
      { ...baseRequest, text: "deploy the moon" },
      createDeps()
    );

    expect(response).toMatchObject({
      visibility: "public",
      classification: "public"
    });
    expect(response.text).toContain("@Burble connect github");
  });

  test("delegates to the LLM runner when LLM mode is enabled", async () => {
    const calls: string[] = [];
    const response = await handleConversation(
      { ...baseRequest, text: "summarize my GitHub work" },
      createDeps({
        agentMode: "llm",
        agentRunner: stubAgentRunner((input) => {
          calls.push(input.text);
          expect(input.connections.github?.providerLogin).toBe("octocat");
          return {
            classification: "user_private",
            text: "You have one issue and one pull request."
          };
        })
      })
    );

    expect(calls).toEqual(["summarize my GitHub work"]);
    expect(response.visibility).toBe("ephemeral");
    expect(response.text).toBe("You have one issue and one pull request.");
  });

  test("keeps LLM responses public when they are not provider-backed", async () => {
    const response = await handleConversation(
      { ...baseRequest, text: "what can you do?" },
      createDeps({
        agentMode: "llm",
        agentRunner: stubAgentRunner(() => ({
          classification: "public",
          text: "I can help with GitHub work once connected."
        }))
      })
    );

    expect(response.visibility).toBe("public");
    expect(response.text).toBe("I can help with GitHub work once connected.");
  });

  test("does not call the LLM runner for explicit connection requests", async () => {
    let called = false;
    const response = await handleConversation(
      { ...baseRequest, text: "connect github" },
      createDeps({
        agentMode: "llm",
        agentRunner: stubAgentRunner(() => {
          called = true;
          return {
            classification: "public",
            text: "unexpected"
          };
        })
      })
    );

    expect(called).toBe(false);
    expect(response.text).toBe(
      "<https://example.test/oauth/github|Connect your GitHub account>"
    );
  });
});
