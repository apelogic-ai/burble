import { describe, expect, test } from "bun:test";
import { createSandboxRuntimeFactory } from "../../src/agent/sandbox-runtime-factory";
import { dockerInternalAllowedIps } from "../../src/agent/sandbox-policy";
import { buildRuntimeDataId } from "../../src/agent/runtime-factory";
import {
  cloneSandboxHandle,
  type SandboxEvent,
  type SandboxHandle,
  type SandboxPolicy,
  type SandboxProvider,
  type SandboxProviderCapabilities,
  type SandboxRunHandle,
  type SandboxRunRequest
} from "../../src/agent/sandbox-provider";
import { createTokenStore } from "../../src/db";

const principal = {
  workspaceId: "T123",
  slackUserId: "U123"
};

describe("createSandboxRuntimeFactory", () => {
  test("provisions a runtime through the sandbox provider and records the sandbox binding", async () => {
    const store = createTokenStore(":memory:");
    const provider = createFakeRuntimeSandboxProvider();
    const healthUrls: string[] = [];
    const factory = createSandboxRuntimeFactory({
      store,
      sandboxProvider: provider,
      engine: "openclaw",
      image: "burble-openclaw-nemoclaw:dev",
      toolGatewayUrl: "http://burble-app:3000/internal/tools",
      mcpGatewayUrl: "http://agentgateway:3000/mcp",
      mcpAudience: "http://agentgateway:3000/mcp",
      inferenceBaseUrl: "http://llm-gw:4000/v1",
      modelProviderUrls: ["https://api.openai.com/v1"],
      runtimeTokenSecret: "runtime-secret",
      runtimeJwtIssuer: {
        issueRuntimeJwt: (claims: {
          audience: string;
          runtimeId: string;
          workspaceId: string;
          slackUserId: string;
          ttlSeconds?: number;
        }) =>
          `jwt:${claims.audience}:${claims.runtimeId}:${claims.workspaceId}:${claims.slackUserId}:${claims.ttlSeconds}`
      } as never,
      runtimeJwtTtlSeconds: 3600,
      startCommand: ["runtime-entrypoint"],
      healthCheckAttempts: 1,
      fetch: async (url) => {
        healthUrls.push(url);
        return new Response("ok");
      },
      buildManifest: (runtimePrincipal) =>
        ({
          version: "1",
          principal: runtimePrincipal,
          runtime: {
            engine: "openclaw",
            factory: "docker",
            ttlMs: 86400000,
            reaperEnabled: true
          },
          model: { provider: "openai", model: "gpt-5.4" },
          tools: [],
          skills: [],
          memory: {
            userMemoryEnabled: false,
            workspaceMemoryEnabled: false,
            jobMemoryEnabled: true
          },
          streaming: { messageDeltasEnabled: true },
          memoryContext: [],
          disabledTools: [],
          policyHash: "policy-hash"
        }) as never
    });

    const handle = await factory.getOrCreateRuntime(principal);
    const stored = store.getAgentRuntime(handle.id);
    const events = store.listAgentRuntimeEvents(handle.id);

    expect(handle.endpointUrl).toBe("http://sandbox-1.local:8080");
    expect(handle.authToken).toStartWith("burble_rt_");
    expect(handle.manifest?.policyHash).toBe("policy-hash");
    expect(stored?.sandboxId).toBe("sandbox-1");
    expect(stored?.authTokenHash).not.toContain("runtime-secret");
    expect(stored?.policyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.policyHash).not.toBe("policy-hash");
    expect(provider.provisionCalls).toHaveLength(1);
    expect(provider.provisionCalls[0].policy).toEqual({
      network: {
        egress: "allowlist",
        allowedHosts: ["agentgateway:3000", "burble-app:3000", "llm-gw:4000"],
        allowedEndpoints: [
          {
            host: "agentgateway:3000",
            tls: false,
            allowedIps: dockerInternalAllowedIps
          },
          {
            host: "burble-app:3000",
            tls: false,
            allowedIps: dockerInternalAllowedIps
          },
          {
            host: "llm-gw:4000",
            tls: false,
            allowedIps: dockerInternalAllowedIps
          }
        ]
      },
      filesystem: {
        readOnlyPaths: ["/"],
        readWritePaths: [
          "/data/openclaw",
          "/runtime/config",
          "/runtime/state",
          "/runtime/workspace",
          "/tmp",
          "/dev/pts"
        ]
      }
    });
    expect(provider.policyCalls).toEqual([]);
    expect(provider.runCalls).toHaveLength(0);
    expect(provider.provisionCalls[0].start).toMatchObject({
      argv: ["runtime-entrypoint"],
      env: {
        BURBLE_TOOL_GATEWAY_URL: "http://burble-app:3000/internal/tools",
        BURBLE_INTERNAL_TOKEN: handle.authToken,
        BURBLE_RUNTIME_ID: handle.id,
        BURBLE_MCP_GATEWAY_URL: "http://agentgateway:3000/mcp",
        AGENT_RUNTIME_ENGINE: "openclaw",
        AGENT_RUNTIME_CONFIG_PATH: "/data/openclaw/config/openclaw.json",
        OPENCLAW_NEMOCLAW_ENGINE: "openclaw",
        OPENCLAW_HOME: "/data/openclaw",
        HOME: "/data/openclaw",
        XDG_CACHE_HOME: "/tmp/openclaw-cache",
        npm_config_cache: "/tmp/npm-cache",
        JITI_FS_CACHE: "false",
        AI_MODEL: "openai:gpt-5.4",
        AGENT_RUNTIME_INFERENCE_BASE_URL: "http://llm-gw:4000/v1",
        OPENAI_BASE_URL: "http://llm-gw:4000/v1",
        OPENAI_API_KEY: "sk-BURBLE-INFERENCE-PROXY"
      }
    });
    expect(provider.provisionCalls[0].start?.env?.BURBLE_RUNTIME_JWT).toContain(
      `jwt:http://agentgateway:3000/mcp:${handle.id}:T123:U123:3600`
    );
    expect(healthUrls).toEqual(["http://sandbox-1.local:8080/healthz"]);
    expect(events.map((event) => event.eventType)).toEqual([
      "runtime_provision_requested",
      "runtime_provision_finished"
    ]);
    expect(events[0].summaryJson).toContain("sandbox-1");

    await factory.stopRuntime(handle.id);

    expect(provider.terminated).toEqual(["sandbox-1"]);
    expect(store.getAgentRuntime(handle.id)?.status).toBe("stopped");

    store.close();
  });

  test("does not provision a sandbox when runtime JWT issuance fails", async () => {
    const store = createTokenStore(":memory:");
    const provider = createFakeRuntimeSandboxProvider();
    const factory = createSandboxRuntimeFactory({
      store,
      sandboxProvider: provider,
      engine: "openclaw",
      image: "burble-openclaw-nemoclaw:dev",
      toolGatewayUrl: "http://burble-app:3000/internal/tools",
      mcpGatewayUrl: "http://agentgateway:3000/mcp",
      modelProviderUrls: ["https://api.openai.com/v1"],
      runtimeTokenSecret: "runtime-secret",
      runtimeJwtIssuer: {
        issueRuntimeJwt: () => {
          throw new Error("jwt signer unavailable");
        }
      } as never,
      startCommand: ["runtime-entrypoint"],
      healthCheckAttempts: 1,
      fetch: async () => new Response("ok")
    });

    await expect(factory.getOrCreateRuntime(principal)).rejects.toThrow(
      "jwt signer unavailable"
    );

    const runtimeId = `rt_${buildRuntimeDataId(principal, "openclaw")}`;
    expect(provider.provisionCalls).toHaveLength(0);
    expect(provider.terminated).toEqual([]);
    expect(store.getAgentRuntime(runtimeId)).toBeNull();

    store.close();
  });

  test("derives sandbox egress from the per-principal manifest model and forwarded runtime env", async () => {
    const store = createTokenStore(":memory:");
    const provider = createFakeRuntimeSandboxProvider();
    const factory = createSandboxRuntimeFactory({
      store,
      sandboxProvider: provider,
      engine: "hermes",
      image: "burble-nemo-hermes:dev",
      toolGatewayUrl: "http://burble-app:3000/internal/tools",
      modelProviderUrls: ["https://api.openai.com/v1"],
      runtimeTokenSecret: "runtime-secret",
      startCommand: ["hermes-entrypoint"],
      healthCheckAttempts: 1,
      fetch: async () => new Response("ok"),
      env: {
        EXA_API_KEY: "exa-key",
        FIRECRAWL_API_URL: "https://firecrawl.internal/v1",
        HERMES_WEB_SEARCH_BACKEND: "exa"
      },
      buildManifest: (runtimePrincipal) =>
        ({
          version: "1",
          principal: runtimePrincipal,
          runtime: {
            engine: "hermes",
            factory: "sandbox",
            ttlMs: 86400000,
            reaperEnabled: true
          },
          model: { provider: "anthropic", model: "claude-sonnet-4" },
          tools: [],
          skills: [],
          memory: {
            userMemoryEnabled: false,
            workspaceMemoryEnabled: false,
            jobMemoryEnabled: true
          },
          streaming: { messageDeltasEnabled: true },
          memoryContext: [],
          disabledTools: [],
          policyHash: "anthropic-policy"
        }) as never
    });

    await factory.getOrCreateRuntime(principal);

    expect(provider.provisionCalls[0].policy?.network).toEqual({
      egress: "allowlist",
      allowedHosts: [
        "api.anthropic.com",
        "api.exa.ai",
        "burble-app:3000",
        "firecrawl.internal"
      ],
      allowedEndpoints: [
        { host: "api.anthropic.com", tls: true },
        { host: "api.exa.ai", tls: true },
        {
          host: "burble-app:3000",
          tls: false,
          allowedIps: dockerInternalAllowedIps
        },
        {
          host: "firecrawl.internal",
          tls: true,
          allowedIps: dockerInternalAllowedIps
        }
      ]
    });
    expect(provider.provisionCalls[0].start?.env).toMatchObject({
      AI_MODEL: "anthropic:claude-sonnet-4",
      HERMES_INFERENCE_PROVIDER: "anthropic",
      FIRECRAWL_API_URL: "https://firecrawl.internal/v1",
      HERMES_WEB_SEARCH_BACKEND: "exa"
    });
    expect(provider.provisionCalls[0].start?.env?.EXA_API_KEY).toBeUndefined();
    expect(
      provider.provisionCalls[0].policy?.network.allowedHosts
    ).not.toContain("api.openai.com");

    store.close();
  });

  test("writes custom sandbox policy hash once during provisioning", async () => {
    const store = createTokenStore(":memory:");
    const provider = createFakeRuntimeSandboxProvider();
    const seenRuntimeIds: string[] = [];
    const factory = createSandboxRuntimeFactory({
      store,
      sandboxProvider: provider,
      engine: "hermes",
      image: "burble-nemo-hermes:dev",
      toolGatewayUrl: "http://burble-app:3000/internal/tools",
      modelProviderUrls: ["https://api.openai.com/v1"],
      runtimeTokenSecret: "runtime-secret",
      startCommand: ["hermes-entrypoint"],
      healthCheckAttempts: 1,
      fetch: async () => new Response("ok"),
      buildPolicy: (context) => {
        seenRuntimeIds.push(context.runtimeId);
        return {
          network: {
            egress: "allowlist",
            allowedHosts: ["api.openai.com", "burble-app:3000"]
          }
        };
      }
    });

    const handle = await factory.getOrCreateRuntime(principal);
    const events = store.listAgentRuntimeEvents(handle.id);

    expect(seenRuntimeIds).toEqual([handle.id]);
    expect(store.getAgentRuntime(handle.id)?.policyHash).toMatch(
      /^[0-9a-f]{64}$/
    );
    expect(events.map((event) => event.eventType)).toEqual([
      "runtime_provision_requested",
      "runtime_provision_finished"
    ]);

    store.close();
  });

  test("reattaches an existing sandbox-backed runtime instead of reprovisioning", async () => {
    const store = createTokenStore(":memory:");
    const provider = createFakeRuntimeSandboxProvider();
    let policyHash = "policy-a";
    const factory = createSandboxRuntimeFactory({
      store,
      sandboxProvider: provider,
      engine: "hermes",
      image: "burble-nemo-hermes:dev",
      toolGatewayUrl: "http://burble-app:3000/internal/tools",
      modelProviderUrls: ["https://api.openai.com/v1"],
      runtimeTokenSecret: "runtime-secret",
      startCommand: ["hermes-entrypoint"],
      healthCheckAttempts: 1,
      fetch: async () => new Response("ok"),
      buildManifest: (runtimePrincipal) =>
        ({
          version: "1",
          principal: runtimePrincipal,
          runtime: {
            engine: "hermes",
            factory: "docker",
            ttlMs: 86400000,
            reaperEnabled: true
          },
          model: { provider: "openai", model: "gpt-5.4" },
          tools: [],
          skills: [],
          memory: {
            userMemoryEnabled: false,
            workspaceMemoryEnabled: false,
            jobMemoryEnabled: true
          },
          streaming: { messageDeltasEnabled: true },
          memoryContext: [],
          disabledTools: [],
          policyHash
        }) as never
    });

    const first = await factory.getOrCreateRuntime(principal);
    const firstPolicyHash = store.getAgentRuntime(first.id)?.policyHash;
    policyHash = "policy-b";
    const second = await factory.getOrCreateRuntime(principal);

    expect(second.id).toBe(first.id);
    expect(second.endpointUrl).toBe(first.endpointUrl);
    expect(provider.provisionCalls).toHaveLength(1);
    expect(provider.attachCalls).toEqual(["sandbox-1"]);
    expect(provider.runCalls).toHaveLength(0);
    expect(provider.policyCalls).toHaveLength(1);
    expect(store.getAgentRuntime(first.id)?.policyHash).not.toBe(
      firstPolicyHash
    );

    store.close();
  });

  test("refreshes env-derived sandbox policy on durable reattach", async () => {
    const store = createTokenStore(":memory:");
    const provider = createFakeRuntimeSandboxProvider();
    const env: Record<string, string | undefined> = {};
    const factory = createSandboxRuntimeFactory({
      store,
      sandboxProvider: provider,
      engine: "hermes",
      image: "burble-nemo-hermes:dev",
      toolGatewayUrl: "http://burble-app:3000/internal/tools",
      modelProviderUrls: ["https://api.openai.com/v1"],
      runtimeTokenSecret: "runtime-secret",
      startCommand: ["hermes-entrypoint"],
      healthCheckAttempts: 1,
      fetch: async () => new Response("ok"),
      env,
      buildManifest: (runtimePrincipal) =>
        ({
          version: "1",
          principal: runtimePrincipal,
          runtime: {
            engine: "hermes",
            factory: "sandbox",
            ttlMs: 86400000,
            reaperEnabled: true
          },
          model: { provider: "openai", model: "gpt-5.4" },
          tools: [],
          skills: [],
          memory: {
            userMemoryEnabled: false,
            workspaceMemoryEnabled: false,
            jobMemoryEnabled: true
          },
          streaming: { messageDeltasEnabled: true },
          memoryContext: [],
          disabledTools: [],
          policyHash: "same-policy"
        }) as never
    });

    const first = await factory.getOrCreateRuntime(principal);
    const firstPolicyHash = store.getAgentRuntime(first.id)?.policyHash;
    env.BRAVE_SEARCH_API_KEY = "brave-key";
    const second = await factory.getOrCreateRuntime(principal);
    const secondPolicyHash = store.getAgentRuntime(first.id)?.policyHash;
    await factory.getOrCreateRuntime(principal);

    expect(second.id).toBe(first.id);
    expect(provider.provisionCalls).toHaveLength(1);
    expect(provider.policyCalls).toHaveLength(1);
    expect(provider.policyCalls[0].policy.network.allowedHosts).toContain(
      "api.search.brave.com"
    );
    expect(secondPolicyHash).not.toBe(firstPolicyHash);
    expect(store.getAgentRuntime(first.id)?.policyHash).toBe(secondPolicyHash);

    store.close();
  });

  test("serializes concurrent provisioning for the same runtime principal", async () => {
    const store = createTokenStore(":memory:");
    const provider = createFakeRuntimeSandboxProvider();
    let releaseProvision!: () => void;
    provider.provisionDelay = new Promise<void>((resolve) => {
      releaseProvision = resolve;
    });
    const factory = createSandboxRuntimeFactory({
      store,
      sandboxProvider: provider,
      engine: "hermes",
      image: "burble-nemo-hermes:dev",
      toolGatewayUrl: "http://burble-app:3000/internal/tools",
      modelProviderUrls: ["https://api.openai.com/v1"],
      runtimeTokenSecret: "runtime-secret",
      startCommand: ["hermes-entrypoint"],
      healthCheckAttempts: 1,
      fetch: async () => new Response("ok")
    });

    const first = factory.getOrCreateRuntime(principal);
    const second = factory.getOrCreateRuntime(principal);

    releaseProvision();
    const [firstRuntime, secondRuntime] = await Promise.all([first, second]);

    expect(secondRuntime.id).toBe(firstRuntime.id);
    expect(provider.provisionCalls).toHaveLength(1);
    expect(provider.attachCalls).toEqual(["sandbox-1"]);

    store.close();
  });

  test("terminates the sandbox when create-time runtime launch never becomes healthy", async () => {
    const store = createTokenStore(":memory:");
    const provider = createFakeRuntimeSandboxProvider();
    const healthUrls: string[] = [];
    const factory = createSandboxRuntimeFactory({
      store,
      sandboxProvider: provider,
      engine: "hermes",
      image: "burble-nemo-hermes:dev",
      toolGatewayUrl: "http://burble-app:3000/internal/tools",
      modelProviderUrls: ["https://api.openai.com/v1"],
      runtimeTokenSecret: "runtime-secret",
      startCommand: ["hermes-entrypoint"],
      healthCheckAttempts: 2,
      healthCheckIntervalMs: 0,
      fetch: async (url) => {
        healthUrls.push(url);
        return new Response("bad", { status: 502 });
      }
    });

    await expect(factory.getOrCreateRuntime(principal)).rejects.toThrow(
      "Runtime health check failed for sandbox sandbox-1"
    );

    expect(healthUrls).toEqual([
      "http://sandbox-1.local:8080/healthz",
      "http://sandbox-1.local:8080/healthz"
    ]);
    expect(provider.terminated).toEqual(["sandbox-1"]);

    store.close();
  });

  test("terminates failed provisioning sandboxes and reprovisions on retry", async () => {
    const store = createTokenStore(":memory:");
    const provider = createFakeRuntimeSandboxProvider();
    let failHealth = true;
    const healthUrls: string[] = [];
    const factory = createSandboxRuntimeFactory({
      store,
      sandboxProvider: provider,
      engine: "hermes",
      image: "burble-nemo-hermes:dev",
      toolGatewayUrl: "http://burble-app:3000/internal/tools",
      modelProviderUrls: ["https://api.openai.com/v1"],
      runtimeTokenSecret: "runtime-secret",
      startCommand: ["hermes-entrypoint"],
      healthCheckAttempts: 1,
      fetch: async (url) => {
        healthUrls.push(url);
        return failHealth
          ? new Response("bad", { status: 502 })
          : new Response("ok");
      }
    });
    await expect(factory.getOrCreateRuntime(principal)).rejects.toThrow(
      "Runtime health check failed for sandbox sandbox-1"
    );

    const runtimeId = `rt_${buildRuntimeDataId(principal, "hermes")}`;
    expect(store.getAgentRuntime(runtimeId)).toMatchObject({
      status: "failed",
      sandboxId: "sandbox-1"
    });
    expect(provider.terminated).toEqual(["sandbox-1"]);

    failHealth = false;
    const retry = await factory.getOrCreateRuntime(principal);

    expect(retry.id).toBe(runtimeId);
    expect(store.getAgentRuntime(retry.id)).toMatchObject({
      status: "ready",
      sandboxId: "sandbox-2"
    });
    expect(provider.provisionCalls).toHaveLength(2);
    expect(provider.attachCalls).toEqual([]);
    expect(healthUrls).toEqual([
      "http://sandbox-1.local:8080/healthz",
      "http://sandbox-2.local:8080/healthz"
    ]);

    store.close();
  });

  test("preserves failed provisioning sandboxes when diagnostics are enabled", async () => {
    const store = createTokenStore(":memory:");
    const provider = createFakeRuntimeSandboxProvider();
    const factory = createSandboxRuntimeFactory({
      store,
      sandboxProvider: provider,
      engine: "openclaw",
      image: "burble-openclaw-nemoclaw:dev",
      toolGatewayUrl: "http://burble-app:3000/internal/tools",
      modelProviderUrls: ["https://api.openai.com/v1"],
      runtimeTokenSecret: "runtime-secret",
      startCommand: ["openclaw-entrypoint"],
      healthCheckAttempts: 1,
      fetch: async () =>
        failHealth ? new Response("bad", { status: 502 }) : new Response("ok"),
      env: {
        AGENT_RUNTIME_SANDBOX_PRESERVE_FAILED: "true"
      }
    });

    let failHealth = true;
    await expect(factory.getOrCreateRuntime(principal)).rejects.toThrow(
      "Runtime health check failed for sandbox sandbox-1"
    );

    const runtimeId = `rt_${buildRuntimeDataId(principal, "openclaw")}`;
    const events = store.listAgentRuntimeEvents(runtimeId);

    expect(store.getAgentRuntime(runtimeId)).toMatchObject({
      status: "failed",
      sandboxId: "sandbox-1"
    });
    expect(provider.terminated).toEqual([]);
    expect(events.at(-1)?.summaryJson).toContain('"preservedSandbox":true');

    store.close();
  });

  test("reprovisions when a stored sandbox binding no longer exists", async () => {
    const store = createTokenStore(":memory:");
    const provider = createFakeRuntimeSandboxProvider();
    const stale = store.getOrCreateAgentRuntime({
      workspaceId: principal.workspaceId,
      slackUserId: principal.slackUserId,
      engine: "openclaw",
      endpointUrl: "http://missing-sandbox.local:8080",
      authTokenHash: "old-hash",
      statePath: "/missing/state",
      configPath: "/missing/config/openclaw.json",
      workspacePath: "/missing/workspace",
      sandboxId: "missing-sandbox",
      policyHash: "old-policy"
    });
    store.updateAgentRuntimeStatus(stale.id, { status: "provisioning" });
    const factory = createSandboxRuntimeFactory({
      store,
      sandboxProvider: provider,
      engine: "openclaw",
      image: "burble-openclaw-nemoclaw:dev",
      toolGatewayUrl: "http://burble-app:3000/internal/tools",
      modelProviderUrls: ["https://api.openai.com/v1"],
      runtimeTokenSecret: "runtime-secret",
      startCommand: ["openclaw-entrypoint"],
      healthCheckAttempts: 1,
      fetch: async () => new Response("ok")
    });

    const runtime = await factory.getOrCreateRuntime(principal);
    const events = store.listAgentRuntimeEvents(stale.id);

    expect(runtime.id).toBe(stale.id);
    expect(provider.attachCalls).toEqual(["missing-sandbox"]);
    expect(provider.provisionCalls).toHaveLength(1);
    expect(store.getAgentRuntime(stale.id)).toMatchObject({
      status: "ready",
      sandboxId: "sandbox-1",
      endpointUrl: "http://sandbox-1.local:8080"
    });
    expect(events.map((event) => event.eventType)).toContain("runtime_stopped");
    expect(events.map((event) => event.eventType)).toContain(
      "runtime_provision_requested"
    );

    store.close();
  });

  test("fails closed when the sandbox provider cannot enforce egress allowlists", () => {
    const store = createTokenStore(":memory:");

    expect(() =>
      createSandboxRuntimeFactory({
        store,
        sandboxProvider: createFakeRuntimeSandboxProvider({
          supportsEgressAllowlist: false
        }),
        engine: "openclaw",
        image: "burble-openclaw-nemoclaw:dev",
        toolGatewayUrl: "http://burble-app:3000/internal/tools",
        modelProviderUrls: ["https://api.openai.com/v1"],
        runtimeTokenSecret: "runtime-secret",
        startCommand: ["runtime-entrypoint"]
      })
    ).toThrow("must support egress allowlists");

    expect(() =>
      createSandboxRuntimeFactory({
        store,
        sandboxProvider: createFakeRuntimeSandboxProvider({
          supportsDurableSandboxes: false
        }),
        engine: "openclaw",
        image: "burble-openclaw-nemoclaw:dev",
        toolGatewayUrl: "http://burble-app:3000/internal/tools",
        modelProviderUrls: ["https://api.openai.com/v1"],
        runtimeTokenSecret: "runtime-secret",
        startCommand: ["runtime-entrypoint"]
      })
    ).toThrow("must support durable sandboxes");

    expect(() =>
      createSandboxRuntimeFactory({
        store,
        sandboxProvider: createFakeRuntimeSandboxProvider(),
        engine: "openclaw",
        image: "burble-openclaw-nemoclaw:dev",
        toolGatewayUrl: "http://burble-app:3000/internal/tools",
        modelProviderUrls: ["https://api.openai.com/v1"],
        runtimeTokenSecret: "runtime-secret",
        startCommand: []
      })
    ).toThrow("start command must be non-empty");

    store.close();
  });
});

