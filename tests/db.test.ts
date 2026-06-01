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
      authTokenHash: "hash-u123",
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
      revokedAt: null
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
      destinationJson: route.destinationJson
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
});
