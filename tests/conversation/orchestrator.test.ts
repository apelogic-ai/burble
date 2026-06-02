import { describe, expect, test } from "bun:test";
import { handleConversation } from "../../src/conversation/orchestrator";
import type { ConversationDeps, ConversationRequest } from "../../src/conversation/types";
import type {
  AgentInput,
  AgentOutput,
  AgentRunEvent,
  AgentRunner
} from "../../src/agent/types";
import { createGitHubTools } from "../../src/tools/github";
import { createGoogleTools } from "../../src/tools/google";
import { createJiraTools } from "../../src/tools/jira";
import type { ObservabilityEventInput } from "../../src/observability";

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
    listMyPullRequests: async (_token, options) =>
      [
        {
          html_url: "https://github.com/acme/app/pull/3",
          title: "Add workspace auth"
        },
        {
          html_url: "https://github.com/acme/app/pull/4",
          title: "Improve cron delivery"
        },
        {
          html_url: "https://github.com/acme/app/pull/5",
          title: "Wire provider bridge"
        },
        {
          html_url: "https://github.com/acme/app/pull/6",
          title: "Update old runtime"
        }
      ].slice(0, options?.limit ?? 10)
  });
  const googleConnection = {
    provider: "google" as const,
    email: "person@example.com",
    slackUserId: "U123",
    providerLogin: "person@example.com",
    accessToken: "google-token",
    connectedAt: "2026-05-19T00:00:00Z"
  };
  const jiraConnection = {
    provider: "jira" as const,
    email: "person@example.com",
    slackUserId: "U123",
    providerLogin: "person@example.com",
    accessToken: "jira-token",
    connectedAt: "2026-05-19T00:00:00Z"
  };
  const googleTools = createGoogleTools({
    getGoogleUser: async () => ({ email: "person@example.com" }),
    searchGoogleDriveFiles: async () => [],
    createGoogleDriveTextFile: async () => ({
      id: "file-1",
      name: "Test"
    }),
    searchGoogleCalendarEvents: async () => [],
    searchGoogleMailMessages: async () => [
      {
        id: "mail-1",
        subject: "Your OpenAI API account has been funded",
        snippet: "We charged $100.00 to your credit card..."
      }
    ]
  });
  const jiraTools = createJiraTools({
    getJiraUser: async () => ({
      accountId: "jira-account",
      displayName: "Person"
    }),
    listAssignedJiraIssues: async () => [
      {
        key: "DM-12",
        summary: "test task ticket #9 from slack",
        url: "https://jira.example/browse/DM-12"
      }
    ],
    searchJiraIssues: async () => [
      {
        key: "DM-13",
        summary: "hello from slack",
        url: "https://jira.example/browse/DM-13"
      }
    ]
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
      jira: jiraTools
    },
    ...overrides
  };
}

