import { describe, expect, test } from "bun:test";
import { createTokenStore } from "../src/db";

describe("createTokenStore", () => {
  test("stores and consumes OAuth state with the Slack user id", () => {
    const store = createTokenStore(":memory:");

    const state = store.createOAuthState("U123");
    const row = store.consumeOAuthState(state);

    expect(row).toEqual({
      state,
      slackUserId: "U123",
      expiresAt: expect.any(String)
    });
    expect(store.consumeOAuthState(state)).toBeNull();

    store.close();
  });

  test("stores and reads connected users", () => {
    const store = createTokenStore(":memory:");

    store.upsertConnectedUser({
      email: "person@example.com",
      slackUserId: "U123",
      githubLogin: "octocat",
      githubToken: "gh-token"
    });

    expect(store.getConnectedUserByEmail("person@example.com")).toMatchObject({
      email: "person@example.com",
      slackUserId: "U123",
      githubLogin: "octocat",
      githubToken: "gh-token"
    });

    store.close();
  });

  test("creates stable per-principal agent runtime records", () => {
    const store = createTokenStore(":memory:");

    const first = store.getOrCreateAgentRuntime({
      workspaceId: "T123",
      slackUserId: "U123",
      engine: "openclaw",
      endpointUrl: "http://runtime-u123:8080",
      authTokenHash: "hash-u123",
      statePath: "/data/runtimes/u123/state",
      configPath: "/data/runtimes/u123/config/openclaw.json",
      workspacePath: "/data/runtimes/u123/workspace"
    });
    const second = store.getOrCreateAgentRuntime({
      workspaceId: "T123",
      slackUserId: "U123",
      engine: "openclaw",
      endpointUrl: "http://runtime-u123-new:8080",
      authTokenHash: "hash-new",
      statePath: "/new/state",
      configPath: "/new/config.json",
      workspacePath: "/new/workspace"
    });
    const otherUser = store.getOrCreateAgentRuntime({
      workspaceId: "T123",
      slackUserId: "U456",
      engine: "openclaw",
      endpointUrl: "http://runtime-u456:8080",
      authTokenHash: "hash-u456",
      statePath: "/data/runtimes/u456/state",
      configPath: "/data/runtimes/u456/config/openclaw.json",
      workspacePath: "/data/runtimes/u456/workspace"
    });

    expect(second).toEqual(first);
    expect(otherUser.id).not.toBe(first.id);
    expect(first).toMatchObject({
      workspaceId: "T123",
      slackUserId: "U123",
      engine: "openclaw",
      status: "ready",
      endpointUrl: "http://runtime-u123:8080",
      authTokenHash: "hash-u123"
    });

    store.close();
  });

  test("updates agent runtime status and usage timestamps", () => {
    const store = createTokenStore(":memory:");
    const runtime = store.getOrCreateAgentRuntime({
      workspaceId: "T123",
      slackUserId: "U123",
      engine: "openclaw",
      endpointUrl: "http://runtime-u123:8080",
      authTokenHash: "hash-u123",
      statePath: "/data/runtimes/u123/state",
      configPath: "/data/runtimes/u123/config/openclaw.json",
      workspacePath: "/data/runtimes/u123/workspace",
      now: new Date("2026-05-21T00:00:00.000Z")
    });

    store.updateAgentRuntimeStatus(runtime.id, {
      status: "failed",
      failureReason: "health check failed",
      now: new Date("2026-05-21T00:01:00.000Z")
    });
    store.touchAgentRuntime(runtime.id, new Date("2026-05-21T00:02:00.000Z"));

    expect(store.getAgentRuntime(runtime.id)).toMatchObject({
      id: runtime.id,
      status: "failed",
      failureReason: "health check failed",
      lastSeenAt: "2026-05-21T00:02:00.000Z",
      lastUsedAt: "2026-05-21T00:02:00.000Z"
    });

    store.close();
  });
});
