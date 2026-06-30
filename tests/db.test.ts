import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    expect(store.getConnection("github", "person@example.com")).toMatchObject({
      provider: "github",
      email: "person@example.com",
      slackUserId: "U123",
      providerLogin: "octocat",
      accessToken: "gh-token"
    });
    expect(store.getConnectionForSlackUser("github", "U123")).toMatchObject({
      provider: "github",
      email: "person@example.com",
      slackUserId: "U123",
      providerLogin: "octocat",
      accessToken: "gh-token"
    });

    store.close();
  });

  test("stores provider-shaped Jira connections", () => {
    const store = createTokenStore(":memory:");

    store.upsertProviderConnection({
      provider: "jira",
      email: "person@example.com",
      slackUserId: "U123",
      providerLogin: "person@atlassian.example",
      accessToken: "jira-token",
      refreshToken: "jira-refresh-token",
      accessTokenExpiresAt: "2026-05-23T06:00:00.000Z"
    });

    expect(store.getConnection("jira", "person@example.com")).toMatchObject({
      provider: "jira",
      email: "person@example.com",
      slackUserId: "U123",
      providerLogin: "person@atlassian.example",
      accessToken: "jira-token",
      refreshToken: "jira-refresh-token",
      accessTokenExpiresAt: "2026-05-23T06:00:00.000Z"
    });
    expect(store.getConnectionForSlackUser("jira", "U123")).toMatchObject({
      provider: "jira",
      email: "person@example.com",
      slackUserId: "U123",
      providerLogin: "person@atlassian.example",
      accessToken: "jira-token",
      refreshToken: "jira-refresh-token",
      accessTokenExpiresAt: "2026-05-23T06:00:00.000Z"
    });

    store.close();
  });

  test("deletes provider connections by Slack user", () => {
    const store = createTokenStore(":memory:");

    store.upsertProviderConnection({
      provider: "jira",
      email: "person@example.com",
      slackUserId: "U123",
      providerLogin: "person@atlassian.example",
      accessToken: "jira-token"
    });

    expect(store.deleteConnectionForSlackUser("jira", "U123")).toBe(true);
    expect(store.getConnection("jira", "person@example.com")).toBeNull();
    expect(store.getConnectionForSlackUser("jira", "U123")).toBeNull();
    expect(store.deleteConnectionForSlackUser("jira", "U123")).toBe(false);

    store.close();
  });

  test("deletes legacy GitHub user connections by Slack user", () => {
    const store = createTokenStore(":memory:");

    store.upsertConnectedUser({
      email: "person@example.com",
      slackUserId: "U123",
      githubLogin: "octocat",
      githubToken: "gh-token"
    });

    expect(store.deleteConnectionForSlackUser("github", "U123")).toBe(true);
    expect(store.getConnection("github", "person@example.com")).toBeNull();
    expect(store.getConnectionForSlackUser("github", "U123")).toBeNull();

    store.close();
  });

  test("migrates existing provider connections with refresh-token columns", () => {
    const path = join(mkdtempSync(join(tmpdir(), "burble-db-")), "burble.db");
    const db = new Database(path);
    db.exec(`
      CREATE TABLE provider_connections (
        provider TEXT NOT NULL,
        email TEXT NOT NULL,
        slack_user_id TEXT NOT NULL,
        provider_login TEXT NOT NULL,
        access_token TEXT NOT NULL,
        connected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(provider, email)
      );
    `);
    db.close();

    const store = createTokenStore(path);
    store.upsertProviderConnection({
      provider: "jira",
      email: "person@example.com",
      slackUserId: "U123",
      providerLogin: "person@atlassian.example",
      accessToken: "jira-token",
      refreshToken: "jira-refresh-token",
      accessTokenExpiresAt: "2026-05-23T06:00:00.000Z"
    });

    expect(store.getConnection("jira", "person@example.com")).toMatchObject({
      refreshToken: "jira-refresh-token",
      accessTokenExpiresAt: "2026-05-23T06:00:00.000Z"
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
      workspacePath: "/new/workspace",
      sandboxId: "sandbox-u123"
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

    expect(second.id).toBe(first.id);
    expect(otherUser.id).not.toBe(first.id);
    expect(second).toMatchObject({
      workspaceId: "T123",
      slackUserId: "U123",
      engine: "openclaw",
      status: "ready",
      endpointUrl: "http://runtime-u123-new:8080",
      authTokenHash: "hash-new",
      statePath: "/new/state",
      configPath: "/new/config.json",
      workspacePath: "/new/workspace",
      sandboxId: "sandbox-u123",
      policyHash: null
    });

    store.close();
  });

  test("updates runtime policy hashes and records policy drift", () => {
    const store = createTokenStore(":memory:");

    const first = store.getOrCreateAgentRuntime({
      workspaceId: "T123",
      slackUserId: "U123",
      engine: "openclaw",
      endpointUrl: "http://runtime-u123:8080",
      authTokenHash: "hash-u123",
      statePath: "/data/runtimes/u123/state",
      configPath: "/data/runtimes/u123/config/openclaw.json",
      workspacePath: "/data/runtimes/u123/workspace",
      policyHash: "policy-a",
      now: new Date("2026-05-21T00:00:00.000Z")
    });
    const second = store.getOrCreateAgentRuntime({
      workspaceId: "T123",
      slackUserId: "U123",
      engine: "openclaw",
      endpointUrl: "http://runtime-u123:8080",
      authTokenHash: "hash-u123",
      statePath: "/data/runtimes/u123/state",
      configPath: "/data/runtimes/u123/config/openclaw.json",
      workspacePath: "/data/runtimes/u123/workspace",
      policyHash: "policy-b",
      now: new Date("2026-05-21T00:01:00.000Z")
    });

    expect(second.id).toBe(first.id);
    expect(second.policyHash).toBe("policy-b");
    expect(second.lastSeenAt).toBe("2026-05-21T00:01:00.000Z");
    expect(store.listAgentRuntimeEvents(first.id)).toMatchObject([
      {
        eventType: "runtime_policy_changed",
        summaryJson: JSON.stringify({
          previousPolicyHash: "policy-a",
          policyHash: "policy-b"
        })
      }
    ]);

    store.close();
  });

  test("migrates legacy Burble direct runtime rows to Burble Native", () => {
    const path = join(mkdtempSync(join(tmpdir(), "burble-db-")), "burble.db");
    let store = createTokenStore(path);
    store.close();

    const db = new Database(path);
    db.query(
      `
      INSERT INTO agent_runtimes (
        id,
        workspace_id,
        slack_user_id,
        engine,
        status,
        endpoint_url,
        auth_token_hash,
        state_path,
        config_path,
        workspace_path,
        sandbox_id,
        policy_hash,
        created_at,
        last_seen_at,
        last_used_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    ).run(
      "rt_legacy_direct",
      "T123",
      "U123",
      "burble-direct",
      "idle",
      "http://runtime-u123:8080",
      "hash-u123",
      "/data/runtimes/u123/state",
      "/data/runtimes/u123/config/openclaw.json",
      "/data/runtimes/u123/workspace",
      null,
      null,
      "2026-05-21T00:00:00.000Z",
      "2026-05-21T00:00:00.000Z",
      "2026-05-21T00:00:00.000Z"
    );
    db.close();

    store = createTokenStore(path);

    expect(store.getAgentRuntime("rt_legacy_direct")).toMatchObject({
      id: "rt_legacy_direct",
      engine: "burble-native"
    });
    expect(
      store.getAgentRuntimeForPrincipal({
        workspaceId: "T123",
        slackUserId: "U123",
        engine: "burble-native"
      })?.id
    ).toBe("rt_legacy_direct");
    expect(
      store
        .listIdleAgentRuntimes(new Date("2026-05-21T00:01:00.000Z"))
        .map((runtime) => [runtime.id, runtime.engine])
    ).toContainEqual(["rt_legacy_direct", "burble-native"]);

    store.close();
  });

  test("skips unrecognized idle runtime engines without poisoning the batch", () => {
    const path = join(mkdtempSync(join(tmpdir(), "burble-db-")), "burble.db");
    let store = createTokenStore(path);
    store.close();

    const db = new Database(path);
    const insert = db.query(`
      INSERT INTO agent_runtimes (
        id,
        workspace_id,
        slack_user_id,
        engine,
        status,
        endpoint_url,
        auth_token_hash,
        state_path,
        config_path,
        workspace_path,
        sandbox_id,
        policy_hash,
        created_at,
        last_seen_at,
        last_used_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [id, userId, engine] of [
      ["rt_valid", "U100", "openclaw"],
      ["rt_legacy_openclaw", "U101", "openclaw-cli"],
      ["rt_unknown", "U102", "retired-engine"]
    ]) {
      insert.run(
        id,
        "T123",
        userId,
        engine,
        "idle",
        `http://${id}:8080`,
        `hash-${id}`,
        `/data/${id}/state`,
        `/data/${id}/config.json`,
        `/data/${id}/workspace`,
        null,
        null,
        "2026-05-21T00:00:00.000Z",
        "2026-05-21T00:00:00.000Z",
        "2026-05-21T00:00:00.000Z"
      );
    }
    db.close();

    store = createTokenStore(path);

    expect(store.getAgentRuntime("rt_unknown")).toBeNull();
    expect(
      store
        .listIdleAgentRuntimes(new Date("2026-05-21T00:01:00.000Z"))
        .map((runtime) => [runtime.id, runtime.engine])
    ).toEqual([
      ["rt_valid", "openclaw"],
      ["rt_legacy_openclaw", "openclaw"]
    ]);

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

  test("lists principal runtimes newest active usage first", () => {
    const store = createTokenStore(":memory:");
    const openclaw = store.getOrCreateAgentRuntime({
      workspaceId: "T123",
      slackUserId: "U123",
      engine: "openclaw",
      endpointUrl: "http://runtime-openclaw:8080",
      authTokenHash: "hash-openclaw",
      statePath: "/data/runtimes/u123/openclaw/state",
      configPath: "/data/runtimes/u123/openclaw/config.json",
      workspacePath: "/data/runtimes/u123/openclaw/workspace",
      now: new Date("2026-05-21T00:00:00.000Z")
    });
    const hermes = store.getOrCreateAgentRuntime({
      workspaceId: "T123",
      slackUserId: "U123",
      engine: "hermes",
      endpointUrl: "http://runtime-hermes:8080",
      authTokenHash: "hash-hermes",
      statePath: "/data/runtimes/u123/hermes/state",
      configPath: "/data/runtimes/u123/hermes/config.json",
      workspacePath: "/data/runtimes/u123/hermes/workspace",
      now: new Date("2026-05-21T00:01:00.000Z")
    });
    store.updateAgentRuntimeStatus(openclaw.id, {
      status: "stopped",
      now: new Date("2026-05-21T00:02:00.000Z")
    });
    store.touchAgentRuntime(hermes.id, new Date("2026-05-21T00:03:00.000Z"));

    expect(
      store
        .listAgentRuntimesForPrincipal({
          workspaceId: "T123",
          slackUserId: "U123"
        })
        .map((runtime) => [runtime.id, runtime.engine, runtime.status])
    ).toEqual([
      [hermes.id, "hermes", "ready"],
      [openclaw.id, "openclaw", "stopped"]
    ]);

    store.close();
  });

  test("lists stale ready and idle runtimes for reaping", () => {
    const store = createTokenStore(":memory:");
    const staleReady = store.getOrCreateAgentRuntime({
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
    const staleIdle = store.getOrCreateAgentRuntime({
      workspaceId: "T123",
      slackUserId: "U456",
      engine: "openclaw",
      endpointUrl: "http://runtime-u456:8080",
      authTokenHash: "hash-u456",
      statePath: "/data/runtimes/u456/state",
      configPath: "/data/runtimes/u456/config/openclaw.json",
      workspacePath: "/data/runtimes/u456/workspace",
      now: new Date("2026-05-21T00:01:00.000Z")
    });
    const busy = store.getOrCreateAgentRuntime({
      workspaceId: "T123",
      slackUserId: "U789",
      engine: "openclaw",
      endpointUrl: "http://runtime-u789:8080",
      authTokenHash: "hash-u789",
      statePath: "/data/runtimes/u789/state",
      configPath: "/data/runtimes/u789/config/openclaw.json",
      workspacePath: "/data/runtimes/u789/workspace",
      now: new Date("2026-05-21T00:02:00.000Z")
    });
    store.updateAgentRuntimeStatus(staleIdle.id, {
      status: "idle",
      now: new Date("2026-05-21T00:03:00.000Z")
    });
    store.updateAgentRuntimeStatus(busy.id, {
      status: "busy",
      now: new Date("2026-05-21T00:03:00.000Z")
    });

    expect(
      store
        .listIdleAgentRuntimes(new Date("2026-05-21T00:01:00.000Z"))
        .map((runtime) => runtime.id)
    ).toEqual([staleReady.id, staleIdle.id]);

    store.close();
  });

  test("records runtime audit events without secrets", () => {
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

    store.recordAgentRuntimeEvent({
      runtimeId: runtime.id,
      eventType: "runtime_tool_called",
      summary: {
        toolName: "github.listAssignedIssues",
        classification: "user_private"
      },
      now: new Date("2026-05-21T00:01:00.000Z")
    });

    const events = store.listAgentRuntimeEvents(runtime.id);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      runtimeId: runtime.id,
      workspaceId: "T123",
      slackUserId: "U123",
      eventType: "runtime_tool_called",
      createdAt: "2026-05-21T00:01:00.000Z"
    });
    expect(JSON.parse(events[0].summaryJson)).toEqual({
      toolName: "github.listAssignedIssues",
      classification: "user_private"
    });
    expect(events[0].summaryJson).not.toContain("token");

    store.close();
  });

  test("stores durable conversation routes without credentials", () => {
    const store = createTokenStore(":memory:");

    const route = store.upsertConversationRoute({
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destination: {
        channelId: "C123",
        threadTs: "1779841118.237"
      },
      now: new Date("2026-05-26T00:00:00.000Z")
    });

    expect(route.id).toMatch(/^convrt_[0-9a-f]{24}$/);
    expect(route).toMatchObject({
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
      revokedAt: null,
      kind: "origin",
      grantedBySlackUserId: null,
      expiresAt: null,
      bindingJson: null,
      lastDeliveryFailureAt: null,
      lastDeliveryFailureCode: null,
      lastDeliveryFailureNotifiedAt: null,
      consecutiveDeliveryFailures: 0
    });
    expect(JSON.parse(route.destinationJson)).toEqual({
      channelId: "C123",
      threadTs: "1779841118.237"
    });
    expect(route.destinationJson).not.toContain("xox");

    expect(store.getConversationRoute(route.id)).toMatchObject({
      id: route.id,
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destinationJson: route.destinationJson,
      kind: "origin",
      grantedBySlackUserId: null,
      expiresAt: null,
      bindingJson: null
    });

    store.close();
  });

  test("stores channel destination grants with binding metadata", () => {
    const store = createTokenStore(":memory:");

    const route = store.upsertConversationRoute({
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destination: {
        channelId: "C123",
        isDirectMessage: false,
        rootId: "channel:C123"
      },
      kind: "grant",
      grantedBySlackUserId: "U123",
      expiresAt: "2026-06-30T00:00:00.000Z",
      binding: {
        jobId: "job-daily-standup",
        runtimeId: "rt_123"
      },
      now: new Date("2026-05-26T00:00:00.000Z")
    });

    expect(route).toMatchObject({
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      kind: "grant",
      grantedBySlackUserId: "U123",
      expiresAt: "2026-06-30T00:00:00.000Z",
      revokedAt: null
    });
    expect(JSON.parse(route.destinationJson)).toEqual({
      channelId: "C123",
      isDirectMessage: false,
      rootId: "channel:C123"
    });
    expect(JSON.parse(route.bindingJson ?? "{}")).toEqual({
      jobId: "job-daily-standup",
      runtimeId: "rt_123"
    });

    expect(store.getConversationRoute(route.id)).toEqual(route);

    store.close();
  });

  test("tracks and resets conversation route delivery failures", () => {
    const store = createTokenStore(":memory:");

    const route = store.upsertConversationRoute({
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destination: {
        channelId: "C123",
        isDirectMessage: false,
        rootId: "channel:C123"
      },
      kind: "grant",
      now: new Date("2026-05-26T00:00:00.000Z")
    });

    const failed = store.recordConversationRouteDeliveryFailure({
      routeId: route.id,
      code: "not_in_channel",
      notificationSent: true,
      now: new Date("2026-05-26T01:00:00.000Z")
    });

    expect(failed).toMatchObject({
      id: route.id,
      lastDeliveryFailureAt: "2026-05-26T01:00:00.000Z",
      lastDeliveryFailureCode: "not_in_channel",
      lastDeliveryFailureNotifiedAt: "2026-05-26T01:00:00.000Z",
      consecutiveDeliveryFailures: 1
    });

    const failedAgain = store.recordConversationRouteDeliveryFailure({
      routeId: route.id,
      code: "restricted_action",
      notificationSent: false,
      now: new Date("2026-05-26T02:00:00.000Z")
    });

    expect(failedAgain).toMatchObject({
      id: route.id,
      lastDeliveryFailureAt: "2026-05-26T02:00:00.000Z",
      lastDeliveryFailureCode: "restricted_action",
      lastDeliveryFailureNotifiedAt: "2026-05-26T01:00:00.000Z",
      consecutiveDeliveryFailures: 2
    });

    const reset = store.resetConversationRouteDeliveryFailure({
      routeId: route.id,
      now: new Date("2026-05-26T03:00:00.000Z")
    });

    expect(reset).toMatchObject({
      id: route.id,
      lastDeliveryFailureAt: null,
      lastDeliveryFailureCode: null,
      lastDeliveryFailureNotifiedAt: null,
      consecutiveDeliveryFailures: 0
    });

    store.close();
  });

  test("preserves bound grant delivery health across scheduled re-registration", () => {
    const store = createTokenStore(":memory:");
    const input = {
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack" as const,
      destination: {
        channelId: "C123",
        isDirectMessage: false,
        rootId: "channel:C123"
      },
      kind: "grant" as const,
      binding: {
        jobId: "job-daily-standup",
        runtimeId: "rt_123"
      },
      now: new Date("2026-05-26T00:00:00.000Z")
    };

    const route = store.upsertConversationRoute(input);
    store.recordConversationRouteDeliveryFailure({
      routeId: route.id,
      code: "not_in_channel",
      notificationSent: true,
      now: new Date("2026-05-26T01:00:00.000Z")
    });
    store.revokeConversationRoute({
      routeId: route.id,
      now: new Date("2026-05-26T02:00:00.000Z")
    });

    const upserted = store.upsertConversationRoute({
      ...input,
      now: new Date("2026-05-26T03:00:00.000Z")
    });

    expect(upserted).toMatchObject({
      id: route.id,
      lastDeliveryFailureAt: "2026-05-26T01:00:00.000Z",
      lastDeliveryFailureCode: "not_in_channel",
      lastDeliveryFailureNotifiedAt: "2026-05-26T01:00:00.000Z",
      consecutiveDeliveryFailures: 1,
      revokedAt: "2026-05-26T02:00:00.000Z"
    });

    store.close();
  });

  test("revokes one conversation route by id", () => {
    const store = createTokenStore(":memory:");
    const destination = {
      channelId: "C123",
      isDirectMessage: false,
      rootId: "channel:C123"
    };
    const first = store.upsertConversationRoute({
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destination,
      kind: "grant"
    });
    const second = store.upsertConversationRoute({
      workspaceId: "T123",
      slackUserId: "U456",
      transport: "slack",
      destination,
      kind: "grant"
    });

    const revoked = store.revokeConversationRoute({
      routeId: first.id,
      now: new Date("2026-05-26T01:00:00.000Z")
    });

    expect(revoked).toMatchObject({
      id: first.id,
      revokedAt: "2026-05-26T01:00:00.000Z"
    });
    expect(store.getConversationRoute(first.id)?.revokedAt).toBe(
      "2026-05-26T01:00:00.000Z"
    );
    expect(store.getConversationRoute(second.id)?.revokedAt).toBeNull();
    expect(store.revokeConversationRoute({ routeId: first.id })).toBeNull();

    store.close();
  });

  test("does not record delivery failures on revoked conversation routes", () => {
    const store = createTokenStore(":memory:");
    const route = store.upsertConversationRoute({
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destination: {
        channelId: "C123",
        isDirectMessage: false,
        rootId: "channel:C123"
      },
      kind: "grant",
      now: new Date("2026-05-26T00:00:00.000Z")
    });
    store.revokeConversationRoute({
      routeId: route.id,
      now: new Date("2026-05-26T01:00:00.000Z")
    });

    const failed = store.recordConversationRouteDeliveryFailure({
      routeId: route.id,
      code: "not_in_channel",
      notificationSent: true,
      now: new Date("2026-05-26T02:00:00.000Z")
    });

    expect(failed).toMatchObject({
      id: route.id,
      revokedAt: "2026-05-26T01:00:00.000Z",
      lastDeliveryFailureAt: null,
      consecutiveDeliveryFailures: 0
    });

    store.close();
  });

  test("revokes all conversation grants for a workspace destination", () => {
    const store = createTokenStore(":memory:");
    const destination = {
      channelId: "C123",
      isDirectMessage: false,
      rootId: "channel:C123"
    };
    const first = store.upsertConversationRoute({
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destination,
      kind: "grant"
    });
    const second = store.upsertConversationRoute({
      workspaceId: "T123",
      slackUserId: "U456",
      transport: "slack",
      destination,
      kind: "grant"
    });
    const otherWorkspace = store.upsertConversationRoute({
      workspaceId: "T999",
      slackUserId: "U123",
      transport: "slack",
      destination,
      kind: "grant"
    });

    const revoked = store.revokeConversationRoutesForDestination({
      workspaceId: "T123",
      transport: "slack",
      destination,
      kind: "grant",
      now: new Date("2026-05-26T01:00:00.000Z")
    });

    expect(revoked).toBe(2);
    expect(store.getConversationRoute(first.id)?.revokedAt).toBe(
      "2026-05-26T01:00:00.000Z"
    );
    expect(store.getConversationRoute(second.id)?.revokedAt).toBe(
      "2026-05-26T01:00:00.000Z"
    );
    expect(store.getConversationRoute(otherWorkspace.id)?.revokedAt).toBeNull();
    expect(
      store.revokeConversationRoutesForDestination({
        workspaceId: "T123",
        transport: "slack",
        destination,
        kind: "grant"
      })
    ).toBe(0);

    store.close();
  });

  test("finds private Slack channel grant routes by channel", () => {
    const store = createTokenStore(":memory:");
    const route = store.upsertConversationRoute({
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destination: {
        channelId: "G123",
        isDirectMessage: false,
        isPrivateChannel: true,
        rootId: "channel:G123"
      },
      kind: "grant"
    });

    expect(
      store.getConversationGrantRouteForSlackChannel({
        workspaceId: "T123",
        slackUserId: "U123",
        channelId: "G123"
      })?.id
    ).toBe(route.id);

    store.close();
  });

  test("migrates existing conversation routes with grant columns", () => {
    const path = join(mkdtempSync(join(tmpdir(), "burble-db-")), "burble.db");
    const db = new Database(path);
    db.exec(`
      CREATE TABLE conversation_routes (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        slack_user_id TEXT NOT NULL,
        transport TEXT NOT NULL,
        destination_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revoked_at TEXT
      );
      INSERT INTO conversation_routes (
        id,
        workspace_id,
        slack_user_id,
        transport,
        destination_json,
        created_at,
        updated_at,
        revoked_at
      )
      VALUES (
        'convrt_existing',
        'T123',
        'U123',
        'slack',
        '{"channelId":"D123","isDirectMessage":true,"rootId":"dm:D123"}',
        '2026-05-26T00:00:00.000Z',
        '2026-05-26T00:00:00.000Z',
        NULL
      );
    `);
    db.close();

    const store = createTokenStore(path);

    expect(store.getConversationRoute("convrt_existing")).toMatchObject({
      id: "convrt_existing",
      kind: "origin",
      grantedBySlackUserId: null,
      expiresAt: null,
      bindingJson: null
    });

    store.close();
  });

  test("reuses the same conversation route for the same destination", () => {
    const store = createTokenStore(":memory:");
    const destination = {
      channelId: "D123",
      isDirectMessage: true,
      rootId: "dm:D123"
    };

    const first = store.upsertConversationRoute({
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destination,
      now: new Date("2026-05-26T00:00:00.000Z")
    });
    const second = store.upsertConversationRoute({
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destination: {
        rootId: "dm:D123",
        isDirectMessage: true,
        channelId: "D123"
      },
      now: new Date("2026-05-26T01:00:00.000Z")
    });
    const threaded = store.upsertConversationRoute({
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destination: {
        ...destination,
        threadTs: "1779841118.237"
      },
      now: new Date("2026-05-26T02:00:00.000Z")
    });

    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe("2026-05-26T00:00:00.000Z");
    expect(second.updatedAt).toBe("2026-05-26T01:00:00.000Z");
    expect(JSON.parse(second.destinationJson)).toEqual(destination);
    expect(threaded.id).not.toBe(first.id);

    store.close();
  });

  test("stores workspace policy and user preferences as stable JSON records", () => {
    const store = createTokenStore(":memory:");

    const policy = store.upsertWorkspacePolicy({
      workspaceId: "T123",
      key: "providers.allowed",
      value: ["github", "google"],
      updatedBySlackUserId: "UADMIN",
      now: new Date("2026-05-28T00:00:00.000Z")
    });
    const preference = store.upsertUserPreference({
      workspaceId: "T123",
      slackUserId: "U123",
      key: "github.defaults",
      value: {
        repoAliases: {
          burble: "apelogic-ai/burble"
        },
        org: "apelogic-ai"
      },
      now: new Date("2026-05-28T00:01:00.000Z")
    });

    expect(policy).toEqual({
      workspaceId: "T123",
      key: "providers.allowed",
      value: ["github", "google"],
      updatedBySlackUserId: "UADMIN",
      updatedAt: "2026-05-28T00:00:00.000Z"
    });
    expect(preference).toEqual({
      workspaceId: "T123",
      slackUserId: "U123",
      key: "github.defaults",
      value: {
        org: "apelogic-ai",
        repoAliases: {
          burble: "apelogic-ai/burble"
        }
      },
      updatedAt: "2026-05-28T00:01:00.000Z"
    });
    expect(store.getWorkspacePolicy("T123", "providers.allowed")).toEqual(policy);
    expect(store.getUserPreference("T123", "U123", "github.defaults")).toEqual(
      preference
    );
    expect(store.listWorkspacePolicy("T123").map((record) => record.key)).toEqual([
      "providers.allowed"
    ]);
    expect(
      store.listUserPreferences("T123", "U123").map((record) => record.key)
    ).toEqual(["github.defaults"]);

    store.close();
  });

  test("stores inspectable and deletable scoped agent memory", () => {
    const store = createTokenStore(":memory:");

    const userMemory = store.upsertAgentMemory({
      workspaceId: "T123",
      scope: "user",
      ownerId: "U123",
      key: "github.defaultOrg",
      value: "apelogic-ai",
      now: new Date("2026-05-28T00:00:00.000Z")
    });
    store.upsertAgentMemory({
      workspaceId: "T123",
      scope: "workspace",
      key: "deployment.region",
      value: { primary: "us-west" },
      now: new Date("2026-05-28T00:01:00.000Z")
    });
    store.upsertAgentMemory({
      workspaceId: "T123",
      scope: "job",
      ownerId: "job-123",
      key: "seenPullRequests",
      value: ["https://github.com/acme/app/pull/1"],
      now: new Date("2026-05-28T00:02:00.000Z")
    });

    expect(userMemory).toEqual({
      workspaceId: "T123",
      scope: "user",
      ownerId: "U123",
      key: "github.defaultOrg",
      value: "apelogic-ai",
      updatedAt: "2026-05-28T00:00:00.000Z"
    });
    expect(
      store.listAgentMemory({
        workspaceId: "T123",
        scope: "workspace"
      })
    ).toEqual([
      {
        workspaceId: "T123",
        scope: "workspace",
        ownerId: "",
        key: "deployment.region",
        value: { primary: "us-west" },
        updatedAt: "2026-05-28T00:01:00.000Z"
      }
    ]);
    expect(
      store.listAgentMemory({
        workspaceId: "T123",
        scope: "job",
        ownerId: "job-123"
      })
    ).toHaveLength(1);

    store.deleteAgentMemory({
      workspaceId: "T123",
      scope: "user",
      ownerId: "U123",
      key: "github.defaultOrg"
    });
    expect(
      store.listAgentMemory({
        workspaceId: "T123",
        scope: "user",
        ownerId: "U123"
      })
    ).toEqual([]);
    expect(() =>
      store.listAgentMemory({
        workspaceId: "T123",
        scope: "job"
      })
    ).toThrow("job memory requires an owner id");

    store.close();
  });

  test("stores durable job state by job id", () => {
    const store = createTokenStore(":memory:");

    const first = store.upsertAgentJobState({
      jobId: "job-123",
      workspaceId: "T123",
      slackUserId: "U123",
      state: {
        lastNotifiedPullRequest: "https://github.com/acme/app/pull/1",
        seen: [1, 2]
      },
      now: new Date("2026-05-28T00:00:00.000Z")
    });
    store.upsertAgentJobState({
      jobId: "job-456",
      workspaceId: "T123",
      slackUserId: "U123",
      state: { cursor: "abc" },
      now: new Date("2026-05-28T00:01:00.000Z")
    });
    const updated = store.upsertAgentJobState({
      jobId: "job-123",
      workspaceId: "T123",
      slackUserId: "U123",
      state: {
        lastNotifiedPullRequest: "https://github.com/acme/app/pull/2",
        seen: [1, 2, 3]
      },
      now: new Date("2026-05-28T00:02:00.000Z")
    });

    expect(first).toEqual({
      jobId: "job-123",
      workspaceId: "T123",
      slackUserId: "U123",
      state: {
        lastNotifiedPullRequest: "https://github.com/acme/app/pull/1",
        seen: [1, 2]
      },
      updatedAt: "2026-05-28T00:00:00.000Z"
    });
    expect(updated.state).toEqual({
      lastNotifiedPullRequest: "https://github.com/acme/app/pull/2",
      seen: [1, 2, 3]
    });
    expect(
      store
        .listAgentJobStatesForPrincipal("T123", "U123")
        .map((record) => record.jobId)
    ).toEqual(["job-123", "job-456"]);

    store.deleteAgentJobState("job-123");
    expect(store.getAgentJobState("job-123")).toBeNull();
    expect(store.getAgentJobState("job-456")?.state).toEqual({ cursor: "abc" });

    store.close();
  });

  test("stores scheduled job capability metadata", () => {
    const store = createTokenStore(":memory:");

    const first = store.upsertAgentJobCapability({
      jobId: "job-123",
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: [
        "github_list_my_pull_requests",
        "github_search_issues",
        "github_search_issues"
      ],
      routeId: "convrt_123",
      policyHash: "policy-a",
      capabilityProfile: "scheduled_job",
      runtimeType: "hermes",
      stateRefs: [
        {
          provider: "google",
          kind: "drive_file",
          id: "file-123"
        }
      ],
      visibilityPolicy: {
        maxOutputVisibility: "public",
        privateToolOutput: "no_public_post_without_declassification"
      },
      now: new Date("2026-05-28T00:00:00.000Z")
    });
    const updated = store.upsertAgentJobCapability({
      jobId: "job-123",
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["github_list_my_pull_requests"],
      routeId: "convrt_123",
      policyHash: "policy-b",
      capabilityProfile: "scheduled_job",
      runtimeType: "openclaw",
      stateRefs: [],
      visibilityPolicy: {
        maxOutputVisibility: "user_private",
        privateToolOutput: "block_public_delivery"
      },
      now: new Date("2026-05-28T00:01:00.000Z")
    });

    expect(first).toEqual({
      jobId: "job-123",
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["github_list_my_pull_requests", "github_search_issues"],
      routeId: "convrt_123",
      policyHash: "policy-a",
      capabilityProfile: "scheduled_job",
      runtimeType: "hermes",
      stateRefs: [
        {
          provider: "google",
          kind: "drive_file",
          id: "file-123"
        }
      ],
      visibilityPolicy: {
        maxOutputVisibility: "public",
        privateToolOutput: "no_public_post_without_declassification"
      },
      createdAt: "2026-05-28T00:00:00.000Z",
      updatedAt: "2026-05-28T00:00:00.000Z"
    });
    expect(updated).toEqual({
      jobId: "job-123",
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["github_list_my_pull_requests"],
      routeId: "convrt_123",
      policyHash: "policy-b",
      capabilityProfile: "scheduled_job",
      runtimeType: "openclaw",
      stateRefs: [],
      visibilityPolicy: {
        maxOutputVisibility: "user_private",
        privateToolOutput: "block_public_delivery"
      },
      createdAt: "2026-05-28T00:00:00.000Z",
      updatedAt: "2026-05-28T00:01:00.000Z"
    });
    expect(store.getAgentJobCapability("job-123")).toEqual(updated);
    expect(
      store.listAgentJobCapabilitiesForPrincipal("T123", "U123")
    ).toEqual([updated]);

    store.deleteAgentJobCapability("job-123");
    expect(store.getAgentJobCapability("job-123")).toBeNull();

    store.close();
  });

  test("records scheduled job runs by principal and job", () => {
    const store = createTokenStore(":memory:");

    const run = store.createAgentJobRun({
      runId: "jobrun-123",
      jobId: "ai-news-hourly",
      workspaceId: "T123",
      slackUserId: "U123",
      triggerSource: "manual",
      status: "queued",
      now: new Date("2026-06-24T12:00:00.000Z")
    });
    store.createAgentJobRun({
      runId: "jobrun-other",
      jobId: "other-job",
      workspaceId: "T123",
      slackUserId: "U123",
      triggerSource: "schedule",
      status: "succeeded",
      now: new Date("2026-06-24T12:01:00.000Z")
    });

    expect(run).toEqual({
      runId: "jobrun-123",
      jobId: "ai-news-hourly",
      workspaceId: "T123",
      slackUserId: "U123",
      triggerSource: "manual",
      status: "queued",
      failureReason: null,
      createdAt: "2026-06-24T12:00:00.000Z",
      updatedAt: "2026-06-24T12:00:00.000Z",
      startedAt: null,
      finishedAt: null
    });
    expect(store.getAgentJobRun("jobrun-123")).toEqual(run);
    expect(
      store
        .listAgentJobRunsForJob("ai-news-hourly")
        .map((record) => record.runId)
    ).toEqual(["jobrun-123"]);
    expect(
      store.getLatestAgentJobRunForPrincipal("T123", "U123", "ai-news-hourly")
    ).toEqual(run);
    expect(
      store.getLatestAgentJobRunForPrincipal("T123", "U123", null)?.runId
    ).toBe("jobrun-other");
    expect(store.listRecentAgentJobRuns(2).map((record) => record.runId)).toEqual([
      "jobrun-other",
      "jobrun-123"
    ]);
    expect(
      store.findRecentFailedAgentJobRunForPrincipal({
        workspaceId: "T123",
        slackUserId: "U123",
        jobId: "other-job",
        failureReason: "not failed",
        since: new Date("2026-06-24T11:00:00.000Z")
      })
    ).toBeNull();
    const failedRun = store.createAgentJobRun({
      runId: "jobrun-failed",
      jobId: "other-job",
      workspaceId: "T123",
      slackUserId: "U123",
      triggerSource: "manual",
      status: "failed",
      failureReason: "validation failed",
      now: new Date("2026-06-24T12:01:30.000Z")
    });
    expect(
      store.findRecentFailedAgentJobRunForPrincipal({
        workspaceId: "T123",
        slackUserId: "U123",
        jobId: "other-job",
        failureReason: "validation failed",
        since: new Date("2026-06-24T12:01:00.000Z")
      })
    ).toEqual(failedRun);
    expect(store.listQueuedAgentJobRuns().map((record) => record.runId)).toEqual([
      "jobrun-123"
    ]);

    const claimed = store.claimAgentJobRun(
      "jobrun-123",
      new Date("2026-06-24T12:02:00.000Z")
    );
    expect(claimed).toMatchObject({
      runId: "jobrun-123",
      status: "running",
      startedAt: "2026-06-24T12:02:00.000Z",
      updatedAt: "2026-06-24T12:02:00.000Z"
    });
    expect(
      store.claimAgentJobRun(
        "jobrun-123",
        new Date("2026-06-24T12:03:00.000Z")
      )
    ).toBeNull();
    expect(store.listQueuedAgentJobRuns()).toEqual([]);

    const finished = store.finishAgentJobRun({
      runId: "jobrun-123",
      status: "succeeded",
      now: new Date("2026-06-24T12:04:00.000Z")
    });
    expect(finished).toMatchObject({
      runId: "jobrun-123",
      status: "succeeded",
      finishedAt: "2026-06-24T12:04:00.000Z",
      updatedAt: "2026-06-24T12:04:00.000Z"
    });
    expect(
      store.finishAgentJobRun({
        runId: "jobrun-123",
        status: "failed",
        failureReason: "should not overwrite terminal runs",
        now: new Date("2026-06-24T12:05:00.000Z")
      })
    ).toBeNull();

    store.close();
  });

  test("upserts scheduled job run audit metadata", () => {
    const store = createTokenStore(":memory:");

    const audit = store.upsertAgentJobRunAudit({
      runId: "jobrun-audit",
      jobId: "ai-news-hourly",
      workspaceId: "T123",
      slackUserId: "U123",
      runtimeType: "openclaw",
      runnerName: "managed-runtime",
      executionMode: "native-runtime",
      routeId: "convrt_123",
      outputDigest: "digest-a",
      outputBytes: 42,
      usage: {
        inputTokens: 12,
        outputTokens: 8,
        totalTokens: 20,
        usageSource: "provider-output"
      },
      telemetry: {
        promptChars: 144
      },
      visibility: {
        destination: "slack",
        isDirectMessage: false
      },
      now: new Date("2026-06-24T12:05:00.000Z")
    });

    expect(audit).toEqual({
      runId: "jobrun-audit",
      jobId: "ai-news-hourly",
      workspaceId: "T123",
      slackUserId: "U123",
      runtimeType: "openclaw",
      runnerName: "managed-runtime",
      executionMode: "native-runtime",
      routeId: "convrt_123",
      outputDigest: "digest-a",
      outputBytes: 42,
      usage: {
        inputTokens: 12,
        outputTokens: 8,
        totalTokens: 20,
        usageSource: "provider-output"
      },
      telemetry: {
        promptChars: 144
      },
      visibility: {
        destination: "slack",
        isDirectMessage: false
      },
      createdAt: "2026-06-24T12:05:00.000Z",
      updatedAt: "2026-06-24T12:05:00.000Z"
    });
    expect(store.getAgentJobRunAudit("jobrun-audit")).toEqual(audit);

    const updated = store.upsertAgentJobRunAudit({
      ...audit,
      outputDigest: "digest-b",
      outputBytes: 84,
      usage: {
        totalTokens: 30,
        usageSource: "estimate-only"
      },
      telemetry: null,
      visibility: {
        destination: "none"
      },
      now: new Date("2026-06-24T12:06:00.000Z")
    });
    expect(updated).toMatchObject({
      runId: "jobrun-audit",
      outputDigest: "digest-b",
      outputBytes: 84,
      usage: {
        totalTokens: 30,
        usageSource: "estimate-only"
      },
      telemetry: null,
      visibility: {
        destination: "none"
      },
      createdAt: "2026-06-24T12:05:00.000Z",
      updatedAt: "2026-06-24T12:06:00.000Z"
    });
    expect(
      store
        .listAgentJobRunAuditsForPrincipal("T123", "U123", 10)
        .map((record) => record.runId)
    ).toEqual(["jobrun-audit"]);

    store.upsertAgentJobRunAudit({
      ...audit,
      runId: "jobrun-old-audit",
      outputDigest: "digest-old",
      now: new Date("2026-03-01T12:00:00.000Z")
    });
    store.upsertAgentJobRunAudit({
      ...audit,
      runId: "jobrun-older-audit",
      outputDigest: "digest-older",
      now: new Date("2026-02-01T12:00:00.000Z")
    });
    expect(
      store.pruneAgentJobRunAuditsBefore(
        new Date("2026-06-01T00:00:00.000Z"),
        1
      )
    ).toBe(1);
    expect(store.getAgentJobRunAudit("jobrun-older-audit")).toBeNull();
    expect(store.getAgentJobRunAudit("jobrun-old-audit")).not.toBeNull();
    expect(
      store.pruneAgentJobRunAuditsBefore(
        new Date("2026-06-01T00:00:00.000Z"),
        1
      )
    ).toBe(1);
    expect(store.getAgentJobRunAudit("jobrun-old-audit")).toBeNull();
    expect(store.getAgentJobRunAudit("jobrun-audit")?.outputDigest).toBe(
      "digest-b"
    );

    store.close();
  });

  test("stores skill catalog and workspace/user skill enablement", () => {
    const store = createTokenStore(":memory:");

    const skill = store.upsertSkillCatalog({
      id: "github-pr-triage",
      version: "1",
      title: "GitHub PR triage",
      description: "Helps summarize and triage pull requests.",
      metadata: {
        requiresTools: ["github_list_my_pull_requests"],
        risk: "read-mostly"
      },
      contentRef: "bundled:github-pr-triage@1",
      now: new Date("2026-05-28T00:00:00.000Z")
    });
    store.upsertWorkspaceSkill({
      workspaceId: "T123",
      skillId: "github-pr-triage",
      version: "1",
      enabled: true,
      updatedBySlackUserId: "UADMIN",
      now: new Date("2026-05-28T00:01:00.000Z")
    });
    store.upsertUserSkill({
      workspaceId: "T123",
      slackUserId: "U123",
      skillId: "github-pr-triage",
      version: "1",
      enabled: true,
      now: new Date("2026-05-28T00:02:00.000Z")
    });

    expect(skill).toEqual({
      id: "github-pr-triage",
      version: "1",
      title: "GitHub PR triage",
      description: "Helps summarize and triage pull requests.",
      metadata: {
        requiresTools: ["github_list_my_pull_requests"],
        risk: "read-mostly"
      },
      contentRef: "bundled:github-pr-triage@1",
      createdAt: "2026-05-28T00:00:00.000Z"
    });
    expect(store.getSkillCatalog("github-pr-triage", "1")).toEqual(skill);
    expect(store.listSkillCatalog()).toEqual([skill]);
    expect(store.listWorkspaceSkills("T123")).toEqual([
      {
        workspaceId: "T123",
        skillId: "github-pr-triage",
        version: "1",
        enabled: true,
        updatedBySlackUserId: "UADMIN",
        updatedAt: "2026-05-28T00:01:00.000Z"
      }
    ]);
    expect(store.listUserSkills("T123", "U123")).toEqual([
      {
        workspaceId: "T123",
        slackUserId: "U123",
        skillId: "github-pr-triage",
        version: "1",
        enabled: true,
        updatedAt: "2026-05-28T00:02:00.000Z"
      }
    ]);

    store.close();
  });

  test("stores Burble-owned scheduled job definitions", () => {
    const store = createTokenStore(":memory:");

    const job = store.upsertScheduledJob({
      jobId: "job-ai-news-hourly",
      workspaceId: "T123",
      slackUserId: "U123",
      title: "Hourly AI news summary",
      prompt: "look for fresh AI-related news and post a short summary",
      schedule: {
        kind: "interval",
        every: { hours: 1 }
      },
      routeId: "convrt_123",
      state: "scheduled",
      runtimeType: "hermes",
      now: new Date("2026-06-24T12:00:00.000Z")
    });

    expect(job).toEqual({
      jobId: "job-ai-news-hourly",
      workspaceId: "T123",
      slackUserId: "U123",
      title: "Hourly AI news summary",
      prompt: "look for fresh AI-related news and post a short summary",
      schedule: {
        kind: "interval",
        every: { hours: 1 }
      },
      routeId: "convrt_123",
      state: "scheduled",
      runtimeType: "hermes",
      createdAt: "2026-06-24T12:00:00.000Z",
      updatedAt: "2026-06-24T12:00:00.000Z"
    });
    expect(store.getScheduledJob("job-ai-news-hourly")).toEqual(job);
    expect(store.listScheduledJobsForPrincipal("T123", "U123")).toEqual([job]);

    store.upsertScheduledJob({
      jobId: "job-ai-news-hourly",
      workspaceId: "T123",
      slackUserId: "U123",
      title: "Hourly AI news brief",
      prompt: job.prompt,
      schedule: job.schedule,
      routeId: "convrt_123",
      state: "paused",
      runtimeType: "hermes",
      now: new Date("2026-06-24T12:05:00.000Z")
    });

    expect(store.getScheduledJob("job-ai-news-hourly")).toMatchObject({
      title: "Hourly AI news brief",
      state: "paused",
      createdAt: "2026-06-24T12:00:00.000Z",
      updatedAt: "2026-06-24T12:05:00.000Z"
    });

    store.deleteScheduledJob("job-ai-news-hourly");
    expect(store.getScheduledJob("job-ai-news-hourly")).toBeNull();

    store.close();
  });
});
