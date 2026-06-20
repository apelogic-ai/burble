import { describe, expect, test } from "bun:test";
import type { Config } from "../../src/config";
import { createTokenStore } from "../../src/db";
import {
  buildRuntimeManifestForPrincipal,
  RuntimeEngineSelectionError,
  runtimeCapabilityManifestCompatibility,
  resolveRuntimeEngineForPrincipal,
  runtimeEngineCompatibility
} from "../../src/agent/runtime-policy";

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
  hubspotClientId: null,
  hubspotClientSecret: null,
  baseUrl: "https://example.ngrok-free.app",
  port: 3000,
  databasePath: ":memory:",
  slackLogLevel: "info",
  agentMode: "deterministic",
  agentFastTrack: false,
  agentRuntime: "ai-sdk",
  agentRuntimeFactory: "static",
  managedRuntimeUrl: null,
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
  agentRuntimeSandboxUrl: null,
  agentRuntimeSandboxToken: null,
  agentRuntimeSandboxStartCommand: null,
  atlassianMcpUrl: "https://mcp.atlassian.com/v1/mcp",
  runtimeJwtIssuer: "http://burble-app:3000",
  runtimeJwtPrivateKeyPath: null,
  openClawConfigPatchHostPath: null,
  internalApiToken: null,
  observabilityJsonlPath: null,
  observabilityJsonlDir: null,
  observabilityIncludeContent: false,
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

