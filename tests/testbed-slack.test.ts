import { describe, expect, test } from "bun:test";
import { readConfig } from "../src/config";
import { createTokenStore } from "../src/db";
import { createRuntimeJwtIssuer } from "../src/runtime-jwt";
import { createSlackRuntime } from "../src/slack";
import { startOAuthServer } from "../src/server";
import {
  installSlackTestbed,
  testbedDirectChannelId,
  testbedUserId,
  testbedWorkspaceId
} from "../src/testbed/slack";

describe("local Slack testbed", () => {
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
      AGENT_MODE: "deterministic"
    });
    const store = createTokenStore(":memory:");
    store.upsertWorkspacePolicy({
      workspaceId: testbedWorkspaceId,
      key: "runtime.allowedEngines",
      value: ["hermes", "openclaw"]
    });
    const runtimeJwtIssuer = createRuntimeJwtIssuer({
      issuer: config.runtimeJwtIssuer
    });
    const slack = createSlackRuntime(config, store, runtimeJwtIssuer, undefined, {
      testbed: true
    });
    const testbed = installSlackTestbed(slack);
    const server = startOAuthServer(
      config,
      store,
      slack,
      runtimeJwtIssuer,
      undefined,
      testbed
    );
    const baseUrl = `http://127.0.0.1:${server.port}`;

    try {
      const homeResponse = await fetch(
        `${baseUrl}/__testbed/slack/events/app_home_opened`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ user: testbedUserId })
        }
      );
      expect(homeResponse.status).toBe(200);

      const home = await fetch(
        `${baseUrl}/__testbed/slack/users/${testbedUserId}/home`
      ).then((response) => response.json() as Promise<{ home: unknown }>);
      expect(JSON.stringify(home.home)).toContain("Agent runtime");

      for (const engine of ["hermes", "openclaw"]) {
        const selectResponse = await fetch(`${baseUrl}/__testbed/slack/actions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            actionId: "agent_runtime_engine_select",
            selectedValue: engine,
            user: testbedUserId
          })
        });
        expect(selectResponse.status).toBe(200);
        const selectedHome = await fetch(
          `${baseUrl}/__testbed/slack/users/${testbedUserId}/home`
        ).then((response) => response.json() as Promise<{ home: unknown }>);
        expect(JSON.stringify(selectedHome.home)).toContain(engine);
      }

      const messageResponse = await fetch(
        `${baseUrl}/__testbed/slack/events/message.im`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "hello agent", user: testbedUserId })
        }
      );
      expect(messageResponse.status).toBe(200);

      const transcript = await fetch(
        `${baseUrl}/__testbed/slack/channels/${testbedDirectChannelId}/messages`
      ).then(
        (response) =>
          response.json() as Promise<{ messages: Array<{ text: string }> }>
      );
      expect(transcript.messages.length).toBeGreaterThan(0);
      expect(transcript.messages.some((message) => message.text.trim())).toBe(true);
    } finally {
      server.stop();
      store.close();
    }
  });

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
      AGENT_RUNTIME_URL: "http://127.0.0.1:9"
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
        every: { hours: 1 }
      },
      runtimeType: "hermes",
      state: "scheduled",
      now: new Date("2026-06-25T16:00:00.000Z")
    });
    const runtimeJwtIssuer = createRuntimeJwtIssuer({
      issuer: config.runtimeJwtIssuer
    });
    const slack = createSlackRuntime(config, store, runtimeJwtIssuer, undefined, {
      testbed: true
    });
    const testbed = installSlackTestbed(slack);
    const server = startOAuthServer(
      config,
      store,
      slack,
      runtimeJwtIssuer,
      undefined,
      testbed
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
            user: testbedUserId
          })
        }
      );
      expect(messageResponse.status).toBe(200);

      const transcript = await fetch(
        `${baseUrl}/__testbed/slack/channels/${testbedDirectChannelId}/messages`
      ).then(
        (response) =>
          response.json() as Promise<{ messages: Array<{ text: string }> }>
      );
      const text = transcript.messages.map((message) => message.text).join("\n");
      expect(text).toContain("Scheduled jobs");
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
            user: testbedUserId
          })
        }
      );
      expect(triggerResponse.status).toBe(200);

      const triggeredTranscript = await fetch(
        `${baseUrl}/__testbed/slack/channels/${testbedDirectChannelId}/messages`
      ).then(
        (response) =>
          response.json() as Promise<{ messages: Array<{ text: string }> }>
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
        "ai-news-hourly"
      );
      expect(latestRun?.jobId).toBe("ai-news-hourly");
      expect(latestRun?.triggerSource).toBe("manual");
      expect(latestRun?.status).toBe("queued");
    } finally {
      server.stop();
      store.close();
    }
  });
});
