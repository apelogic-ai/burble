import { describe, expect, test } from "bun:test";
import { handleConversation } from "../../src/conversation/orchestrator";
import type {
  ConversationDeps,
  ConversationRequest,
} from "../../src/conversation/types";
import type {
  AgentInput,
  AgentOutput,
  AgentRunEvent,
  AgentRunner,
} from "../../src/agent/types";
import { createGitHubTools } from "../../src/tools/github";
import { createGoogleTools } from "../../src/tools/google";
import { createJiraTools } from "../../src/tools/jira";
import type { ObservabilityEventInput } from "../../src/observability";
import type { SchedulerJobSummary } from "../../src/scheduler/control-plane";

const baseRequest: ConversationRequest = {
  source: "slack",
  workspaceId: "T123",
  channelId: "C123",
  messageTs: "1710000000.000100",
  isDirectMessage: false,
  user: {
    slackUserId: "U123",
    email: "person@example.com",
  },
  text: "who am I on GitHub?",
};

function createDeps(
  overrides: Partial<ConversationDeps> = {},
): ConversationDeps {
  const connection = {
    provider: "github" as const,
    email: "person@example.com",
    slackUserId: "U123",
    providerLogin: "octocat",
    accessToken: "secret-token",
    connectedAt: "2026-05-19T00:00:00Z",
  };
  const githubTools = createGitHubTools({
    getGitHubUser: async () => ({ login: "octocat" }),
    listAssignedIssues: async () => [
      {
        html_url: "https://github.com/acme/app/issues/1",
        title: "Fix billing export",
      },
    ],
    searchIssues: async () => [
      {
        html_url: "https://github.com/acme/app/issues/2",
        title: "Search result issue",
      },
    ],
    listMyPullRequests: async (_token, options) =>
      [
        {
          html_url: "https://github.com/acme/app/pull/3",
          title: "Add workspace auth",
        },
        {
          html_url: "https://github.com/acme/app/pull/4",
          title: "Improve cron delivery",
        },
        {
          html_url: "https://github.com/acme/app/pull/5",
          title: "Wire provider bridge",
        },
        {
          html_url: "https://github.com/acme/app/pull/6",
          title: "Update old runtime",
        },
      ].slice(0, options?.limit ?? 10),
  });
  const googleConnection = {
    provider: "google" as const,
    email: "person@example.com",
    slackUserId: "U123",
    providerLogin: "person@example.com",
    accessToken: "google-token",
    connectedAt: "2026-05-19T00:00:00Z",
  };
  const jiraConnection = {
    provider: "jira" as const,
    email: "person@example.com",
    slackUserId: "U123",
    providerLogin: "person@example.com",
    accessToken: "jira-token",
    connectedAt: "2026-05-19T00:00:00Z",
  };
  const googleTools = createGoogleTools({
    getGoogleUser: async () => ({ email: "person@example.com" }),
    searchGoogleDriveFiles: async () => [
      {
        id: "drive-file-1",
        name: "apelogic-ai-open-prs-last-24h-seen.txt",
        mimeType: "text/plain",
        webViewLink: "https://drive.google.com/file/d/drive-file-1/view",
        modifiedTime: "2026-06-21T19:02:13Z",
      },
    ],
    createGoogleDriveTextFile: async () => ({
      id: "file-1",
      name: "Test",
    }),
    searchGoogleCalendarEvents: async () => [],
    searchGoogleMailMessages: async () => [
      {
        id: "mail-1",
        subject: "Your OpenAI API account has been funded",
        snippet: "We charged $100.00 to your credit card...",
      },
    ],
  });
  const jiraTools = createJiraTools({
    getJiraUser: async () => ({
      accountId: "jira-account",
      displayName: "Person",
    }),
    listAssignedJiraIssues: async () => [
      {
        key: "DM-12",
        summary: "test task ticket #9 from slack",
        url: "https://jira.example/browse/DM-12",
      },
    ],
    searchJiraIssues: async () => [
      {
        key: "DM-13",
        summary: "hello from slack",
        url: "https://jira.example/browse/DM-13",
      },
    ],
  });

  return {
    createGitHubOAuthUrl: () => "https://example.test/oauth/github",
    createJiraOAuthUrl: () => "https://example.test/oauth/jira",
    getConnection: (provider) =>
      provider === "github"
        ? connection
        : provider === "google"
          ? googleConnection
          : provider === "jira"
            ? jiraConnection
            : null,
    tools: {
      github: githubTools,
      google: googleTools,
      jira: jiraTools,
    },
    ...overrides,
  };
}

function stubAgentRunner(
  run:
    | ((input: AgentInput) => Promise<AgentOutput> | AgentOutput)
    | AgentRunEvent[],
): AgentRunner {
  return {
    name: "stub",
    capabilities: {
      streaming: false,
      toolEvents: false,
      remote: false,
    },
    async *run(input) {
      if (Array.isArray(run)) {
        yield* run;
        return;
      }

      yield { type: "final", response: await run(input) };
    },
  };
}

