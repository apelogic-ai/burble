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
});
