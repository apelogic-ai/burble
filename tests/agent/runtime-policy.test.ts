import { describe, expect, test } from "bun:test";
import type { Config } from "../../src/config";
import { createTokenStore } from "../../src/db";
import { buildRuntimeManifestForPrincipal } from "../../src/agent/runtime-policy";

const config: Config = {
  slackBotToken: "xoxb-test",
  slackAppToken: "xapp-test",
  slackClientId: null,
  slackClientSecret: null,
  slackRedirectUri: "https://example.ngrok-free.app/oauth/slack/callback",
  githubClientId: "client-id",
  githubClientSecret: "client-secret",
  jiraClientId: null,
  jiraClientSecret: null,
  googleClientId: null,
  googleClientSecret: null,
  baseUrl: "https://example.ngrok-free.app",
  port: 3000,
  databasePath: ":memory:",
  slackLogLevel: "info",
  agentMode: "deterministic",
  agentFastTrack: false,
  agentRuntime: "ai-sdk",
  agentRuntimeFactory: "static",
  openClawNemoClawUrl: null,
  agentRuntimeEngine: "openclaw",
  openClawNemoClawEngine: "openclaw",
  agentRuntimeDataRoot: "/data/runtimes",
  agentRuntimeDockerNetwork: "compose_default",
  agentRuntimeImage: "burble-openclaw-nemoclaw:dev",
  agentRuntimeIdleTtlMs: 86400000,
  agentRuntimeReaperEnabled: true,
  agentRuntimeReaperIntervalMs: 60000,
  agentRuntimeJwtTtlSeconds: 604800,
  agentRuntimeTokenSecret: null,
  agentRuntimeToolGatewayUrl: "http://burble-app:3000/internal/tools",
  agentRuntimeMcpGatewayUrl: "http://agentgateway:3000/mcp",
  agentRuntimeMcpAudience: "http://agentgateway:3000/mcp",
  atlassianMcpUrl: "https://mcp.atlassian.com/v1/mcp",
  runtimeJwtIssuer: "http://burble-app:3000",
  runtimeJwtPrivateKeyPath: null,
  openClawConfigPatchHostPath: null,
  internalApiToken: null,
  aiModel: "openai:gpt-5.4"
};

describe("buildRuntimeManifestForPrincipal", () => {
  test("uses typed workspace and user skill records when present", () => {
    const store = createTokenStore(":memory:");
    store.upsertWorkspaceSkill({
      workspaceId: "T123",
      skillId: "core",
      version: "1",
      enabled: true,
      now: new Date("2026-05-28T00:00:00.000Z")
    });
    store.upsertWorkspaceSkill({
      workspaceId: "T123",
      skillId: "github",
      version: "1",
      enabled: false,
      now: new Date("2026-05-28T00:01:00.000Z")
    });
    store.upsertUserSkill({
      workspaceId: "T123",
      slackUserId: "U123",
      skillId: "core",
      version: "1",
      enabled: true,
      now: new Date("2026-05-28T00:02:00.000Z")
    });
    store.upsertUserSkill({
      workspaceId: "T123",
      slackUserId: "U123",
      skillId: "github",
      version: "1",
      enabled: true,
      now: new Date("2026-05-28T00:03:00.000Z")
    });

    const manifest = buildRuntimeManifestForPrincipal({
      config,
      store,
      principal: {
        workspaceId: "T123",
        slackUserId: "U123"
      },
      engine: "openclaw"
    });

    expect(manifest.skills).toEqual([{ id: "core", version: "1", enabled: true }]);
    store.close();
  });
});
