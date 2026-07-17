import { describe, expect, test } from "bun:test";
import { readConfig } from "../src/config";
import { createTokenStore } from "../src/db";
import { createRuntimeJwtIssuer } from "../src/runtime-jwt";
import { createSlackRuntime } from "../src/slack";
import type { McpGwGoogleAuthService } from "../src/mcp/mcp-gw-google-auth-service";
import type { McpGwGitHubAuthService } from "../src/mcp/mcp-gw-github-auth-service";
import { startOAuthServer } from "../src/server";
import {
  installSlackTestbed,
  testbedDirectChannelId,
  testbedUserId,
  testbedWorkspaceId,
} from "../src/testbed/slack";

const slackTestbedTimeoutMs = 15_000;

describe("local Slack testbed", () => {
  test("executes and persists resolved task preparation through Slack wiring", async () => {
    const config = readConfig({
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_APP_TOKEN: "xapp-test",
      GITHUB_CLIENT_ID: "github-client-id",
      GITHUB_CLIENT_SECRET: "github-client-secret",
      BASE_URL: "http://127.0.0.1:3000",
      PORT: "39191",
      DATABASE_PATH: ":memory:",
      BURBLE_TESTBED: "1",
      AGENT_MODE: "llm",
      AGENT_RUNTIME: "burble-runtime",
      AGENT_RUNTIME_URL: "http://127.0.0.1:9",
      AGENT_RUNTIME_ENGINE: "burble-native",
    });
    const store = createTokenStore(":memory:");
    store.upsertScheduledJob({
      jobId: "job-report",
      workspaceId: testbedWorkspaceId,
      slackUserId: testbedUserId,
      title: "Daily report",
      prompt: "Produce the daily report.",
      schedule: { kind: "cron", expression: "0 9 * * *", timezone: "UTC" },
      runtimeType: "burble-native",
      state: "scheduled",
    });
    const runtimeJwtIssuer = createRuntimeJwtIssuer({
      issuer: config.runtimeJwtIssuer,
    });
    const slack = createSlackRuntime(
      config,
      store,
      runtimeJwtIssuer,
      undefined,
      {
        schedulerIntentResolver: async () => ({
          intent: "update_job_prompt",
          confidence: 0.99,
          jobId: "job-report",
          taskPlan: {
            preparation: [
              {
                id: "create_folder",
                tool: "google_create_drive_folder",
                input: { name: "Daily reports" },
                saveAs: "report_folder",
                purpose: "Store generated reports",
              },
            ],
            steps: [
              {
                id: "write_report",
                instruction:
                  "Create the report in {{resources.report_folder.id}}.",
                tools: ["google_create_drive_text_file"],
              },
            ],
          },
        }),
        scheduledTaskPreparationExecutor: async (input) => {
          expect(input).toMatchObject({
            workspaceId: testbedWorkspaceId,
            slackUserId: testbedUserId,
            tool: "google_create_drive_folder",
          });
          return {
            value: {
              id: "folder-123",
              name: "Daily reports",
              webViewLink: "https://drive.google.com/drive/folders/folder-123",
            },
            stateRef: {
              provider: "google",
              kind: "folder",
              id: "folder-123",
              name: "Daily reports",
            },
          };
        },
        testbed: true,
      },
    );
    const testbed = installSlackTestbed(slack);

    try {
      await testbed.processMessage({
        text: "Modify the daily report job and create its storage folder now.",
      });

      expect(store.getScheduledJob("job-report")?.prompt).toBe(
        "1. Create the report in folder-123.",
      );
      expect(store.getAgentJobCapability("job-report")).toMatchObject({
        requiredTools: ["google_create_drive_text_file"],
        stateRefs: [
          {
            provider: "google",
            kind: "folder",
            id: "folder-123",
            name: "Daily reports",
            purpose: "Store generated reports",
          },
        ],
      });
      expect(testbed.state.messages.at(-1)?.text).toContain(
        "https://drive.google.com/drive/folders/folder-123",
      );
    } finally {
      slack.close();
      store.close();
    }
  });

  test("uses MCP-GW as the authoritative Google auth control plane", async () => {
    const config = readConfig({
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_APP_TOKEN: "xapp-test",
      GITHUB_CLIENT_ID: "github-client-id",
      GITHUB_CLIENT_SECRET: "github-client-secret",
      BASE_URL: "http://127.0.0.1:3000",
      PORT: "39190",
      DATABASE_PATH: ":memory:",
      BURBLE_TESTBED: "1",
      AGENT_MODE: "deterministic",
      GOOGLE_VIA_MCP_GW: "on",
      MCP_IDENTITY_PRIVATE_KEY_PATH: "/tmp/burble-test-mcp-identity.pem",
      MCP_GW_AUDIENCE: "https://mcp-gw.example.test/mcp",
      MCP_GW_MCP_URL: "https://mcp-gw.example.test/mcp",
    });
    const store = createTokenStore(":memory:");
    store.upsertProviderConnection({
      provider: "google",
      email: "testbed@example.test",
      slackUserId: testbedUserId,
      providerLogin: "stale-legacy@example.test",
      accessToken: "legacy-access-token",
      refreshToken: "legacy-refresh-token",
    });
    let connected = true;
    let disconnectCalls = 0;
    const mcpGwGoogleAuthService: McpGwGoogleAuthService = {
      start: async (principal) => {
        expect(principal).toEqual({
          workspaceId: testbedWorkspaceId,
          slackUserId: testbedUserId,
        });
        return {
          authorizationUrl:
            "https://accounts.google.com/o/oauth2/v2/auth?state=mcp-gw-state",
        };
      },
      status: async () => ({
        connected,
        ...(connected ? { email: "mcp-gw-user@example.test" } : {}),
        scopesRequired: connected ? ["drive", "gmail"] : [],
        scopesGranted: connected ? ["drive", "gmail"] : [],
        missingScopes: [],
      }),
      disconnect: async () => {
        disconnectCalls += 1;
        connected = false;
      },
    };
    const runtimeJwtIssuer = createRuntimeJwtIssuer({
      issuer: config.runtimeJwtIssuer,
    });
    const slack = createSlackRuntime(
      config,
      store,
      runtimeJwtIssuer,
      undefined,
      { testbed: true, mcpGwGoogleAuthService },
    );
    const testbed = installSlackTestbed(slack);
    const slashResponses: unknown[] = [];

    try {
      await slack.app.processEvent({
        body: {
          type: "slash_command",
          command: "/auth",
          text: "google",
          team_id: testbedWorkspaceId,
          user_id: testbedUserId,
          channel_id: testbedDirectChannelId,
        },
        ack: async (response) => {
          slashResponses.push(response);
        },
      });
      expect(JSON.stringify(slashResponses)).toContain(
        "https://accounts.google.com/o/oauth2/v2/auth?state=mcp-gw-state",
      );

      await testbed.processAppHomeOpened();
      const connectedHome = JSON.stringify(
        testbed.state.homes[testbedUserId],
      );
      expect(connectedHome).toContain("mcp-gw-user@example.test");
      expect(connectedHome).not.toContain("stale-legacy@example.test");

      await testbed.processBlockAction({
        actionId: "provider_disconnect",
        value: "google",
      });
      expect(disconnectCalls).toBe(1);
      expect(
        JSON.stringify(testbed.state.homes[testbedUserId]),
      ).toContain("Not connected through MCP-GW");
      expect(
        store.getConnectionForSlackUser("google", testbedUserId)?.providerLogin,
      ).toBe("stale-legacy@example.test");
    } finally {
      slack.close();
      store.close();
    }
  }, slackTestbedTimeoutMs);

  test("uses MCP-GW as the authoritative GitHub auth control plane", async () => {
    const config = readConfig({
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_APP_TOKEN: "xapp-test",
      GITHUB_CLIENT_ID: "legacy-client-id",
      GITHUB_CLIENT_SECRET: "legacy-client-secret",
      BASE_URL: "http://127.0.0.1:3000",
      PORT: "39189",
      DATABASE_PATH: ":memory:",
      BURBLE_TESTBED: "1",
      AGENT_MODE: "deterministic",
      GITHUB_VIA_MCP_GW: "on",
      MCP_IDENTITY_PRIVATE_KEY_PATH: "/tmp/burble-test-mcp-identity.pem",
      MCP_GW_AUDIENCE: "https://mcp-gw.example.test/mcp",
      MCP_GW_MCP_URL: "https://mcp-gw.example.test/mcp",
    });
    const store = createTokenStore(":memory:");
    store.upsertProviderConnection({
      provider: "github",
      email: "testbed@example.test",
      slackUserId: testbedUserId,
      providerLogin: "stale-legacy-user",
      accessToken: "legacy-access-token",
    });
    let connected = true;
    let disconnectCalls = 0;
    const mcpGwGitHubAuthService: McpGwGitHubAuthService = {
      start: async (principal, input) => {
        expect(principal).toEqual({
          workspaceId: testbedWorkspaceId,
          slackUserId: testbedUserId,
        });
        expect(input?.redirectAfter).toBe(
          "http://127.0.0.1:3000/oauth/github/connected",
        );
        return {
          authorizationUrl:
            "https://github.com/login/oauth/authorize?state=mcp-gw-state",
        };
      },
      status: async () => ({
        connected,
        ...(connected ? { email: "mcp-gw-user@example.test" } : {}),
        scopesRequired: ["repo", "read:org", "workflow", "notifications"],
        scopesGranted: connected
          ? ["repo", "read:org", "workflow", "notifications"]
          : [],
        missingScopes: connected
          ? []
          : ["repo", "read:org", "workflow", "notifications"],
      }),
      disconnect: async () => {
        disconnectCalls += 1;
        connected = false;
      },
    };
    const runtimeJwtIssuer = createRuntimeJwtIssuer({
      issuer: config.runtimeJwtIssuer,
    });
    const slack = createSlackRuntime(
      config,
      store,
      runtimeJwtIssuer,
      undefined,
      { testbed: true, mcpGwGitHubAuthService },
    );
    const testbed = installSlackTestbed(slack);
    const slashResponses: unknown[] = [];

    try {
      await slack.app.processEvent({
        body: {
          type: "slash_command",
          command: "/auth",
          text: "github",
          team_id: testbedWorkspaceId,
          user_id: testbedUserId,
          channel_id: testbedDirectChannelId,
        },
        ack: async (response) => {
          slashResponses.push(response);
        },
      });
      expect(JSON.stringify(slashResponses)).toContain(
        "https://github.com/login/oauth/authorize?state=mcp-gw-state",
      );

      await testbed.processAppHomeOpened();
      const connectedHome = JSON.stringify(testbed.state.homes[testbedUserId]);
      expect(connectedHome).toContain("mcp-gw-user@example.test");
      expect(connectedHome).not.toContain("stale-legacy-user");

      await testbed.processBlockAction({
        actionId: "provider_disconnect",
        value: "github",
      });
      expect(disconnectCalls).toBe(1);
      expect(JSON.stringify(testbed.state.homes[testbedUserId])).toContain(
        "Reconnect required through MCP-GW",
      );
      expect(
        store.getConnectionForSlackUser("github", testbedUserId)?.providerLogin,
      ).toBe("stale-legacy-user");
    } finally {
      slack.close();
      store.close();
    }
  }, slackTestbedTimeoutMs);

  test("keeps Burble-owned Google OAuth when MCP-GW routing is disabled", async () => {
    const config = readConfig({
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_APP_TOKEN: "xapp-test",
      GITHUB_CLIENT_ID: "github-client-id",
      GITHUB_CLIENT_SECRET: "github-client-secret",
      GOOGLE_CLIENT_ID: "google-client-id",
      GOOGLE_CLIENT_SECRET: "google-client-secret",
      BASE_URL: "https://burble.example.test",
      PORT: "39190",
      DATABASE_PATH: ":memory:",
      BURBLE_TESTBED: "1",
      AGENT_MODE: "deterministic",
    });
    const store = createTokenStore(":memory:");
    const runtimeJwtIssuer = createRuntimeJwtIssuer({
      issuer: config.runtimeJwtIssuer,
    });
    const slack = createSlackRuntime(
      config,
      store,
      runtimeJwtIssuer,
      undefined,
      { testbed: true },
    );
    installSlackTestbed(slack);
    const slashResponses: unknown[] = [];

    try {
      await slack.app.processEvent({
        body: {
          type: "slash_command",
          command: "/auth",
          text: "google",
          team_id: testbedWorkspaceId,
          user_id: testbedUserId,
          channel_id: testbedDirectChannelId,
        },
        ack: async (response) => {
          slashResponses.push(response);
        },
      });

      const response = JSON.stringify(slashResponses);
      expect(response).toContain("accounts.google.com/o/oauth2/v2/auth");
      expect(response).toContain("client_id=google-client-id");
      expect(response).toContain(
        "redirect_uri=https%3A%2F%2Fburble.example.test%2Foauth%2Fgoogle%2Fcallback",
      );
    } finally {
      slack.close();
      store.close();
    }
  }, slackTestbedTimeoutMs);

  test("injects Slack-shaped App Home and DM events through Bolt", async () => {
    const config = readConfig({
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_APP_TOKEN: "xapp-test",
      GITHUB_CLIENT_ID: "github-client-id",
      GITHUB_CLIENT_SECRET: "github-client-secret",
      BASE_URL: "http://127.0.0.1:3000",
      PORT: "39187",
      DATABASE_PATH: ":memory:",
      BURBLE_TESTBED: "1",
      AGENT_MODE: "deterministic",
    });
    const store = createTokenStore(":memory:");
    store.upsertWorkspacePolicy({
      workspaceId: testbedWorkspaceId,
      key: "runtime.allowedEngines",
      value: ["hermes", "openclaw"],
    });
    const runtimeJwtIssuer = createRuntimeJwtIssuer({
      issuer: config.runtimeJwtIssuer,
    });
    const slack = createSlackRuntime(
      config,
      store,
      runtimeJwtIssuer,
      undefined,
      {
        testbed: true,
      },
    );
    const testbed = installSlackTestbed(slack);
    const server = startOAuthServer(
      config,
      store,
      slack,
      runtimeJwtIssuer,
      undefined,
      testbed,
    );
    const baseUrl = `http://127.0.0.1:${server.port}`;

    try {
      const homeResponse = await fetch(
        `${baseUrl}/__testbed/slack/events/app_home_opened`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ user: testbedUserId }),
        },
      );
      expect(homeResponse.status).toBe(200);

      const home = await fetch(
        `${baseUrl}/__testbed/slack/users/${testbedUserId}/home`,
      ).then((response) => response.json() as Promise<{ home: unknown }>);
      expect(JSON.stringify(home.home)).toContain("Agent runtime");

      for (const engine of ["hermes", "openclaw"]) {
        const selectResponse = await fetch(
          `${baseUrl}/__testbed/slack/actions`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              actionId: "agent_runtime_engine_select",
              selectedValue: engine,
              user: testbedUserId,
            }),
          },
        );
        expect(selectResponse.status).toBe(200);
        const selectedHome = await fetch(
          `${baseUrl}/__testbed/slack/users/${testbedUserId}/home`,
        ).then((response) => response.json() as Promise<{ home: unknown }>);
        expect(JSON.stringify(selectedHome.home)).toContain(engine);
      }

      const messageResponse = await fetch(
        `${baseUrl}/__testbed/slack/events/message.im`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "hello agent", user: testbedUserId }),
        },
      );
      expect(messageResponse.status).toBe(200);

      const transcript = await fetch(
        `${baseUrl}/__testbed/slack/channels/${testbedDirectChannelId}/messages`,
      ).then(
        (response) =>
          response.json() as Promise<{ messages: Array<{ text: string }> }>,
      );
      expect(transcript.messages.length).toBeGreaterThan(0);
      expect(transcript.messages.some((message) => message.text.trim())).toBe(
        true,
      );
    } finally {
      server.stop();
      store.close();
    }
  }, slackTestbedTimeoutMs);

  test("routes scheduler control DMs through Burble before the runtime", async () => {
    const config = readConfig({
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_APP_TOKEN: "xapp-test",
      GITHUB_CLIENT_ID: "github-client-id",
      GITHUB_CLIENT_SECRET: "github-client-secret",
      BASE_URL: "http://127.0.0.1:3000",
      PORT: "39188",
      DATABASE_PATH: ":memory:",
      BURBLE_TESTBED: "1",
      AGENT_MODE: "llm",
      AGENT_RUNTIME: "burble-runtime",
      AGENT_RUNTIME_URL: "http://127.0.0.1:9",
    });
    const store = createTokenStore(":memory:");
    store.upsertScheduledJob({
      jobId: "ai-news-hourly",
      workspaceId: testbedWorkspaceId,
      slackUserId: testbedUserId,
      title: "Hourly AI news summary",
      prompt: "Pull latest AI-related news and summarize it.",
      schedule: {
        kind: "interval",
        every: { hours: 1 },
      },
      runtimeType: "hermes",
      state: "scheduled",
      now: new Date("2026-06-25T16:00:00.000Z"),
    });
    const runtimeJwtIssuer = createRuntimeJwtIssuer({
      issuer: config.runtimeJwtIssuer,
    });
    const slack = createSlackRuntime(
      config,
      store,
      runtimeJwtIssuer,
      undefined,
      {
        schedulerIntentResolver: async ({ text }) => {
          if (text.includes("run this job")) {
            return {
              intent: "trigger_job",
              confidence: 0.96,
              jobId: "ai-news-hourly",
            };
          }
          return {
            intent: "list_jobs",
            confidence: 0.96,
            jobId: null,
          };
        },
        testbed: true,
      },
    );
    const testbed = installSlackTestbed(slack);
    const server = startOAuthServer(
      config,
      store,
      slack,
      runtimeJwtIssuer,
      undefined,
      testbed,
    );
    const baseUrl = `http://127.0.0.1:${server.port}`;

    try {
      const messageResponse = await fetch(
        `${baseUrl}/__testbed/slack/events/message.im`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text: "show me current cron jobs",
            user: testbedUserId,
          }),
        },
      );
      expect(messageResponse.status).toBe(200);

      const transcript = await fetch(
        `${baseUrl}/__testbed/slack/channels/${testbedDirectChannelId}/messages`,
      ).then(
        (response) =>
          response.json() as Promise<{ messages: Array<{ text: string }> }>,
      );
      const text = transcript.messages
        .map((message) => message.text)
        .join("\n");
      expect(text).toContain("Scheduled tasks");
      expect(text).toContain("ai-news-hourly");
      expect(text).toContain("Hourly AI news summary");
      expect(text).toContain("state: scheduled");
      expect(text).not.toContain("Runtime detail");
      expect(text).not.toContain("Starting agent runtime");
      expect(text).not.toContain("Final result");

      const triggerResponse = await fetch(
        `${baseUrl}/__testbed/slack/events/message.im`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text: "run this job manually now",
            user: testbedUserId,
          }),
        },
      );
      expect(triggerResponse.status).toBe(200);

      const triggeredTranscript = await fetch(
        `${baseUrl}/__testbed/slack/channels/${testbedDirectChannelId}/messages`,
      ).then(
        (response) =>
          response.json() as Promise<{ messages: Array<{ text: string }> }>,
      );
      const triggeredText = triggeredTranscript.messages
        .map((message) => message.text)
        .join("\n");
      expect(triggeredText).toContain("Triggered scheduled job ai-news-hourly");
      expect(triggeredText).not.toContain("Runtime detail");
      expect(triggeredText).not.toContain("Starting agent runtime");
      expect(triggeredText).not.toContain("Final result");

      const latestRun = store.getLatestAgentJobRunForPrincipal(
        testbedWorkspaceId,
        testbedUserId,
        "ai-news-hourly",
      );
      expect(latestRun?.jobId).toBe("ai-news-hourly");
      expect(latestRun?.triggerSource).toBe("manual");
      expect(latestRun?.status).toBe("queued");
    } finally {
      server.stop();
      store.close();
    }
  }, slackTestbedTimeoutMs);

  test("creates explicit scheduler DMs through Burble before the runtime", async () => {
    const config = readConfig({
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_APP_TOKEN: "xapp-test",
      GITHUB_CLIENT_ID: "github-client-id",
      GITHUB_CLIENT_SECRET: "github-client-secret",
      BASE_URL: "http://127.0.0.1:3000",
      PORT: "39189",
      DATABASE_PATH: ":memory:",
      BURBLE_TESTBED: "1",
      AGENT_MODE: "llm",
      AGENT_RUNTIME: "burble-runtime",
      AGENT_RUNTIME_URL: "http://127.0.0.1:9",
      AGENT_RUNTIME_ENGINE: "hermes",
    });
    const store = createTokenStore(":memory:");
    const runtimeJwtIssuer = createRuntimeJwtIssuer({
      issuer: config.runtimeJwtIssuer,
    });
    const slack = createSlackRuntime(
      config,
      store,
      runtimeJwtIssuer,
      undefined,
      {
        schedulerIntentResolver: async ({ text, jobs }) => {
          if (text.includes("test-run")) {
            return {
              intent: "trigger_job",
              confidence: 0.96,
              jobId: jobs[0]?.jobId ?? null,
            };
          }
          return {
            intent: "create_job",
            confidence: 0.96,
            jobId: null,
            create: {
              title: "Hourly AI news summary",
              prompt:
                "Look for latest AI news and summarize them in one paragraph.",
              schedule: {
                kind: "cron",
                expression: "0 * * * *",
                timezone: "UTC",
              },
            },
          };
        },
        testbed: true,
      },
    );
    const testbed = installSlackTestbed(slack);
    const server = startOAuthServer(
      config,
      store,
      slack,
      runtimeJwtIssuer,
      undefined,
      testbed,
    );
    const baseUrl = `http://127.0.0.1:${server.port}`;

    try {
      const createResponse = await fetch(
        `${baseUrl}/__testbed/slack/events/message.im`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text: "create hourly cron job to look for latest AI news, summarize them in one paragraph and post result in this channel",
            user: testbedUserId,
          }),
        },
      );
      expect(createResponse.status).toBe(200);

      const jobs = store.listScheduledJobsForPrincipal(
        testbedWorkspaceId,
        testbedUserId,
      );
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        title: expect.stringMatching(/ai news/i),
        schedule: { kind: "cron", expression: "0 * * * *", timezone: "UTC" },
        runtimeType: "hermes",
      });
      expect(jobs[0]?.prompt.toLowerCase()).toContain("latest ai news");
      expect(jobs[0]?.prompt.toLowerCase()).toContain("summarize");
      expect(jobs[0]?.prompt.toLowerCase()).toContain("one paragraph");
      expect(jobs[0]?.prompt.toLowerCase()).not.toContain("this channel");
      expect(jobs[0]?.prompt.toLowerCase()).not.toContain("post result");

      const createTranscript = await fetch(
        `${baseUrl}/__testbed/slack/channels/${testbedDirectChannelId}/messages`,
      ).then(
        (response) =>
          response.json() as Promise<{ messages: Array<{ text: string }> }>,
      );
      const createText = createTranscript.messages
        .map((message) => message.text)
        .join("\n");
      expect(createText).toContain("Created scheduled job");
      expect(createText).toMatch(/ai news/i);
      expect(createText).not.toContain("Starting agent runtime");
      expect(createText).not.toContain("Runtime detail");

      const triggerResponse = await fetch(
        `${baseUrl}/__testbed/slack/events/message.im`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text: "test-run this job now",
            user: testbedUserId,
          }),
        },
      );
      expect(triggerResponse.status).toBe(200);
      const latestRun = store.getLatestAgentJobRunForPrincipal(
        testbedWorkspaceId,
        testbedUserId,
        jobs[0].jobId,
      );
      expect(latestRun?.status).toBe("queued");
    } finally {
      server.stop();
      store.close();
    }
  }, slackTestbedTimeoutMs);
});
