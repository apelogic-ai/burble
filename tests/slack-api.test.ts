import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config";
import {
  buildSlackOAuthUrl,
  exchangeSlackCode,
  searchSlackMessages,
  searchSlackUsers
} from "../src/slack-api";

const config: Config = {
  slackBotToken: "xoxb-test",
  slackAppToken: "xapp-test",
  slackClientId: "slack-client-id",
  slackClientSecret: "slack-client-secret",
  slackRedirectUri: "https://example.ngrok-free.app/oauth/slack/callback",
  githubClientId: "client-id",
  githubClientSecret: "client-secret",
  jiraClientId: null,
  jiraClientSecret: null,
  baseUrl: "https://example.ngrok-free.app",
  port: 3000,
  databasePath: ":memory:",
  slackLogLevel: "info",
  agentMode: "deterministic",
  agentRuntime: "ai-sdk",
  agentRuntimeFactory: "static",
  openClawNemoClawUrl: null,
  openClawNemoClawEngine: "openclaw",
  agentRuntimeDataRoot: "/data/runtimes",
  agentRuntimeDockerNetwork: "compose_default",
  agentRuntimeImage: "burble-openclaw-nemoclaw:dev",
  agentRuntimeIdleTtlMs: 1800000,
  agentRuntimeReaperIntervalMs: 60000,
  agentRuntimeJwtTtlSeconds: 604800,
  agentRuntimeTokenSecret: null,
  agentRuntimeToolGatewayUrl: "http://burble-app:3000/internal/tools",
  agentRuntimeMcpGatewayUrl: null,
  agentRuntimeMcpAudience: null,
  atlassianMcpUrl: "https://mcp.atlassian.com/v1/mcp",
  runtimeJwtIssuer: "https://example.ngrok-free.app",
  runtimeJwtPrivateKeyPath: null,
  openClawConfigPatchHostPath: null,
  internalApiToken: null,
  aiModel: "openai:gpt-5.4"
};

describe("buildSlackOAuthUrl", () => {
  test("builds a Slack user-token authorize URL", () => {
    const url = new URL(buildSlackOAuthUrl(config, "state-123"));

    expect(url.origin).toBe("https://slack.com");
    expect(url.pathname).toBe("/oauth/v2/authorize");
    expect(url.searchParams.get("client_id")).toBe("slack-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://example.ngrok-free.app/oauth/slack/callback"
    );
    expect(url.searchParams.get("user_scope")).toBe("search:read users:read");
    expect(url.searchParams.get("state")).toBe("state-123");
  });
});

describe("exchangeSlackCode", () => {
  test("exchanges a Slack OAuth code for an authed user token", async () => {
    const requests: Request[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return Response.json({
        ok: true,
        authed_user: {
          id: "U123",
          access_token: "xoxp-user-token",
          scope: "search:read users:read"
        }
      });
    }) as typeof fetch;

    try {
      const token = await exchangeSlackCode(config, "abc");
      expect(token).toEqual({
        accessToken: "xoxp-user-token",
        slackUserId: "U123",
        scope: "search:read users:read"
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const body = await requests[0].text();
    expect(body).toContain("client_id=slack-client-id");
    expect(body).toContain("code=abc");
  });
});

describe("Slack API helpers", () => {
  test("searchSlackUsers filters user list matches", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json({
        ok: true,
        members: [
          { id: "U123", name: "leo", real_name: "Leo Beliaev" },
          { id: "U456", name: "boris", real_name: "Boris Renski" }
        ]
      })) as unknown as typeof fetch;

    try {
      await expect(searchSlackUsers("xoxp", "boris")).resolves.toEqual([
        {
          id: "U456",
          name: "boris",
          realName: "Boris Renski"
        }
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("searchSlackMessages builds author and channel filters", async () => {
    const urls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return Response.json({
        ok: true,
        messages: {
          matches: [
            {
              channel: { id: "C123", name: "eng" },
              user: "U123",
              text: "ship it",
              permalink: "https://slack.test/archives/C123/p1"
            }
          ]
        }
      });
    }) as typeof fetch;

    try {
      const results = await searchSlackMessages("xoxp", {
        query: "ship",
        fromUserId: "U123",
        inChannel: "eng",
        limit: 3
      });
      expect(results).toEqual([
        {
          channelId: "C123",
          channelName: "eng",
          userId: "U123",
          text: "ship it",
          permalink: "https://slack.test/archives/C123/p1"
        }
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const url = new URL(urls[0]);
    expect(url.searchParams.get("query")).toBe("ship from:<@U123> in:eng");
    expect(url.searchParams.get("count")).toBe("3");
  });
});