type FakeRuntimeSandboxProvider = SandboxProvider & {
  provisionCalls: Parameters<SandboxProvider["provision"]>[0][];
  policyCalls: Array<{ sandboxId: string; policy: SandboxPolicy }>;
  runCalls: Array<{ sandboxId: string; request: SandboxRunRequest }>;
  attachCalls: string[];
  terminated: string[];
  provisionDelay?: Promise<void>;
};

function createFakeRuntimeSandboxProvider(
  capabilities?: Partial<SandboxProviderCapabilities>
): FakeRuntimeSandboxProvider {
  const sandboxes = new Map<string, SandboxHandle>();
  const provisionCalls: Parameters<SandboxProvider["provision"]>[0][] = [];
  const policyCalls: Array<{ sandboxId: string; policy: SandboxPolicy }> = [];
  const runCalls: Array<{ sandboxId: string; request: SandboxRunRequest }> = [];
  const attachCalls: string[] = [];
  const terminated: string[] = [];
  let sequence = 0;

  const load = (sandboxId: string): SandboxHandle => {
    const sandbox = sandboxes.get(sandboxId);
    if (!sandbox) {
      throw new Error(`Sandbox ${sandboxId} was not found`);
    }
    return cloneSandboxHandle(sandbox);
  };

  return {
    provisionCalls,
    policyCalls,
    runCalls,
    attachCalls,
    terminated,

    capabilities() {
      return {
        provider: "fake-runtime-sandbox",
        isolation: "microvm",
        supportsEgressAllowlist: true,
        supportsCredentialBinding: true,
        supportsDurableSandboxes: true,
        ...capabilities
      };
    },

    async provision(request) {
      provisionCalls.push(request);
      await this.provisionDelay;
      sequence += 1;
      const sandbox: SandboxHandle = {
        id: `sandbox-${sequence}`,
        provider: "fake-runtime-sandbox",
        status: "ready",
        endpointUrl: `http://sandbox-${sequence}.local:8080`,
        workspacePath: `/sandboxes/sandbox-${sequence}/workspace`,
        principal: request.principal,
        runtime: request.runtime,
        labels: request.labels ?? {},
        credentials: []
      };
      sandboxes.set(sandbox.id, cloneSandboxHandle(sandbox));
      return cloneSandboxHandle(sandbox);
    },

    async applyPolicy(sandboxId, policy) {
      const sandbox = load(sandboxId);
      policyCalls.push({ sandboxId, policy });
      const updated = { ...sandbox, policy };
      sandboxes.set(sandboxId, cloneSandboxHandle(updated));
      return cloneSandboxHandle(updated);
    },

    async bindCredentials(sandboxId, credentials) {
      const sandbox = load(sandboxId);
      const updated = { ...sandbox, credentials };
      sandboxes.set(sandboxId, cloneSandboxHandle(updated));
      return cloneSandboxHandle(updated);
    },

    async run(sandboxId, request): Promise<SandboxRunHandle> {
      const sandbox = load(sandboxId);
      runCalls.push({ sandboxId, request });
      sandboxes.set(
        sandboxId,
        cloneSandboxHandle({ ...sandbox, status: "ready" })
      );
      return {
        id: `${sandboxId}-run-1`,
        sandboxId,
        status: "running"
      };
    },

    async attach(sandboxId) {
      attachCalls.push(sandboxId);
      return load(sandboxId);
    },

    async *streamEvents(_sandboxId): AsyncIterable<SandboxEvent> {
      // The runtime factory does not consume sandbox event streams yet.
    },

    async terminate(sandboxId) {
      const sandbox = load(sandboxId);
      terminated.push(sandboxId);
      sandboxes.set(
        sandboxId,
        cloneSandboxHandle({ ...sandbox, status: "terminated" })
      );
    }
  };
}
