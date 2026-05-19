import { describe, expect, test } from "bun:test";
import { buildGitHubOAuthUrl } from "../src/github";
import type { Config } from "../src/config";

const config: Config = {
  slackBotToken: "xoxb-test",
  slackAppToken: "xapp-test",
  githubClientId: "client-id",
  githubClientSecret: "client-secret",
  baseUrl: "https://example.ngrok-free.app",
  port: 3000,
  databasePath: ":memory:",
  slackLogLevel: "info"
};

describe("buildGitHubOAuthUrl", () => {
  test("builds an authorize URL with callback, scopes, and state", () => {
    const url = new URL(buildGitHubOAuthUrl(config, "state-123"));

    expect(url.origin).toBe("https://github.com");
    expect(url.pathname).toBe("/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://example.ngrok-free.app/oauth/github/callback"
    );
    expect(url.searchParams.get("scope")).toBe("repo read:user user:email");
    expect(url.searchParams.get("state")).toBe("state-123");
  });
});