describe("handleConversation", () => {
  test("returns a private GitHub connect link", async () => {
    const response = await handleConversation(
      { ...baseRequest, text: "connect github" },
      createDeps(),
    );

    expect(response).toMatchObject({
      visibility: "ephemeral",
      classification: "user_private",
      text: "<https://example.test/oauth/github|Connect your GitHub account>",
    });
  });

  test("returns a private Jira connect link", async () => {
    const response = await handleConversation(
      { ...baseRequest, text: "connect jira" },
      createDeps(),
    );

    expect(response).toMatchObject({
      visibility: "ephemeral",
      classification: "user_private",
      text: "<https://example.test/oauth/jira|Connect your Jira account>",
    });
  });

  test("asks the user to connect GitHub before GitHub data requests", async () => {
    const response = await handleConversation(
      baseRequest,
      createDeps({ getConnection: () => null }),
    );

    expect(response.visibility).toBe("ephemeral");
    expect(response.text).toBe(
      "Connect GitHub first: `@Burble connect github`.",
    );
  });

  test("answers GitHub identity requests without leaking tokens", async () => {
    const response = await handleConversation(baseRequest, createDeps());

    expect(response.visibility).toBe("ephemeral");
    expect(response.text).toBe(
      "Authenticated to GitHub as `octocat` for Slack email person@example.com.",
    );
    expect(JSON.stringify(response)).not.toContain("secret-token");
  });

  test("answers assigned issue requests privately in channels", async () => {
    const response = await handleConversation(
      { ...baseRequest, text: "what issues are assigned to me?" },
      createDeps(),
    );

    expect(response.visibility).toBe("ephemeral");
    expect(response.text).toContain("Fix billing export");
  });

  test("answers pull request requests privately in channels", async () => {
    const response = await handleConversation(
      { ...baseRequest, text: "show my pull requests" },
      createDeps(),
    );

    expect(response.visibility).toBe("ephemeral");
    expect(response.text).toContain("Add workspace auth");
  });

  test("limits deterministic pull request responses when the user asks for a count", async () => {
    const response = await handleConversation(
      { ...baseRequest, text: "pull my latest 3 github PRs" },
      createDeps(),
    );

    expect(response.visibility).toBe("ephemeral");
    expect(response.text).toContain("Add workspace auth");
    expect(response.text).toContain("Improve cron delivery");
    expect(response.text).toContain("Wire provider bridge");
    expect(response.text).not.toContain("Update old runtime");
  });

  test("scopes deterministic pull request requests by organization and singular latest", async () => {
    const calls: unknown[] = [];
    const deps = createDeps();
    deps.tools.github = createGitHubTools({
      getGitHubUser: async () => ({ login: "octocat" }),
      listAssignedIssues: async () => [],
      searchIssues: async () => [],
      listMyPullRequests: async (_token, options) => {
        calls.push(options);
        return [
          {
            html_url: "https://github.com/example-org/burble/pull/3",
            title: "Discover provider tools through MCP",
          },
        ];
      },
    });

    const response = await handleConversation(
      { ...baseRequest, text: "what is my latest open PR in example-org org?" },
      deps,
    );

    expect(calls).toEqual([
      {
        limit: 1,
        state: "open",
        sort: "updated",
        order: "desc",
        owner: "example-org",
      },
    ]);
    expect(response.visibility).toBe("ephemeral");
    expect(response.text).toContain("Discover provider tools through MCP");
  });

  test("answers simple issue search requests privately in channels", async () => {
    const response = await handleConversation(
      { ...baseRequest, text: "search github issues for billing" },
      createDeps(),
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
        text: "what issues are assigned to me?",
      },
      createDeps(),
    );

    expect(response.visibility).toBe("public");
    expect(response.classification).toBe("user_private");
  });

  test("returns help for unknown deterministic requests", async () => {
    const response = await handleConversation(
      { ...baseRequest, text: "deploy the moon" },
      createDeps(),
    );

    expect(response).toMatchObject({
      visibility: "public",
      classification: "public",
    });
    expect(response.text).toContain("@Burble connect github");
  });

  test("delegates to the LLM runner when LLM mode is enabled", async () => {
    const calls: string[] = [];
    const response = await handleConversation(
      {
        ...baseRequest,
        text: "summarize my GitHub work",
        conversationRouteId: "convrt_abc123",
      },
      createDeps({
        agentMode: "llm",
        agentExecutionMode: "native-runtime",
        agentRunner: stubAgentRunner((input) => {
          calls.push(input.text);
          expect(input.executionMode).toBe("native-runtime");
          expect(input.principal).toEqual({
            workspaceId: "T123",
            slackUserId: "U123",
          });
          expect(input.conversation).toEqual({
            routeId: "convrt_abc123",
            source: "slack",
            workspaceId: "T123",
            channelId: "C123",
            rootId: "channel:C123:thread:1710000000.000100",
            isDirectMessage: false,
          });
          expect(input.toolGroups).toEqual({
            groups: ["conversation", "github"],
            reasons: ["default:conversation", "keyword:github:github"],
          });
          expect(input.connections.github?.providerLogin).toBe("octocat");
          expect(input.connections.jira?.providerLogin).toBe(
            "person@example.com",
          );
          return {
            classification: "user_private",
            text: "You have one issue and one pull request.",
          };
        }),
      }),
    );

    expect(calls).toEqual(["summarize my GitHub work"]);
    expect(response.visibility).toBe("ephemeral");
    expect(response.text).toBe("You have one issue and one pull request.");
  });

  test("keeps provider tool groups for follow-up turns with provider context", async () => {
    const response = await handleConversation(
      {
        ...baseRequest,
        text: "ok let's start with the 3 most recent companies",
        context: {
          recentMessages: [
            {
              author: "user",
              speaker: "Leo",
              text: "list our 3 most recent clients on hubspot?",
            },
            {
              author: "assistant",
              speaker: "Burble",
              text: "Do you mean the 3 most recent companies, contacts, or deals in HubSpot?",
            },
          ],
        },
      },
      createDeps({
        agentMode: "llm",
        agentRunner: stubAgentRunner((input) => {
          expect(input.toolGroups).toEqual({
            groups: ["conversation", "hubspot"],
            reasons: [
              "default:conversation",
              "context:hubspot:hubspot:companies",
            ],
          });
          return {
            classification: "user_private",
            text: "Here are the three most recent HubSpot companies.",
          };
        }),
      }),
    );

    expect(response.text).toBe(
      "Here are the three most recent HubSpot companies.",
    );
  });

  test("fast-paths latest Gmail requests before the LLM runner", async () => {
    let called = false;
    const response = await handleConversation(
      { ...baseRequest, text: "list latest email received via google mail" },
      createDeps({
        agentMode: "llm",
        agentFastTrack: true,
        agentRunner: stubAgentRunner(() => {
          called = true;
          return {
            classification: "public",
            text: "unexpected",
          };
        }),
      }),
    );

    expect(called).toBe(false);
    expect(response.visibility).toBe("ephemeral");
    expect(response.text).toContain("*Latest Gmail message:*");
    expect(response.text).toContain("Your OpenAI API account has been funded");
  });

  test("fast-paths latest edited Google Drive file requests before the LLM runner", async () => {
    let called = false;
    const response = await handleConversation(
      { ...baseRequest, text: "list my last edited google drive file" },
      createDeps({
        agentMode: "llm",
        agentFastTrack: true,
        agentRunner: stubAgentRunner(() => {
          called = true;
          return {
            classification: "public",
            text: "unexpected",
          };
        }),
      }),
    );

    expect(called).toBe(false);
    expect(response.visibility).toBe("ephemeral");
    expect(response.text).toBe(
      [
        "Last edited Google Drive file: <https://drive.google.com/file/d/drive-file-1/view|apelogic-ai-open-prs-last-24h-seen.txt>",
        "modified: 2026-06-21 19:02:13 UTC",
      ].join("\n"),
    );
  });

  test("fast-paths latest used Google Drive file requests before the LLM runner", async () => {
    let called = false;
    const response = await handleConversation(
      {
        ...baseRequest,
        text: "sorry, what is my latest used google drive file",
      },
      createDeps({
        agentMode: "llm",
        agentFastTrack: true,
        agentRunner: stubAgentRunner(() => {
          called = true;
          return {
            classification: "public",
            text: "unexpected",
          };
        }),
      }),
    );

    expect(called).toBe(false);
    expect(response.visibility).toBe("ephemeral");
    expect(response.text).toContain("apelogic-ai-open-prs-last-24h-seen.txt");
  });

  test("fast-paths latest accessed Google Drive file requests before the LLM runner", async () => {
    let called = false;
    const response = await handleConversation(
      {
        ...baseRequest,
        text: "what is my latest accessed google drive file",
      },
      createDeps({
        agentMode: "llm",
        agentFastTrack: true,
        agentRunner: stubAgentRunner(() => {
          called = true;
          return {
            classification: "public",
            text: "unexpected",
          };
        }),
      }),
    );

    expect(called).toBe(false);
    expect(response.visibility).toBe("ephemeral");
    expect(response.text).toContain("apelogic-ai-open-prs-last-24h-seen.txt");
  });

  test("fast-paths last-created Jira ticket requests before the LLM runner", async () => {
    let called = false;
    const response = await handleConversation(
      { ...baseRequest, text: "what is my last created jira ticket?" },
      createDeps({
        agentMode: "llm",
        agentFastTrack: true,
        agentRunner: stubAgentRunner(() => {
          called = true;
          return {
            classification: "public",
            text: "unexpected",
          };
        }),
      }),
    );

    expect(called).toBe(false);
    expect(response.visibility).toBe("ephemeral");
    expect(response.text).toBe(
      "Your last created Jira ticket: <https://jira.example/browse/DM-13|DM-13 - hello from slack>",
    );
  });

  test("fast-paths latest assigned Jira ticket requests before the LLM runner", async () => {
    let called = false;
    const response = await handleConversation(
      { ...baseRequest, text: "what is latest jira ticket assigned to me?" },
      createDeps({
        agentMode: "llm",
        agentFastTrack: true,
        agentRunner: stubAgentRunner(() => {
          called = true;
          return {
            classification: "public",
            text: "unexpected",
          };
        }),
      }),
    );

    expect(called).toBe(false);
    expect(response.visibility).toBe("ephemeral");
    expect(response.text).toBe(
      "Your latest assigned Jira ticket: <https://jira.example/browse/DM-12|DM-12 - test task ticket #9 from slack>",
    );
  });

  test("forwards LLM runner events before returning the final response", async () => {
    const events: AgentRunEvent[] = [];
    const response = await handleConversation(
      {
        ...baseRequest,
        text: "summarize my GitHub work",
        isDirectMessage: true,
      },
      createDeps({
        agentMode: "llm",
        agentRunner: stubAgentRunner([
          { type: "status", text: "Preparing runtime..." },
          {
            type: "tool_call",
            toolName: "github_list_assigned_issues",
            callId: "call-1",
          },
          {
            type: "final",
            response: {
              classification: "user_private",
              text: "One issue needs attention.",
            },
          },
        ]),
        onAgentEvent: (event) => {
          events.push(event);
        },
      }),
    );

    expect(response.text).toBe("One issue needs attention.");
    expect(events).toEqual([
      { type: "status", text: "Preparing runtime..." },
      {
        type: "tool_call",
        toolName: "github_list_assigned_issues",
        callId: "call-1",
      },
    ]);
  });

  test("emits observability events around a successful conversation", async () => {
    const observabilityEvents: ObservabilityEventInput[] = [];
    const response = await handleConversation(
      { ...baseRequest, text: "hello", isDirectMessage: true },
      createDeps({
        traceId: "trace-1",
        observability: {
          emit: (event) => {
            observabilityEvents.push(event);
          },
        },
        agentMode: "llm",
        agentRunner: stubAgentRunner(() => ({
          classification: "public",
          text: "Hello.",
        })),
      }),
    );

    expect(response.text).toBe("Hello.");
    expect(observabilityEvents.map((event) => event.name)).toEqual([
      "conversation.request.started",
      "conversation.response.completed",
    ]);
    expect(observabilityEvents.map((event) => event.traceId)).toEqual([
      "trace-1",
      "trace-1",
    ]);
    expect(observabilityEvents[0]).toMatchObject({
      workspaceId: "T123",
      principalId: "T123:U123",
      sessionId: "1710000000.000100",
      attributes: {
        source: "slack",
        isDirectMessage: true,
        textLength: 5,
        attachmentCount: 0,
        agentMode: "llm",
        fastTrackEnabled: false,
        hasAgentRunner: true,
        toolGroups: ["conversation"],
        toolGroupReasons: ["default:conversation"],
      },
      content: {
        text: "hello",
      },
    });
    expect(observabilityEvents[1]).toMatchObject({
      classification: "public",
      status: "ok",
      attributes: {
        visibility: "public",
        textLength: 6,
      },
      content: {
        text: "Hello.",
      },
    });
  });

  test("emits observability events for agent tool calls and usage", async () => {
    const observabilityEvents: ObservabilityEventInput[] = [];
    const response = await handleConversation(
      {
        ...baseRequest,
        text: "summarize my GitHub work",
        isDirectMessage: true,
      },
      createDeps({
        traceId: "trace-tools",
        observability: {
          emit: (event) => {
            observabilityEvents.push(event);
          },
        },
        agentMode: "llm",
        agentRunner: stubAgentRunner([
          { type: "status", text: "Preparing runtime..." },
          {
            type: "tool_call",
            toolName: "github_list_my_pull_requests",
            callId: "call-1",
          },
          {
            type: "tool_result",
            toolName: "github_list_my_pull_requests",
            callId: "call-1",
            classification: "user_private",
          },
          {
            type: "final",
            response: {
              classification: "user_private",
              text: "One PR needs review.",
              usage: {
                inputTokens: 10,
                outputTokens: 5,
                totalTokens: 15,
              },
            },
          },
        ]),
      }),
    );

    expect(response.text).toBe("One PR needs review.");
    expect(observabilityEvents.map((event) => event.name)).toEqual([
      "conversation.request.started",
      "agent.status",
      "tool.call.started",
      "tool.call.completed",
      "conversation.response.completed",
    ]);
    expect(observabilityEvents.map((event) => event.traceId)).toEqual([
      "trace-tools",
      "trace-tools",
      "trace-tools",
      "trace-tools",
      "trace-tools",
    ]);
    expect(observabilityEvents[1]).toMatchObject({
      name: "agent.status",
      attributes: {
        text: "Preparing runtime...",
      },
    });
    expect(observabilityEvents[2]).toMatchObject({
      name: "tool.call.started",
      toolName: "github_list_my_pull_requests",
      callId: "call-1",
    });
    expect(observabilityEvents[3]).toMatchObject({
      name: "tool.call.completed",
      toolName: "github_list_my_pull_requests",
      callId: "call-1",
      classification: "user_private",
      status: "ok",
    });
    expect(observabilityEvents[4]).toMatchObject({
      name: "conversation.response.completed",
      classification: "user_private",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      },
    });
  });

  test("keeps LLM responses public when they are not provider-backed", async () => {
    const response = await handleConversation(
      { ...baseRequest, text: "what can you do?" },
      createDeps({
        agentMode: "llm",
        agentRunner: stubAgentRunner(() => ({
          classification: "public",
          text: "I can help with GitHub work once connected.",
        })),
      }),
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
            text: "unexpected",
          };
        }),
      }),
    );

    expect(called).toBe(false);
    expect(response.text).toBe(
      "<https://example.test/oauth/github|Connect your GitHub account>",
    );
  });

  test("delegates deterministic GitHub-shaped requests to the LLM runner by default", async () => {
    let calledWith = "";
    const response = await handleConversation(
      { ...baseRequest, text: "show my pull requests" },
      createDeps({
        agentMode: "llm",
        agentRunner: stubAgentRunner((input) => {
          calledWith = input.text;
          return {
            classification: "user_private",
            text: "Agent listed pull requests.",
          };
        }),
      }),
    );

    expect(calledWith).toBe("show my pull requests");
    expect(response.visibility).toBe("ephemeral");
    expect(response.text).toBe("Agent listed pull requests.");
  });

  test("does not call the LLM runner for deterministic GitHub requests when fast-track is enabled", async () => {
    let called = false;
    const response = await handleConversation(
      { ...baseRequest, text: "show my pull requests" },
      createDeps({
        agentMode: "llm",
        agentFastTrack: true,
        agentRunner: stubAgentRunner(() => {
          called = true;
          return {
            classification: "public",
            text: "unexpected",
          };
        }),
      }),
    );

    expect(called).toBe(false);
    expect(response.visibility).toBe("ephemeral");
    expect(response.text).toContain("Add workspace auth");
  });

  test("delegates scheduled provider requests to the agent before GitHub fast-paths", async () => {
    const calls: string[] = [];
    const response = await handleConversation(
      {
        ...baseRequest,
        text: "create a one-shot cron job to list my open GitHub PRs and post the result here in 2 minutes",
      },
      createDeps({
        agentMode: "llm",
        agentRunner: stubAgentRunner((input) => {
          calls.push(input.text);
          return {
            classification: "public",
            text: "Created scheduled job.",
          };
        }),
      }),
    );

    expect(calls).toEqual([
      "create a one-shot cron job to list my open GitHub PRs and post the result here in 2 minutes",
    ]);
    expect(response.text).toBe("Created scheduled job.");
  });

  test("delegates GitHub reviewer mutations to the agent before PR fast-paths", async () => {
    const calls: string[] = [];
    const response = await handleConversation(
      {
        ...baseRequest,
        text: "add zer0tweets as reviewer for that Discover provider tools through MCP PR",
      },
      createDeps({
        agentMode: "llm",
        agentRunner: stubAgentRunner((input) => {
          calls.push(input.text);
          return {
            classification: "user_private",
            text: "Requested review.",
          };
        }),
      }),
    );

    expect(calls).toEqual([
      "add zer0tweets as reviewer for that Discover provider tools through MCP PR",
    ]);
    expect(response.text).toBe("Requested review.");
  });

  test("delegates PR description edits to the agent before PR fast-paths", async () => {
    const calls: string[] = [];
    const text =
      "delete last line at the end of Discover provider tools through MCP PR description that reads Line added by Burble";
    const response = await handleConversation(
      {
        ...baseRequest,
        text,
      },
      createDeps({
        agentMode: "llm",
        agentRunner: stubAgentRunner((input) => {
          calls.push(input.text);
          return {
            classification: "user_private",
            text: "Updated PR description.",
          };
        }),
      }),
    );

    expect(calls).toEqual([text]);
    expect(response.text).toBe("Updated PR description.");
  });

  test("delegates cron and job requests to the agent before GitHub fast-paths", async () => {
    for (const text of [
      "set recurring cron job to pull my latest 3 github PRs",
      "set a job to pull my latest 3 github PRs",
    ]) {
      let calledWith = "";
      const response = await handleConversation(
        { ...baseRequest, text },
        createDeps({
          agentMode: "llm",
          agentRunner: stubAgentRunner((input) => {
            calledWith = input.text;
            return {
              classification: "public",
              text: "Agent scheduled it.",
            };
          }),
        }),
      );

      expect(calledWith).toBe(text);
      expect(response.text).toBe("Agent scheduled it.");
    }
  });

  test("creates scheduled jobs from scheduler resolver output", async () => {
    let called = false;
    const created: unknown[] = [];
    const response = await handleConversation(
      {
        ...baseRequest,
        conversationRouteId: "convrt_123",
        text: "create hourly cron job to look for latest AI news, summarize them in one paragraph and post result in this channel",
      },
      createDeps({
        agentMode: "llm",
        agentRuntimeEngine: "hermes",
        schedulerIntentResolver: async () => ({
          intent: "create_job",
          confidence: 0.96,
          jobId: null,
          create: {
            title: "Hourly AI news summary",
            prompt: "look for latest AI news, summarize them in one paragraph",
            schedule: {
              kind: "cron",
              expression: "0 * * * *",
              timezone: "UTC",
            },
          },
        }),
        schedulerControl: {
          listJobs: () => [],
          createJob: (input) => {
            created.push(input);
            return {
              ok: true,
              job: {
                jobId: "job-ai-news-hourly",
                workspaceId: input.workspaceId,
                slackUserId: input.slackUserId,
                title: input.title,
                prompt: input.prompt,
                schedule: input.schedule,
                routeId: input.routeId ?? null,
                state: "scheduled",
                runtimeType: input.runtimeType ?? null,
                createdAt: "2026-06-25T17:14:00.000Z",
                updatedAt: "2026-06-25T17:14:00.000Z",
              },
            };
          },
        },
        agentRunner: stubAgentRunner(() => {
          called = true;
          return {
            classification: "public",
            text: "unexpected",
          };
        }),
      }),
    );

    expect(called).toBe(false);
    expect(created).toEqual([
      {
        workspaceId: "T123",
        slackUserId: "U123",
        title: "Hourly AI news summary",
        prompt: "look for latest AI news, summarize them in one paragraph",
        schedule: { kind: "cron", expression: "0 * * * *", timezone: "UTC" },
        routeId: "convrt_123",
        runtimeType: "hermes",
      },
    ]);
    expect(response.visibility).toBe("ephemeral");
    expect(response.classification).toBe("user_private");
    expect(response.text).toContain(
      "Created scheduled job job-ai-news-hourly.",
    );
    expect(response.text).toContain("Hourly AI news summary");
    expect(response.text).toContain("schedule: `cron 0 * * * * (UTC)`");
    expect(response.text).toContain("runtime: hermes");
    expect(response.text).toContain("delivery: this conversation");
  });

  test("does not treat one-shot report requests as unresolved scheduled task creates", async () => {
    let called = false;
    const response = await handleConversation(
      {
        ...baseRequest,
        text: "Run a Google Analytics report for activeUsers for the last 7 days",
      },
      createDeps({
        agentMode: "llm",
        schedulerControl: {
          listJobs: () => [],
          createJob: () => {
            throw new Error("unexpected create");
          },
        },
        schedulerIntentResolver: async () => ({
          intent: "create_job",
          confidence: 0.91,
          jobId: null,
        }),
        agentRunner: stubAgentRunner((input) => {
          called = true;
          expect(input.text).toBe(
            "Run a Google Analytics report for activeUsers for the last 7 days",
          );
          return {
            classification: "user_private",
            text: "Agent handled the one-shot report.",
          };
        }),
      }),
    );

    expect(called).toBe(true);
    expect(response.text).toBe("Agent handled the one-shot report.");
  });

  test("normalizes scheduled job runtime for scheduler resolver output", async () => {
    const cases = [
      {
        text: "add scheduled cron job, to be run every hour, to look for new open PRs in https://github.com/apelogic-ai github org and report back to this channel",
        title: "Hourly open PRs for apelogic-ai",
        prompt:
          "look for new open PRs in https://github.com/apelogic-ai github org",
        schedule: { kind: "cron", expression: "0 * * * *", timezone: "UTC" },
      },
      {
        text: "add new job to be run every 15 min to check new open PRs in https://github.com/apelogic-ai github org, report back to this channel",
        title: "Scheduled open PRs for apelogic-ai",
        prompt:
          "check new open PRs in https://github.com/apelogic-ai github org",
        schedule: { kind: "cron", expression: "*/15 * * * *", timezone: "UTC" },
      },
    ] as const;

    for (const testCase of cases) {
      let called = false;
      const created: unknown[] = [];
      const response = await handleConversation(
        {
          ...baseRequest,
          conversationRouteId: "convrt_123",
          text: testCase.text,
        },
        createDeps({
          agentMode: "llm",
          agentRuntimeEngine: "openclaw-gateway",
          schedulerRuntimeEngine: "hermes",
          schedulerIntentResolver: async () => ({
            intent: "create_job",
            confidence: 0.96,
            jobId: null,
            create: {
              title: testCase.title,
              prompt: testCase.prompt,
              schedule: testCase.schedule,
            },
          }),
          schedulerControl: {
            listJobs: () => [],
            createJob: (input) => {
              created.push(input);
              return {
                ok: true,
                job: {
                  jobId: "job-github-prs-hourly",
                  workspaceId: input.workspaceId,
                  slackUserId: input.slackUserId,
                  title: input.title,
                  prompt: input.prompt,
                  schedule: input.schedule,
                  routeId: input.routeId ?? null,
                  state: "scheduled",
                  runtimeType: input.runtimeType ?? null,
                  createdAt: "2026-06-26T17:00:45.158Z",
                  updatedAt: "2026-06-26T17:00:45.158Z",
                },
              };
            },
          },
          agentRunner: stubAgentRunner(() => {
            called = true;
            return {
              classification: "public",
              text: "unexpected",
            };
          }),
        }),
      );

      expect(called).toBe(false);
      expect(created).toEqual([
        {
          workspaceId: "T123",
          slackUserId: "U123",
          title: testCase.title,
          prompt: testCase.prompt,
          schedule: testCase.schedule,
          routeId: "convrt_123",
          runtimeType: "hermes",
        },
      ]);
      expect(response.text).toContain("runtime: hermes");
    }
  });

  test("stores executable task text separately from schedule and delivery", async () => {
    const created: unknown[] = [];
    const response = await handleConversation(
      {
        ...baseRequest,
        conversationRouteId: "convrt_heart",
        text: "add scheduled job to output heart emoji every 15 min, to this channel",
      },
      createDeps({
        agentMode: "llm",
        schedulerRuntimeEngine: "hermes",
        schedulerIntentResolver: async () => ({
          intent: "create_job",
          confidence: 0.96,
          jobId: null,
          create: {
            title: "Scheduled heart emoji",
            prompt: "Post exactly this message: ❤️",
            schedule: {
              kind: "cron",
              expression: "*/15 * * * *",
              timezone: "UTC",
            },
          },
        }),
        schedulerControl: {
          listJobs: () => [],
          createJob: (input) => {
            created.push(input);
            return {
              ok: true,
              job: {
                jobId: "job-heart",
                workspaceId: input.workspaceId,
                slackUserId: input.slackUserId,
                title: input.title,
                prompt: input.prompt,
                schedule: input.schedule,
                routeId: input.routeId ?? null,
                state: "scheduled",
                runtimeType: input.runtimeType ?? null,
                createdAt: "2026-06-27T01:10:52.803Z",
                updatedAt: "2026-06-27T01:10:52.803Z",
              },
            };
          },
        },
      }),
    );

    expect(created).toEqual([
      {
        workspaceId: "T123",
        slackUserId: "U123",
        title: "Scheduled heart emoji",
        prompt: "Post exactly this message: ❤️",
        schedule: { kind: "cron", expression: "*/15 * * * *", timezone: "UTC" },
        routeId: "convrt_heart",
        runtimeType: "hermes",
      },
    ]);
    expect(response.text).toContain("schedule: `cron */15 * * * * (UTC)`");
    expect(response.text).toContain("delivery: this conversation");
  });

  test("creates scheduler tasks from semantic resolver output without invoking the runtime", async () => {
    let called = false;
    const created: unknown[] = [];
    const response = await handleConversation(
      {
        ...baseRequest,
        conversationRouteId: "convrt_heart",
        text: "create new task to send heart emoji to this channel every 30 min",
      },
      createDeps({
        agentMode: "llm",
        agentRuntimeEngine: "hermes",
        schedulerControl: {
          listJobs: () => [],
          createJob: (input) => {
            created.push(input);
            return {
              ok: true,
              job: {
                jobId: "job-heart-30m",
                workspaceId: input.workspaceId,
                slackUserId: input.slackUserId,
                title: input.title,
                prompt: input.prompt,
                schedule: input.schedule,
                routeId: input.routeId ?? null,
                state: "scheduled",
                runtimeType: input.runtimeType ?? null,
                createdAt: "2026-06-27T17:34:21.452Z",
                updatedAt: "2026-06-27T17:34:21.452Z",
              },
            };
          },
        },
        schedulerIntentResolver: async () => ({
          intent: "create_job",
          confidence: 0.96,
          jobId: null,
          create: {
            title: "Heart emoji every 30 min",
            prompt: "Post exactly this message: ❤️",
            schedule: {
              kind: "cron",
              expression: "*/30 * * * *",
              timezone: "UTC",
            },
          },
        }),
        agentRunner: stubAgentRunner(() => {
          called = true;
          return {
            classification: "public",
            text: "unexpected",
          };
        }),
      }),
    );

    expect(called).toBe(false);
    expect(created).toEqual([
      {
        workspaceId: "T123",
        slackUserId: "U123",
        title: "Heart emoji every 30 min",
        prompt: "Post exactly this message: ❤️",
        schedule: { kind: "cron", expression: "*/30 * * * *", timezone: "UTC" },
        routeId: "convrt_heart",
        runtimeType: "hermes",
      },
    ]);
    expect(response.visibility).toBe("ephemeral");
    expect(response.text).toContain("Created scheduled job job-heart-30m.");
  });

  test("does not delegate unresolved semantic scheduler create intents to the runtime", async () => {
    let called = false;
    const response = await handleConversation(
      {
        ...baseRequest,
        conversationRouteId: "convrt_heart",
        text: "create a task to send a heart sometimes",
      },
      createDeps({
        agentMode: "llm",
        schedulerControl: {
          listJobs: () => [],
          createJob: () => {
            throw new Error("unexpected create");
          },
        },
        schedulerIntentResolver: async () => ({
          intent: "create_job",
          confidence: 0.91,
          jobId: null,
        }),
        agentRunner: stubAgentRunner(() => {
          called = true;
          return {
            classification: "public",
            text: "unexpected",
          };
        }),
      }),
    );

    expect(called).toBe(false);
    expect(response.visibility).toBe("ephemeral");
    expect(response.text).toContain("I can’t create that scheduled task yet");
  });

  test("strips resolver-leaked delivery clauses from scheduler task prompts", async () => {
    const created: unknown[] = [];
    await handleConversation(
      {
        ...baseRequest,
        conversationRouteId: "convrt_ai_news",
        text: "create hourly task to look for latest AI news, summarize in one paragraph, and post result in this channel",
      },
      createDeps({
        agentMode: "llm",
        schedulerControl: {
          listJobs: () => [],
          createJob: (input) => {
            created.push(input);
            return {
              ok: true,
              job: {
                jobId: "job-ai-news",
                workspaceId: input.workspaceId,
                slackUserId: input.slackUserId,
                title: input.title,
                prompt: input.prompt,
                schedule: input.schedule,
                routeId: input.routeId ?? null,
                state: "scheduled",
                runtimeType: input.runtimeType ?? null,
                createdAt: "2026-06-27T17:34:21.452Z",
                updatedAt: "2026-06-27T17:34:21.452Z",
              },
            };
          },
        },
        schedulerIntentResolver: async () => ({
          intent: "create_job",
          confidence: 0.94,
          jobId: null,
          create: {
            title: "Hourly AI news summary",
            prompt:
              "Look for the latest AI news, summarize it in one paragraph, and post the result",
            schedule: {
              kind: "cron",
              expression: "0 * * * *",
              timezone: "UTC",
            },
          },
        }),
      }),
    );

    expect(created).toEqual([
      {
        workspaceId: "T123",
        slackUserId: "U123",
        title: "Hourly AI news summary",
        prompt: "Look for the latest AI news, summarize it in one paragraph",
        schedule: { kind: "cron", expression: "0 * * * *", timezone: "UTC" },
        routeId: "convrt_ai_news",
        runtimeType: null,
      },
    ]);
  });

  test("updates an existing scheduler task schedule from semantic resolver output", async () => {
    let called = false;
    let created = false;
    const updates: unknown[] = [];
    const response = await handleConversation(
      {
        ...baseRequest,
        conversationRouteId: "convrt_heart",
        text: "modify heart emoji job to run every 45 min",
      },
      createDeps({
        agentMode: "llm",
        agentRuntimeEngine: "hermes",
        schedulerControl: {
          listJobs: () => [
            {
              jobId: "job_heart",
              title: "Heart emoji every 30 min",
              prompt: "Post exactly this message: ❤️",
              schedule: {
                kind: "cron",
                expression: "*/30 * * * *",
                timezone: "UTC",
              },
              state: "scheduled",
              runtimeType: "hermes",
              requiredTools: [],
              routeId: "convrt_heart",
              updatedAt: "2026-06-27T17:39:00.000Z",
            },
          ],
          createJob: () => {
            created = true;
            throw new Error("unexpected create");
          },
          updateJobSchedule: (input) => {
            updates.push(input);
            return {
              ok: true,
              job: {
                jobId: "job_heart",
                workspaceId: input.workspaceId,
                slackUserId: input.slackUserId,
                title: "Heart emoji every 30 min",
                prompt: "Post exactly this message: ❤️",
                schedule: input.schedule,
                routeId: "convrt_heart",
                state: "scheduled",
                runtimeType: "hermes",
                createdAt: "2026-06-27T17:39:00.000Z",
                updatedAt: "2026-06-27T17:40:00.000Z",
              },
            };
          },
        },
        schedulerIntentResolver: async () => ({
          intent: "update_job_schedule",
          confidence: 0.96,
          jobId: "job_heart",
          schedule: {
            kind: "cron",
            expression: "*/45 * * * *",
            timezone: "UTC",
          },
        }),
        agentRunner: stubAgentRunner(() => {
          called = true;
          return {
            classification: "public",
            text: "unexpected",
          };
        }),
      }),
    );

    expect(called).toBe(false);
    expect(created).toBe(false);
    expect(updates).toEqual([
      {
        workspaceId: "T123",
        slackUserId: "U123",
        jobId: "job_heart",
        schedule: { kind: "cron", expression: "*/45 * * * *", timezone: "UTC" },
      },
    ]);
    expect(response.text).toContain(
      "Updated scheduled job job_heart schedule.",
    );
    expect(response.text).toContain("`cron */45 * * * * (UTC)`");
  });

  test("updates an existing scheduler task prompt from semantic resolver output", async () => {
    let called = false;
    let created = false;
    const updates: unknown[] = [];
    const response = await handleConversation(
      {
        ...baseRequest,
        conversationRouteId: "convrt_heart",
        text: "modify the emoji job to send 2 hearts instead of one",
      },
      createDeps({
        agentMode: "llm",
        agentRuntimeEngine: "hermes",
        schedulerControl: {
          listJobs: () => [
            {
              jobId: "job_heart",
              title: "Heart emoji every 30 min",
              prompt: "Post exactly this message: ❤️",
              schedule: {
                kind: "cron",
                expression: "*/30 * * * *",
                timezone: "UTC",
              },
              state: "scheduled",
              runtimeType: "hermes",
              requiredTools: [],
              routeId: "convrt_heart",
              updatedAt: "2026-06-27T17:39:00.000Z",
            },
            {
              jobId: "job_ai_news",
              title: "Hourly AI news summary",
              prompt: "look for fresh AI-related news",
              schedule: {
                kind: "cron",
                expression: "0 * * * *",
                timezone: "UTC",
              },
              state: "scheduled",
              runtimeType: "openclaw",
              requiredTools: ["web_search"],
              routeId: "convrt_news",
              updatedAt: "2026-06-27T17:39:00.000Z",
            },
          ],
          createJob: () => {
            created = true;
            throw new Error("unexpected create");
          },
          updateJobPrompt: (input) => {
            updates.push(input);
            return {
              ok: true,
              job: {
                jobId: "job_heart",
                workspaceId: input.workspaceId,
                slackUserId: input.slackUserId,
                title: "Heart emoji every 30 min",
                prompt: input.prompt,
                schedule: {
                  kind: "cron",
                  expression: "*/30 * * * *",
                  timezone: "UTC",
                },
                routeId: "convrt_heart",
                state: "scheduled",
                runtimeType: "hermes",
                createdAt: "2026-06-27T17:39:00.000Z",
                updatedAt: "2026-06-27T17:40:00.000Z",
              },
            };
          },
        },
        schedulerIntentResolver: async (input) => {
          expect(input.jobs).toHaveLength(2);
          return {
            intent: "update_job_prompt",
            confidence: 0.96,
            jobId: "job_heart",
            prompt: "Post exactly this message: ❤️❤️",
          };
        },
        agentRunner: stubAgentRunner(() => {
          called = true;
          return {
            classification: "public",
            text: "unexpected",
          };
        }),
      }),
    );

    expect(called).toBe(false);
    expect(created).toBe(false);
    expect(updates).toEqual([
      {
        workspaceId: "T123",
        slackUserId: "U123",
        jobId: "job_heart",
        prompt: "Post exactly this message: ❤️❤️",
      },
    ]);
    expect(response.text).toContain("Updated scheduled job job_heart task.");
    expect(response.text).toContain("Post exactly this message: ❤️❤️");
  });

  test("updates scheduled job delivery from scheduler resolver output", async () => {
    let called = false;
    const updates: unknown[] = [];
    const response = await handleConversation(
      {
        ...baseRequest,
        text: "modify task to post in <#CNEWS|ai-news> channel instead of the current one",
      },
      createDeps({
        agentMode: "llm",
        schedulerIntentResolver: async () => ({
          intent: "update_job_delivery",
          confidence: 0.96,
          jobId: null,
        }),
        schedulerControl: {
          listJobs: () => [
            {
              jobId: "job-ai-news-hourly",
              title: "Hourly AI news summary",
              prompt: "look for fresh AI-related news and post a short summary",
              schedule: { kind: "interval", every: { hours: 1 } },
              state: "scheduled",
              runtimeType: "openclaw",
              requiredTools: [],
              routeId: "convrt_old",
              updatedAt: "2026-06-25T17:14:00.000Z",
            },
          ],
          updateJobDelivery: (input) => {
            updates.push(input);
            return {
              ok: true,
              routeId: "convrt_news",
              job: {
                jobId: "job-ai-news-hourly",
                workspaceId: input.workspaceId,
                slackUserId: input.slackUserId,
                title: "Hourly AI news summary",
                prompt:
                  "look for fresh AI-related news and post a short summary",
                schedule: { kind: "interval", every: { hours: 1 } },
                routeId: "convrt_news",
                state: "scheduled",
                runtimeType: "openclaw",
                createdAt: "2026-06-25T17:14:00.000Z",
                updatedAt: "2026-06-25T17:20:00.000Z",
              },
            };
          },
        },
        agentRunner: stubAgentRunner(() => {
          called = true;
          return {
            classification: "public",
            text: "unexpected",
          };
        }),
      }),
    );

    expect(called).toBe(false);
    expect(updates).toEqual([
      {
        workspaceId: "T123",
        slackUserId: "U123",
        jobId: null,
        routeId: null,
        channelId: "CNEWS",
        channelName: "ai-news",
      },
    ]);
    expect(response.visibility).toBe("ephemeral");
    expect(response.text).toContain(
      "Updated scheduled job job-ai-news-hourly delivery.",
    );
  });

  test("keeps unresolved scheduled job delivery updates in scheduler control after resolver intent", async () => {
    let called = false;
    const response = await handleConversation(
      {
        ...baseRequest,
        text: "modify task to post in #ai-news channel instead of the current one",
      },
      createDeps({
        agentMode: "llm",
        schedulerIntentResolver: async () => ({
          intent: "update_job_delivery",
          confidence: 0.96,
          jobId: null,
        }),
        schedulerControl: {
          listJobs: () => [
            {
              jobId: "job-ai-news-hourly",
              title: "Hourly AI news summary",
              prompt: "look for fresh AI-related news and post a short summary",
              schedule: { kind: "interval", every: { hours: 1 } },
              state: "scheduled",
              runtimeType: "openclaw",
              requiredTools: [],
              routeId: "convrt_old",
              updatedAt: "2026-06-25T17:14:00.000Z",
            },
          ],
          updateJobDelivery: (input) => ({
            ok: false,
            reason: "unresolved_channel",
            channelName: input.channelName ?? null,
            jobs: [],
          }),
        },
        agentRunner: stubAgentRunner(() => {
          called = true;
          return {
            classification: "public",
            text: "unexpected",
          };
        }),
      }),
    );

    expect(called).toBe(false);
    expect(response.visibility).toBe("ephemeral");
    expect(response.text).toContain("I can’t resolve `#ai-news`");
  });

  test("lists scheduled task specs from scheduler resolver intent", async () => {
    const texts = [
      "do we have any cron jobs configured?",
      "show me current cron jobs",
      "cron job",
      "please show me the configured scheduled jobs",
      "list our existing cronjobs",
      "what cron jobs are set up?",
      "list tasks",
    ];

    for (const text of texts) {
      let called = false;
      const response = await handleConversation(
        {
          ...baseRequest,
          text,
        },
        createDeps({
          agentMode: "llm",
          schedulerIntentResolver: async () => ({
            intent: "list_jobs",
            confidence: 0.96,
            jobId: null,
          }),
          schedulerControl: {
            listJobs: () => [
              {
                jobId: "ai-news-hourly",
                title: "Hourly AI news summary",
                prompt:
                  "look for fresh AI-related news and post a short summary",
                schedule: {
                  kind: "interval",
                  every: { hours: 1 },
                },
                state: "scheduled",
                runtimeType: "hermes",
                requiredTools: ["google_search_drive_files"],
                routeId: "convrt_123",
                updatedAt: "2026-06-24T12:00:00.000Z",
              },
            ],
          },
          agentRunner: stubAgentRunner(() => {
            called = true;
            return {
              classification: "public",
              text: "unexpected",
            };
          }),
        }),
      );

      expect(called).toBe(false);
      expect(response.visibility).toBe("ephemeral");
      expect(response.classification).toBe("user_private");
      expect(response.text).toContain("Scheduled tasks");
      expect(response.text).toContain("ai-news-hourly");
      expect(response.text).toContain("Hourly AI news summary");
      expect(response.text).toContain("state: scheduled");
      expect(response.text).toContain("google_search_drive_files");
    }
  });

  test("validates scheduled task specs from scheduler resolver intent", async () => {
    let called = false;
    const response = await handleConversation(
      {
        ...baseRequest,
        text: "validate task job_github_checker",
      },
      createDeps({
        agentMode: "llm",
        schedulerIntentResolver: async () => ({
          intent: "validate_task",
          confidence: 0.96,
          jobId: "job_github_checker",
        }),
        schedulerControl: {
          listJobs: () => [],
          validateTask: (input) => {
            expect(input).toEqual({
              workspaceId: "T123",
              slackUserId: "U123",
              taskId: "job_github_checker",
            });
            return {
              ok: true,
              taskId: "job_github_checker",
              validation: {
                ok: false,
                expectedTools: ["github_search_issues"],
                grantedTools: ["github_list_my_pull_requests"],
                errors: [
                  {
                    code: "missing_required_tool",
                    message:
                      "Task requires github_search_issues but the grant does not include it.",
                    tool: "github_search_issues",
                  },
                ],
                warnings: [
                  {
                    code: "wrong_github_pr_scope",
                    message:
                      "github_list_my_pull_requests only lists the authenticated user's PRs; org-wide PR monitoring needs github_search_issues.",
                    tool: "github_list_my_pull_requests",
                    expectedTool: "github_search_issues",
                  },
                ],
              },
            };
          },
        },
        agentRunner: stubAgentRunner(() => {
          called = true;
          return {
            classification: "public",
            text: "unexpected",
          };
        }),
      }),
    );

    expect(called).toBe(false);
    expect(response.visibility).toBe("ephemeral");
    expect(response.classification).toBe("user_private");
    expect(response.text).toContain("Task validation failed");
    expect(response.text).toContain("job_github_checker");
    expect(response.text).toContain("missing_required_tool");
    expect(response.text).toContain("wrong_github_pr_scope");
  });

  test("shows scheduled task details from scheduler resolver intent", async () => {
    let called = false;
    const response = await handleConversation(
      {
        ...baseRequest,
        text: "show task job_github_checker",
      },
      createDeps({
        agentMode: "llm",
        schedulerIntentResolver: async () => ({
          intent: "show_task",
          confidence: 0.96,
          jobId: "job_github_checker",
        }),
        schedulerControl: {
          listJobs: () => [],
          showTask: (input) => {
            expect(input).toEqual({
              workspaceId: "T123",
              slackUserId: "U123",
              taskId: "job_github_checker",
            });
            return {
              ok: true,
              task: {
                taskId: "job_github_checker",
                jobId: "job_github_checker",
                title: "Open PR monitor",
                prompt:
                  "check for new open PRs in https://github.com/apelogic-ai github org",
                schedule: {
                  kind: "interval",
                  every: { minutes: 15 },
                },
                state: "scheduled",
                runtimeType: "hermes",
                requiredTools: ["github_list_my_pull_requests"],
                routeId: "convrt_123",
                updatedAt: "2026-06-24T12:00:00.000Z",
              },
              validation: {
                ok: false,
                expectedTools: ["github_search_issues"],
                grantedTools: ["github_list_my_pull_requests"],
                errors: [
                  {
                    code: "missing_required_tool",
                    message:
                      "Task requires github_search_issues but the grant does not include it.",
                    tool: "github_search_issues",
                  },
                ],
                warnings: [],
              },
            };
          },
        },
        agentRunner: stubAgentRunner(() => {
          called = true;
          return {
            classification: "public",
            text: "unexpected",
          };
        }),
      }),
    );

    expect(called).toBe(false);
    expect(response.visibility).toBe("ephemeral");
    expect(response.classification).toBe("user_private");
    expect(response.text).toContain("Scheduled task");
    expect(response.text).toContain("job_github_checker");
    expect(response.text).toContain("Open PR monitor");
    expect(response.text).toContain("github_list_my_pull_requests");
    expect(response.text).toContain("github_search_issues");
    expect(response.text).toContain("validation: failed");
  });

  test("lists job runs from scheduler resolver intent", async () => {
    let called = false;
    const response = await handleConversation(
      {
        ...baseRequest,
        text: "list jobs",
      },
      createDeps({
        agentMode: "llm",
        schedulerIntentResolver: async () => ({
          intent: "list_job_runs",
          confidence: 0.96,
          jobId: null,
        }),
        schedulerControl: {
          listJobs: () => [
            {
              jobId: "job_ai_news",
              title: "Hourly AI news summary",
              prompt: "look for fresh AI-related news",
              schedule: {
                kind: "interval",
                every: { hours: 1 },
              },
              state: "scheduled",
              runtimeType: "openclaw",
              requiredTools: ["web_search"],
              routeId: "convrt_123",
              updatedAt: "2026-06-24T12:00:00.000Z",
            },
          ],
          listJobRuns: () => ({
            runs: [
              {
                runId: "jobrun_ai_news_1",
                jobId: "job_ai_news",
                workspaceId: "T123",
                slackUserId: "U123",
                triggerSource: "manual",
                status: "succeeded",
                failureReason: null,
                createdAt: "2026-06-24T12:05:00.000Z",
                updatedAt: "2026-06-24T12:05:12.000Z",
                startedAt: "2026-06-24T12:05:01.000Z",
                finishedAt: "2026-06-24T12:05:12.000Z",
              },
            ],
          }),
        },
        agentRunner: stubAgentRunner(() => {
          called = true;
          return {
            classification: "public",
            text: "unexpected",
          };
        }),
      }),
    );

    expect(called).toBe(false);
    expect(response.visibility).toBe("ephemeral");
    expect(response.classification).toBe("user_private");
    expect(response.text).toContain("Job runs");
    expect(response.text).toContain("jobrun_ai_news_1");
    expect(response.text).toContain("task: job_ai_news");
    expect(response.text).toContain("status: succeeded");
  });

  test("manually triggers scheduled jobs from scheduler resolver intent", async () => {
    const texts = [
      "let's manually run our existing cron job",
      "run cron job",
      "run this job manually now",
      "please trigger the current scheduled job",
      "you can help by test running the scheduled cron job",
      "start our cronjob",
    ];

    for (const text of texts) {
      let called = false;
      const queuedRuns: string[] = [];
      const response = await handleConversation(
        {
          ...baseRequest,
          text,
        },
        createDeps({
          agentMode: "llm",
          schedulerIntentResolver: async () => ({
            intent: "trigger_job",
            confidence: 0.96,
            jobId: null,
          }),
          schedulerControl: {
            listJobs: () => [],
            triggerJob: () => ({
              ok: true,
              jobId: "ai-news-hourly",
              run: {
                runId: "jobrun-manual-1",
                jobId: "ai-news-hourly",
                workspaceId: "T123",
                slackUserId: "U123",
                triggerSource: "manual",
                status: "queued",
                failureReason: null,
                createdAt: "2026-06-24T12:05:00.000Z",
                updatedAt: "2026-06-24T12:05:00.000Z",
                startedAt: null,
                finishedAt: null,
              },
            }),
          },
          onSchedulerRunQueued: (run) => {
            queuedRuns.push(run.runId);
          },
          agentRunner: stubAgentRunner(() => {
            called = true;
            return {
              classification: "public",
              text: "unexpected",
            };
          }),
        }),
      );

      expect(called).toBe(false);
      expect(queuedRuns).toEqual(["jobrun-manual-1"]);
      expect(response.text).toContain("Triggered scheduled job ai-news-hourly");
      expect(response.text).toContain("jobrun-manual-1");
    }
  });

  test("does not queue manual runs when scheduled task validation fails", async () => {
    let called = false;
    const queuedRuns: string[] = [];
    const response = await handleConversation(
      {
        ...baseRequest,
        text: "run job job_github_checker",
      },
      createDeps({
        agentMode: "llm",
        schedulerIntentResolver: async () => ({
          intent: "trigger_job",
          confidence: 0.96,
          jobId: "job_github_checker",
        }),
        schedulerControl: {
          listJobs: () => [],
          triggerJob: () => ({
            ok: false,
            reason: "validation_failed",
            task: {
              taskId: "job_github_checker",
              jobId: "job_github_checker",
              title: "Open PR monitor",
              prompt:
                "check for new open PRs in https://github.com/apelogic-ai github org",
              schedule: {
                kind: "interval",
                every: { minutes: 15 },
              },
              state: "scheduled",
              runtimeType: "hermes",
              requiredTools: ["github_list_my_pull_requests"],
              routeId: "convrt_123",
              updatedAt: "2026-06-24T12:00:00.000Z",
            },
            validation: {
              ok: false,
              expectedTools: ["github_search_issues"],
              grantedTools: ["github_list_my_pull_requests"],
              errors: [
                {
                  code: "missing_required_tool",
                  message:
                    "Task requires github_search_issues but the grant does not include it.",
                  tool: "github_search_issues",
                },
              ],
              warnings: [],
            },
          }),
        },
        onSchedulerRunQueued: (run) => {
          queuedRuns.push(run.runId);
        },
        agentRunner: stubAgentRunner(() => {
          called = true;
          return {
            classification: "public",
            text: "unexpected",
          };
        }),
      }),
    );

    expect(called).toBe(false);
    expect(queuedRuns).toEqual([]);
    expect(response.text).toContain("Scheduled task validation failed");
    expect(response.text).toContain("job_github_checker");
    expect(response.text).toContain("missing_required_tool");
    expect(response.text).toContain("github_search_issues");
  });

  test("uses scheduler intent resolver to trigger a named task without invoking the LLM runner", async () => {
    let called = false;
    let resolverSawJobs = 0;
    let triggerJobId: string | null | undefined;
    const response = await handleConversation(
      {
        ...baseRequest,
        text: "test run this github checker job",
      },
      createDeps({
        agentMode: "llm",
        schedulerControl: {
          listJobs: () => [
            {
              jobId: "job_github_checker",
              title: "GitHub PR checker",
              prompt: "check for new open PRs in the apelogic-ai GitHub org",
              schedule: {
                kind: "interval",
                every: { minutes: 15 },
              },
              state: "scheduled",
              runtimeType: "openclaw",
              requiredTools: ["github_list_my_pull_requests"],
              routeId: "convrt_123",
              updatedAt: "2026-06-24T12:00:00.000Z",
            },
            {
              jobId: "job_ai_news",
              title: "Hourly AI news summary",
              prompt: "look for fresh AI-related news",
              schedule: {
                kind: "interval",
                every: { hours: 1 },
              },
              state: "scheduled",
              runtimeType: "openclaw",
              requiredTools: ["web_search"],
              routeId: "convrt_123",
              updatedAt: "2026-06-24T12:00:00.000Z",
            },
          ],
          triggerJob: (input) => {
            triggerJobId = input.jobId;
            return {
              ok: true,
              jobId: "job_github_checker",
              run: {
                runId: "jobrun-github-1",
                jobId: "job_github_checker",
                workspaceId: "T123",
                slackUserId: "U123",
                triggerSource: "manual",
                status: "queued",
                failureReason: null,
                createdAt: "2026-06-24T12:05:00.000Z",
                updatedAt: "2026-06-24T12:05:00.000Z",
                startedAt: null,
                finishedAt: null,
              },
            };
          },
        },
        schedulerIntentResolver: async (input) => {
          resolverSawJobs = input.jobs.length;
          return {
            intent: "trigger_job",
            confidence: 0.95,
            jobId: "job_github_checker",
          };
        },
        agentRunner: stubAgentRunner(() => {
          called = true;
          return {
            classification: "public",
            text: "unexpected",
          };
        }),
      }),
    );

    expect(called).toBe(false);
    expect(resolverSawJobs).toBe(2);
    expect(triggerJobId).toBe("job_github_checker");
    expect(response.text).toContain(
      "Triggered scheduled job job_github_checker",
    );
    expect(response.text).toContain("jobrun-github-1");
  });

  test("uses scheduler intent resolver instead of schedule words when trigger wording names a task", async () => {
    let called = false;
    let created = false;
    let triggerJobId: string | null | undefined;
    const response = await handleConversation(
      {
        ...baseRequest,
        text: "test run hourly ai news summary job",
      },
      createDeps({
        agentMode: "llm",
        schedulerControl: {
          listJobs: () => [
            {
              jobId: "job_ai_news",
              title: "Hourly AI news summary",
              prompt: "look for fresh AI-related news",
              schedule: {
                kind: "interval",
                every: { hours: 1 },
              },
              state: "scheduled",
              runtimeType: "openclaw",
              requiredTools: ["web_search"],
              routeId: "convrt_123",
              updatedAt: "2026-06-24T12:00:00.000Z",
            },
          ],
          createJob: () => {
            created = true;
            throw new Error("unexpected create");
          },
          triggerJob: (input) => {
            triggerJobId = input.jobId;
            return {
              ok: true,
              jobId: "job_ai_news",
              run: {
                runId: "jobrun-ai-news-1",
                jobId: "job_ai_news",
                workspaceId: "T123",
                slackUserId: "U123",
                triggerSource: "manual",
                status: "queued",
                failureReason: null,
                createdAt: "2026-06-24T12:05:00.000Z",
                updatedAt: "2026-06-24T12:05:00.000Z",
                startedAt: null,
                finishedAt: null,
              },
            };
          },
        },
        schedulerIntentResolver: async () => ({
          intent: "trigger_job",
          confidence: 0.96,
          jobId: "job_ai_news",
        }),
        agentRunner: stubAgentRunner(() => {
          called = true;
          return {
            classification: "public",
            text: "unexpected",
          };
        }),
      }),
    );

    expect(called).toBe(false);
    expect(created).toBe(false);
    expect(triggerJobId).toBe("job_ai_news");
    expect(response.text).toContain("Triggered scheduled job job_ai_news");
    expect(response.text).toContain("jobrun-ai-news-1");
  });

  test("does not accept resolver-selected job ids when duplicate titles make the natural-language reference ambiguous", async () => {
    let called = false;
    let triggerJobId: string | null | undefined = "unset";
    const duplicateJobs: SchedulerJobSummary[] = [
      {
        jobId: "job_bad_ai_news",
        title: "Hourly AI news summary",
        prompt: "test run hourly ai news summary job",
        schedule: {
          kind: "interval" as const,
          every: { hours: 1 },
        },
        state: "scheduled",
        runtimeType: "openclaw",
        requiredTools: ["web_search"],
        routeId: "convrt_123",
        updatedAt: "2026-06-24T13:00:00.000Z",
      },
      {
        jobId: "job_good_ai_news",
        title: "Hourly AI news summary",
        prompt: "look for fresh AI-related news",
        schedule: {
          kind: "interval" as const,
          every: { hours: 1 },
        },
        state: "scheduled",
        runtimeType: "openclaw",
        requiredTools: ["web_search"],
        routeId: "convrt_123",
        updatedAt: "2026-06-24T12:00:00.000Z",
      },
    ];
    const response = await handleConversation(
      {
        ...baseRequest,
        text: "test run hourly ai news summary job",
      },
      createDeps({
        agentMode: "llm",
        schedulerControl: {
          listJobs: () => duplicateJobs,
          triggerJob: (input) => {
            triggerJobId = input.jobId;
            return {
              ok: false,
              reason: "ambiguous",
              jobs: duplicateJobs,
            };
          },
        },
        schedulerIntentResolver: async () => ({
          intent: "trigger_job",
          confidence: 0.96,
          jobId: "job_bad_ai_news",
        }),
        agentRunner: stubAgentRunner(() => {
          called = true;
          return {
            classification: "public",
            text: "unexpected",
          };
        }),
      }),
    );

    expect(called).toBe(false);
    expect(triggerJobId).toBeNull();
    expect(response.text).toContain("Multiple scheduled jobs are configured");
    expect(response.text).toContain("job_bad_ai_news");
    expect(response.text).toContain("job_good_ai_news");
  });

  test("triggers explicit scheduler job ids from scheduler resolver intent", async () => {
    let called = false;
    let triggerJobId: string | null | undefined;
    const response = await handleConversation(
      {
        ...baseRequest,
        text: "test run job job_7a7bf7cb-451f-4626-8b4b-6affe71e4b4b",
      },
      createDeps({
        agentMode: "llm",
        schedulerIntentResolver: async () => ({
          intent: "trigger_job",
          confidence: 0.96,
          jobId: "job_7a7bf7cb-451f-4626-8b4b-6affe71e4b4b",
        }),
        schedulerControl: {
          listJobs: () => [],
          triggerJob: (input) => {
            triggerJobId = input.jobId;
            return {
              ok: true,
              jobId: "job_7a7bf7cb-451f-4626-8b4b-6affe71e4b4b",
              run: {
                runId: "jobrun-github-2",
                jobId: "job_7a7bf7cb-451f-4626-8b4b-6affe71e4b4b",
                workspaceId: "T123",
                slackUserId: "U123",
                triggerSource: "manual",
                status: "queued",
                failureReason: null,
                createdAt: "2026-06-24T12:05:00.000Z",
                updatedAt: "2026-06-24T12:05:00.000Z",
                startedAt: null,
                finishedAt: null,
              },
            };
          },
        },
        agentRunner: stubAgentRunner(() => {
          called = true;
          return {
            classification: "public",
            text: "unexpected",
          };
        }),
      }),
    );

    expect(called).toBe(false);
    expect(triggerJobId).toBe("job_7a7bf7cb-451f-4626-8b4b-6affe71e4b4b");
    expect(response.text).toContain(
      "Triggered scheduled job job_7a7bf7cb-451f-4626-8b4b-6affe71e4b4b",
    );
  });

  test("does not treat generic job wording as scheduler control", async () => {
    let calledWith = "";
    const response = await handleConversation(
      {
        ...baseRequest,
        text: "show me my job title",
      },
      createDeps({
        agentMode: "llm",
        schedulerControl: {
          listJobs: () => {
            throw new Error("unexpected scheduler control call");
          },
        },
        agentRunner: stubAgentRunner((input) => {
          calledWith = input.text;
          return {
            classification: "public",
            text: "Agent handled generic job wording.",
          };
        }),
      }),
    );

    expect(calledWith).toBe("show me my job title");
    expect(response.text).toBe("Agent handled generic job wording.");
  });

  test("reports latest scheduled run status from scheduler resolver intent", async () => {
    let called = false;
    const response = await handleConversation(
      {
        ...baseRequest,
        text: "did the manual cron job run finish?",
      },
      createDeps({
        agentMode: "llm",
        schedulerIntentResolver: async () => ({
          intent: "latest_run_status",
          confidence: 0.96,
          jobId: null,
        }),
        schedulerControl: {
          listJobs: () => [],
          getLatestRunStatus: () => ({
            ok: true,
            run: {
              runId: "jobrun-manual-1",
              jobId: "ai-news-hourly",
              workspaceId: "T123",
              slackUserId: "U123",
              triggerSource: "manual",
              status: "queued",
              failureReason: null,
              createdAt: "2026-06-24T12:05:00.000Z",
              updatedAt: "2026-06-24T12:05:00.000Z",
              startedAt: null,
              finishedAt: null,
            },
            audit: {
              runId: "jobrun-manual-1",
              jobId: "ai-news-hourly",
              workspaceId: "T123",
              slackUserId: "U123",
              runtimeType: "openclaw",
              runnerName: "managed-runtime",
              executionMode: "native-runtime",
              routeId: "convrt_123",
              outputDigest: "sha256:abc",
              outputBytes: 12,
              usage: {
                totalTokens: 42,
              },
              telemetry: null,
              visibility: {
                destination: "slack",
              },
              createdAt: "2026-06-24T12:06:00.000Z",
              updatedAt: "2026-06-24T12:06:00.000Z",
            },
            workflow: {
              run: {
                status: "paused_after_failures",
                failureClass: "runtime_failed",
                failureReason: "Repeated runtime failures",
                updatedAt: "2026-06-24T12:07:00.000Z",
              },
              task: {
                status: "needs_repair",
                pausedReason: "Repeated runtime_failed failures",
              },
              sideEffectFailures: [
                {
                  failureId: "notify_failure:ai-news-hourly:jobrun-manual-1:runtime_failed:2026-06-24T12:07:00.000Z",
                  taskId: "ai-news-hourly",
                  commandType: "notify_failure",
                  reason: "Slack delivery failed",
                  at: "2026-06-24T12:07:00.000Z",
                  jobRunId: "jobrun-manual-1",
                  failureClass: "runtime_failed",
                },
              ],
            },
          }),
        },
        agentRunner: stubAgentRunner(() => {
          called = true;
          return {
            classification: "public",
            text: "unexpected",
          };
        }),
      }),
    );

    expect(called).toBe(false);
    expect(response.text).toContain("Latest scheduled job run");
    expect(response.text).toContain("status: queued");
    expect(response.text).toContain("runtime: openclaw");
    expect(response.text).toContain("runner: managed-runtime");
    expect(response.text).toContain("route: convrt_123");
    expect(response.text).toContain("tokens: 42");
    expect(response.text).toContain("workflow: paused_after_failures");
    expect(response.text).toContain("workflow failure: runtime_failed");
    expect(response.text).toContain("task repair: needs_repair");
    expect(response.text).toContain("workflow side-effect failures: 1");
  });

  test("pauses, resumes, and deletes scheduled jobs from scheduler resolver intent", async () => {
    const cases = [
      {
        text: "pause the existing cron job",
        intent: "pause_job" as const,
        expected: "Paused scheduled job ai-news-hourly.",
      },
      {
        text: "resume the existing cron job",
        intent: "resume_job" as const,
        expected: "Resumed scheduled job ai-news-hourly.",
      },
      {
        text: "delete the existing cron job",
        intent: "delete_job" as const,
        expected: "Deleted scheduled job ai-news-hourly.",
      },
    ];

    for (const item of cases) {
      let called = false;
      let schedulerCalledWith: unknown = null;
      const response = await handleConversation(
        {
          ...baseRequest,
          text: item.text,
        },
        createDeps({
          agentMode: "llm",
          schedulerIntentResolver: async () => ({
            intent: item.intent,
            confidence: 0.96,
            jobId: null,
          }),
          schedulerControl: {
            listJobs: () => [],
            pauseJob: (input) => {
              schedulerCalledWith = input;
              return {
                ok: true,
                job: {
                  jobId: "ai-news-hourly",
                  workspaceId: "T123",
                  slackUserId: "U123",
                  title: "Hourly AI news summary",
                  prompt: "Find fresh AI news and summarize it.",
                  schedule: { kind: "interval", every: { hours: 1 } },
                  routeId: "convrt_123",
                  state: "paused",
                  runtimeType: "hermes",
                  createdAt: "2026-06-24T12:00:00.000Z",
                  updatedAt: "2026-06-24T12:10:00.000Z",
                },
              };
            },
            resumeJob: (input) => {
              schedulerCalledWith = input;
              return {
                ok: true,
                job: {
                  jobId: "ai-news-hourly",
                  workspaceId: "T123",
                  slackUserId: "U123",
                  title: "Hourly AI news summary",
                  prompt: "Find fresh AI news and summarize it.",
                  schedule: { kind: "interval", every: { hours: 1 } },
                  routeId: "convrt_123",
                  state: "scheduled",
                  runtimeType: "hermes",
                  createdAt: "2026-06-24T12:00:00.000Z",
                  updatedAt: "2026-06-24T12:10:00.000Z",
                },
              };
            },
            deleteJob: (input) => {
              schedulerCalledWith = input;
              return {
                ok: true,
                jobId: "ai-news-hourly",
              };
            },
          },
          agentRunner: stubAgentRunner(() => {
            called = true;
            return {
              classification: "public",
              text: "unexpected",
            };
          }),
        }),
      );

      expect(called).toBe(false);
      expect(schedulerCalledWith).toEqual({
        workspaceId: "T123",
        slackUserId: "U123",
        jobId: null,
      });
      expect(response.text).toBe(item.expected);
    }
  });

  test("does not create scheduler jobs from free-form chat in deterministic mode", async () => {
    let created = false;
    const response = await handleConversation(
      {
        ...baseRequest,
        text: "create an hourly job to post AI news here",
      },
      createDeps({
        schedulerControl: {
          listJobs: () => [],
          createJob: () => {
            created = true;
            throw new Error("unexpected create");
          },
        },
      }),
    );

    expect(created).toBe(false);
    expect(response.text).toContain("Try one of these:");
  });

  test("does not infer explicit scheduler job id actions without the LLM resolver", async () => {
    let called = false;
    const response = await handleConversation(
      {
        ...baseRequest,
        text: "pause job job_ai_news_hourly",
      },
      createDeps({
        schedulerControl: {
          listJobs: () => [],
          pauseJob: () => {
            called = true;
            throw new Error("unexpected pause");
          },
        },
      }),
    );

    expect(called).toBe(false);
    expect(response.text).toContain("Try one of these:");
  });

  test("does not deterministically fall back when the scheduler resolver throws", async () => {
    let schedulerCalled = false;
    let agentCalledWith = "";
    const response = await handleConversation(
      {
        ...baseRequest,
        text: "pause job job_ai_news_hourly",
      },
      createDeps({
        agentMode: "llm",
        schedulerIntentResolver: async () => {
          throw new Error("resolver timeout");
        },
        schedulerControl: {
          listJobs: () => [],
          pauseJob: () => {
            schedulerCalled = true;
            throw new Error("unexpected pause");
          },
        },
        agentRunner: stubAgentRunner((input) => {
          agentCalledWith = input.text;
          return {
            classification: "public",
            text: "handled by agent",
          };
        }),
      }),
    );

    expect(schedulerCalled).toBe(false);
    expect(agentCalledWith).toBe("pause job job_ai_news_hourly");
    expect(response.text).toBe("handled by agent");
  });

  test("delegates Slack history task wording to the agent when resolver returns none", async () => {
    let calledWith = "";
    const text =
      "use slack search tool to inspect broader session history and pull the latest 5 failed task/job creation requests from the full conversation, limit search to the past 5 days";
    const response = await handleConversation(
      {
        ...baseRequest,
        text,
      },
      createDeps({
        agentMode: "llm",
        schedulerControl: {
          listJobs: () => {
            throw new Error("unexpected scheduler control call");
          },
          showTask: () => {
            throw new Error("unexpected scheduler control call");
          },
        },
        schedulerIntentResolver: async () => ({
          intent: "none",
          confidence: 0.96,
          jobId: null,
        }),
        agentRunner: stubAgentRunner((input) => {
          calledWith = input.text;
          return {
            classification: "user_private",
            text: "Searched Slack history.",
          };
        }),
      }),
    );

    expect(calledWith).toBe(text);
    expect(response.text).toBe("Searched Slack history.");
  });

  test("delegates explicit agent, task, and subagent requests before GitHub fast-paths", async () => {
    for (const text of [
      "ask agent to list my open GitHub PRs",
      "add task to list my open GitHub PRs",
      "ask subagent to list my open GitHub PRs",
    ]) {
      let calledWith = "";
      const response = await handleConversation(
        { ...baseRequest, text },
        createDeps({
          agentMode: "llm",
          agentRunner: stubAgentRunner((input) => {
            calledWith = input.text;
            return {
              classification: "public",
              text: "Agent handled it.",
            };
          }),
        }),
      );

      expect(calledWith).toBe(text);
      expect(response.text).toBe("Agent handled it.");
    }
  });
});