function stubAgentRunner(
  run:
    | ((input: AgentInput) => Promise<AgentOutput> | AgentOutput)
    | AgentRunEvent[]
): AgentRunner {
  return {
    name: "stub",
    capabilities: {
      streaming: false,
      toolEvents: false,
      remote: false
    },
    async *run(input) {
      if (Array.isArray(run)) {
        yield* run;
        return;
      }

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

  test("returns a private Jira connect link", async () => {
    const response = await handleConversation(
      { ...baseRequest, text: "connect jira" },
      createDeps()
    );

    expect(response).toMatchObject({
      visibility: "ephemeral",
      classification: "user_private",
      text: "<https://example.test/oauth/jira|Connect your Jira account>"
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

  test("limits deterministic pull request responses when the user asks for a count", async () => {
    const response = await handleConversation(
      { ...baseRequest, text: "pull my latest 3 github PRs" },
      createDeps()
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
            title: "Discover provider tools through MCP"
          }
        ];
      }
    });

    const response = await handleConversation(
      { ...baseRequest, text: "what is my latest open PR in example-org org?" },
      deps
    );

    expect(calls).toEqual([
      {
        limit: 1,
        state: "open",
        sort: "updated",
        order: "desc",
        owner: "example-org"
      }
    ]);
    expect(response.visibility).toBe("ephemeral");
    expect(response.text).toContain("Discover provider tools through MCP");
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
      {
        ...baseRequest,
        text: "summarize my GitHub work",
        conversationRouteId: "convrt_abc123"
      },
      createDeps({
        agentMode: "llm",
        agentExecutionMode: "native-runtime",
        agentRunner: stubAgentRunner((input) => {
          calls.push(input.text);
          expect(input.executionMode).toBe("native-runtime");
          expect(input.principal).toEqual({
            workspaceId: "T123",
            slackUserId: "U123"
          });
          expect(input.conversation).toEqual({
            routeId: "convrt_abc123",
            source: "slack",
            workspaceId: "T123",
            channelId: "C123",
            rootId: "channel:C123:thread:1710000000.000100",
            isDirectMessage: false
          });
          expect(input.toolGroups).toEqual({
            groups: ["conversation", "github"],
            reasons: ["default:conversation", "keyword:github:github"]
          });
          expect(input.connections.github?.providerLogin).toBe("octocat");
          expect(input.connections.jira?.providerLogin).toBe("person@example.com");
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
            text: "unexpected"
          };
        })
      })
    );

    expect(called).toBe(false);
    expect(response.visibility).toBe("ephemeral");
    expect(response.text).toContain("*Latest Gmail message:*");
    expect(response.text).toContain("Your OpenAI API account has been funded");
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
            text: "unexpected"
          };
        })
      })
    );

    expect(called).toBe(false);
    expect(response.visibility).toBe("ephemeral");
    expect(response.text).toBe(
      "Your last created Jira ticket: <https://jira.example/browse/DM-13|DM-13 - hello from slack>"
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
            text: "unexpected"
          };
        })
      })
    );

    expect(called).toBe(false);
    expect(response.visibility).toBe("ephemeral");
    expect(response.text).toBe(
      "Your latest assigned Jira ticket: <https://jira.example/browse/DM-12|DM-12 - test task ticket #9 from slack>"
    );
  });

  test("forwards LLM runner events before returning the final response", async () => {
    const events: AgentRunEvent[] = [];
    const response = await handleConversation(
      { ...baseRequest, text: "summarize my GitHub work", isDirectMessage: true },
      createDeps({
        agentMode: "llm",
        agentRunner: stubAgentRunner([
          { type: "status", text: "Preparing runtime..." },
          {
            type: "tool_call",
            toolName: "github_list_assigned_issues",
            callId: "call-1"
          },
          {
            type: "final",
            response: {
              classification: "user_private",
              text: "One issue needs attention."
            }
          }
        ]),
        onAgentEvent: (event) => {
          events.push(event);
        }
      })
    );

    expect(response.text).toBe("One issue needs attention.");
    expect(events).toEqual([
      { type: "status", text: "Preparing runtime..." },
      {
        type: "tool_call",
        toolName: "github_list_assigned_issues",
        callId: "call-1"
      }
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
          }
        },
        agentMode: "llm",
        agentRunner: stubAgentRunner(() => ({
          classification: "public",
          text: "Hello."
        }))
      })
    );

    expect(response.text).toBe("Hello.");
    expect(observabilityEvents.map((event) => event.name)).toEqual([
      "conversation.request.started",
      "conversation.response.completed"
    ]);
    expect(observabilityEvents.map((event) => event.traceId)).toEqual([
      "trace-1",
      "trace-1"
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
        toolGroupReasons: ["default:conversation"]
      },
      content: {
        text: "hello"
      }
    });
    expect(observabilityEvents[1]).toMatchObject({
      classification: "public",
      status: "ok",
      attributes: {
        visibility: "public",
        textLength: 6
      },
      content: {
        text: "Hello."
      }
    });
  });

  test("emits observability events for agent tool calls and usage", async () => {
    const observabilityEvents: ObservabilityEventInput[] = [];
    const response = await handleConversation(
      { ...baseRequest, text: "summarize my GitHub work", isDirectMessage: true },
      createDeps({
        traceId: "trace-tools",
        observability: {
          emit: (event) => {
            observabilityEvents.push(event);
          }
        },
        agentMode: "llm",
        agentRunner: stubAgentRunner([
          { type: "status", text: "Preparing runtime..." },
          {
            type: "tool_call",
            toolName: "github_list_my_pull_requests",
            callId: "call-1"
          },
          {
            type: "tool_result",
            toolName: "github_list_my_pull_requests",
            callId: "call-1",
            classification: "user_private"
          },
          {
            type: "final",
            response: {
              classification: "user_private",
              text: "One PR needs review.",
              usage: {
                inputTokens: 10,
                outputTokens: 5,
                totalTokens: 15
              }
            }
          }
        ])
      })
    );

    expect(response.text).toBe("One PR needs review.");
    expect(observabilityEvents.map((event) => event.name)).toEqual([
      "conversation.request.started",
      "agent.status",
      "tool.call.started",
      "tool.call.completed",
      "conversation.response.completed"
    ]);
    expect(observabilityEvents.map((event) => event.traceId)).toEqual([
      "trace-tools",
      "trace-tools",
      "trace-tools",
      "trace-tools",
      "trace-tools"
    ]);
    expect(observabilityEvents[1]).toMatchObject({
      name: "agent.status",
      attributes: {
        text: "Preparing runtime..."
      }
    });
    expect(observabilityEvents[2]).toMatchObject({
      name: "tool.call.started",
      toolName: "github_list_my_pull_requests",
      callId: "call-1"
    });
    expect(observabilityEvents[3]).toMatchObject({
      name: "tool.call.completed",
      toolName: "github_list_my_pull_requests",
      callId: "call-1",
      classification: "user_private",
      status: "ok"
    });
    expect(observabilityEvents[4]).toMatchObject({
      name: "conversation.response.completed",
      classification: "user_private",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15
      }
    });
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
            text: "Agent listed pull requests."
          };
        })
      })
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
            text: "unexpected"
          };
        })
      })
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
        text: "create a one-shot cron job to list my open GitHub PRs and post the result here in 2 minutes"
      },
      createDeps({
        agentMode: "llm",
        agentRunner: stubAgentRunner((input) => {
          calls.push(input.text);
          return {
            classification: "public",
            text: "Created scheduled job."
          };
        })
      })
    );

    expect(calls).toEqual([
      "create a one-shot cron job to list my open GitHub PRs and post the result here in 2 minutes"
    ]);
    expect(response.text).toBe("Created scheduled job.");
  });

  test("delegates GitHub reviewer mutations to the agent before PR fast-paths", async () => {
    const calls: string[] = [];
    const response = await handleConversation(
      {
        ...baseRequest,
        text: "add zer0tweets as reviewer for that Discover provider tools through MCP PR"
      },
      createDeps({
        agentMode: "llm",
        agentRunner: stubAgentRunner((input) => {
          calls.push(input.text);
          return {
            classification: "user_private",
            text: "Requested review."
          };
        })
      })
    );

    expect(calls).toEqual([
      "add zer0tweets as reviewer for that Discover provider tools through MCP PR"
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
        text
      },
      createDeps({
        agentMode: "llm",
        agentRunner: stubAgentRunner((input) => {
          calls.push(input.text);
          return {
            classification: "user_private",
            text: "Updated PR description."
          };
        })
      })
    );

    expect(calls).toEqual([text]);
    expect(response.text).toBe("Updated PR description.");
  });

  test("delegates cron and job requests to the agent before GitHub fast-paths", async () => {
    for (const text of [
      "set recurring cron job to pull my latest 3 github PRs",
      "set a job to pull my latest 3 github PRs"
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
              text: "Agent scheduled it."
            };
          })
        })
      );

      expect(calledWith).toBe(text);
      expect(response.text).toBe("Agent scheduled it.");
    }
  });

  test("delegates explicit agent, task, and subagent requests before GitHub fast-paths", async () => {
    for (const text of [
      "ask agent to list my open GitHub PRs",
      "add task to list my open GitHub PRs",
      "ask subagent to list my open GitHub PRs"
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
              text: "Agent handled it."
            };
          })
        })
      );

      expect(calledWith).toBe(text);
      expect(response.text).toBe("Agent handled it.");
    }
  });
});