describe("resolveRuntimeEngineForPrincipal", () => {
  test("defaults to the configured runtime engine", () => {
    const store = createTokenStore(":memory:");
    const selection = resolveRuntimeEngineForPrincipal({
      config,
      store,
      principal: {
        workspaceId: "T123",
        slackUserId: "U123"
      }
    });

    expect(selection).toEqual({
      configuredEngine: "openclaw",
      effectiveEngine: "openclaw",
      preferredEngine: null,
      allowedEngines: ["openclaw"],
      selectableEngines: ["openclaw"],
      compatibility: [
        {
          engine: "openclaw",
          selectable: true,
          reasons: []
        }
      ]
    });
    store.close();
  });

  test("uses a user runtime preference when the workspace allows it", () => {
    const store = createTokenStore(":memory:");
    store.upsertWorkspacePolicy({
      workspaceId: "T123",
      key: "runtime.allowedEngines",
      value: ["openclaw", "hermes"],
      updatedBySlackUserId: "UADMIN"
    });
    store.upsertUserPreference({
      workspaceId: "T123",
      slackUserId: "U123",
      key: "runtime.engine",
      value: "hermes"
    });

    const selection = resolveRuntimeEngineForPrincipal({
      config,
      store,
      principal: {
        workspaceId: "T123",
        slackUserId: "U123"
      }
    });

    expect(selection.effectiveEngine).toBe("hermes");
    expect(selection.preferredEngine).toBe("hermes");
    expect(selection.allowedEngines).toEqual(["openclaw", "hermes"]);
    expect(selection.selectableEngines).toEqual(["openclaw", "hermes"]);
    store.close();
  });

  test("keeps an attachment-capable preferred runtime selected", () => {
    const store = createTokenStore(":memory:");
    store.upsertWorkspacePolicy({
      workspaceId: "T123",
      key: "runtime.allowedEngines",
      value: ["openclaw", "burble-native"],
      updatedBySlackUserId: "UADMIN"
    });
    store.upsertUserPreference({
      workspaceId: "T123",
      slackUserId: "U123",
      key: "runtime.engine",
      value: "burble-native"
    });

    const selection = resolveRuntimeEngineForPrincipal({
      config,
      store,
      principal: {
        workspaceId: "T123",
        slackUserId: "U123"
      },
      requirements: { attachments: true }
    });

    expect(selection.effectiveEngine).toBe("burble-native");
    expect(selection.preferredEngine).toBe("burble-native");
    expect(selection.selectableEngines).toEqual(["openclaw", "burble-native"]);
    store.close();
  });

  test("marks manifests without attachment support incompatible for attachment turns", () => {
    expect(
      runtimeCapabilityManifestCompatibility(
        "burble-native",
        {
          runtimeType: "burble-native",
          version: "test",
          transports: ["http", "websocket"],
          streaming: true,
          cancellation: false,
          nativeScheduler: false,
          scheduledProviderCalls: false,
          toolCalls: true,
          toolBridgeModes: ["tool_gateway"],
          usageReporting: "exact",
          multimodalInput: false,
          multimodalOutput: false,
          memory: false,
          durableWorkflowState: false,
          attachments: false,
          conversationSend: true,
          jobScopedAuth: true
        },
        { requirements: { attachments: true } }
      )
    ).toEqual({
      engine: "burble-native",
      selectable: false,
      reasons: ["missing attachment support"]
    });
  });

  test("ignores a user runtime preference that is not allowed", () => {
    const store = createTokenStore(":memory:");
    store.upsertWorkspacePolicy({
      workspaceId: "T123",
      key: "runtime.allowedEngines",
      value: ["openclaw"],
      updatedBySlackUserId: "UADMIN"
    });
    store.upsertUserPreference({
      workspaceId: "T123",
      slackUserId: "U123",
      key: "runtime.engine",
      value: "hermes"
    });

    const selection = resolveRuntimeEngineForPrincipal({
      config,
      store,
      principal: {
        workspaceId: "T123",
        slackUserId: "U123"
      }
    });

    expect(selection.effectiveEngine).toBe("openclaw");
    expect(selection.preferredEngine).toBe("hermes");
    expect(selection.allowedEngines).toEqual(["openclaw"]);
    expect(selection.selectableEngines).toEqual(["openclaw"]);
    store.close();
  });

  test("ignores a user runtime preference that fails required compatibility", () => {
    const store = createTokenStore(":memory:");
    store.upsertWorkspacePolicy({
      workspaceId: "T123",
      key: "runtime.allowedEngines",
      value: ["openclaw", "deterministic"],
      updatedBySlackUserId: "UADMIN"
    });
    store.upsertUserPreference({
      workspaceId: "T123",
      slackUserId: "U123",
      key: "runtime.engine",
      value: "deterministic"
    });

    const selection = resolveRuntimeEngineForPrincipal({
      config,
      store,
      principal: {
        workspaceId: "T123",
        slackUserId: "U123"
      }
    });

    expect(selection.effectiveEngine).toBe("openclaw");
    expect(selection.preferredEngine).toBe("deterministic");
    expect(selection.allowedEngines).toEqual(["openclaw", "deterministic"]);
    expect(selection.selectableEngines).toEqual(["openclaw"]);
    expect(selection.compatibility).toContainEqual({
      engine: "deterministic",
      selectable: false,
      reasons: ["missing usage reporting"]
    });
    store.close();
  });

  test("selects Burble Native for interactive workloads when allowed", () => {
    const store = createTokenStore(":memory:");
    store.upsertWorkspacePolicy({
      workspaceId: "T123",
      key: "runtime.allowedEngines",
      value: ["openclaw", "burble-native"],
      updatedBySlackUserId: "UADMIN"
    });
    store.upsertUserPreference({
      workspaceId: "T123",
      slackUserId: "U123",
      key: "runtime.engine",
      value: "burble-native"
    });

    const selection = resolveRuntimeEngineForPrincipal({
      config,
      store,
      principal: {
        workspaceId: "T123",
        slackUserId: "U123"
      }
    });

    expect(selection.effectiveEngine).toBe("burble-native");
    expect(selection.preferredEngine).toBe("burble-native");
    expect(selection.allowedEngines).toEqual(["openclaw", "burble-native"]);
    expect(selection.selectableEngines).toEqual(["openclaw", "burble-native"]);
    expect(selection.compatibility).toContainEqual({
      engine: "burble-native",
      selectable: true,
      reasons: []
    });
    store.close();
  });

  test("treats Burble Native as scheduled-workload compatible", () => {
    expect(
      runtimeEngineCompatibility("burble-native", { workload: "scheduled" })
    ).toEqual({
      engine: "burble-native",
      selectable: true,
      reasons: []
    });
  });

  test("keeps legacy Burble direct parseable but not selectable", () => {
    expect(runtimeEngineCompatibility("burble-direct")).toEqual({
      engine: "burble-direct",
      selectable: false,
      reasons: ["deprecated; use burble-native"]
    });
  });

  test("normalizes stored Burble direct workspace policies to Burble Native", () => {
    const store = createTokenStore(":memory:");
    store.upsertWorkspacePolicy({
      workspaceId: "T123",
      key: "runtime.allowedEngines",
      value: ["burble-direct"],
      updatedBySlackUserId: "UADMIN"
    });

    const selection = resolveRuntimeEngineForPrincipal({
      config,
      store,
      principal: {
        workspaceId: "T123",
        slackUserId: "U123"
      }
    });

    expect(selection.allowedEngines).toEqual(["burble-native"]);
    expect(selection.selectableEngines).toEqual(["burble-native"]);
    expect(selection.effectiveEngine).toBe("burble-native");
    store.close();
  });

  test("normalizes stored Burble direct user preferences to Burble Native", () => {
    const store = createTokenStore(":memory:");
    store.upsertWorkspacePolicy({
      workspaceId: "T123",
      key: "runtime.allowedEngines",
      value: ["openclaw", "burble-native"],
      updatedBySlackUserId: "UADMIN"
    });
    store.upsertUserPreference({
      workspaceId: "T123",
      slackUserId: "U123",
      key: "runtime.engine",
      value: "burble-direct"
    });

    const selection = resolveRuntimeEngineForPrincipal({
      config,
      store,
      principal: {
        workspaceId: "T123",
        slackUserId: "U123"
      }
    });

    expect(selection.preferredEngine).toBe("burble-native");
    expect(selection.effectiveEngine).toBe("burble-native");
    store.close();
  });

  test("fails explicitly when policy leaves no selectable runtime engine", () => {
    const store = createTokenStore(":memory:");
    store.upsertWorkspacePolicy({
      workspaceId: "T123",
      key: "runtime.allowedEngines",
      value: ["deterministic"],
      updatedBySlackUserId: "UADMIN"
    });

    expect(() =>
      resolveRuntimeEngineForPrincipal({
        config,
        store,
        principal: {
          workspaceId: "T123",
          slackUserId: "U123"
        }
      })
    ).toThrow(RuntimeEngineSelectionError);
    try {
      resolveRuntimeEngineForPrincipal({
        config,
        store,
        principal: {
          workspaceId: "T123",
          slackUserId: "U123"
        }
      });
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeEngineSelectionError);
      expect((error as RuntimeEngineSelectionError).selection).toMatchObject({
        configuredEngine: "openclaw",
        allowedEngines: ["deterministic"],
        selectableEngines: []
      });
      expect(String(error)).toContain("missing usage reporting");
    }
    store.close();
  });
});
