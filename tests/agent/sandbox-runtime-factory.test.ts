import { describe, expect, test } from "bun:test";
import { createSandboxRuntimeFactory } from "../../src/agent/sandbox-runtime-factory";
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
    expect(stored?.policyHash).toBe("policy-hash");
    expect(provider.provisionCalls).toHaveLength(1);
    expect(provider.policyCalls).toEqual([
      {
        sandboxId: "sandbox-1",
        policy: {
          network: {
            egress: "allowlist",
            allowedHosts: [
              "agentgateway:3000",
              "api.openai.com",
              "burble-app:3000"
            ]
          }
        }
      }
    ]);
    expect(provider.runCalls).toHaveLength(1);
    expect(provider.runCalls[0].request).toMatchObject({
      argv: ["runtime-entrypoint"],
      env: {
        BURBLE_TOOL_GATEWAY_URL: "http://burble-app:3000/internal/tools",
        BURBLE_INTERNAL_TOKEN: handle.authToken,
        BURBLE_RUNTIME_ID: handle.id,
        BURBLE_MCP_GATEWAY_URL: "http://agentgateway:3000/mcp",
        AGENT_RUNTIME_ENGINE: "openclaw",
        AGENT_RUNTIME_CONFIG_PATH: "/data/openclaw/config/openclaw.json",
        OPENCLAW_NEMOCLAW_ENGINE: "openclaw",
        AI_MODEL: "openai:gpt-5.4"
      }
    });
    expect(provider.runCalls[0].request.env?.BURBLE_RUNTIME_JWT).toContain(
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
    policyHash = "policy-b";
    const second = await factory.getOrCreateRuntime(principal);

    expect(second.id).toBe(first.id);
    expect(second.endpointUrl).toBe(first.endpointUrl);
    expect(provider.provisionCalls).toHaveLength(1);
    expect(provider.attachCalls).toEqual(["sandbox-1"]);
    expect(provider.runCalls).toHaveLength(1);
    expect(provider.policyCalls).toHaveLength(2);
    expect(store.getAgentRuntime(first.id)?.policyHash).toBe("policy-b");

    store.close();
  });

  test("terminates failed provisioning sandboxes and reprovisions on retry", async () => {
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
      fetch: async () => new Response("ok")
    });

    provider.failNextRun = true;
    await expect(factory.getOrCreateRuntime(principal)).rejects.toThrow(
      "Sandbox runtime start failed"
    );

    const runtimeId = `rt_${buildRuntimeDataId(principal, "hermes")}`;
    expect(store.getAgentRuntime(runtimeId)).toMatchObject({
      status: "failed",
      sandboxId: "sandbox-1"
    });
    expect(provider.terminated).toEqual(["sandbox-1"]);

    const retry = await factory.getOrCreateRuntime(principal);

    expect(retry.id).toBe(runtimeId);
    expect(store.getAgentRuntime(retry.id)).toMatchObject({
      status: "ready",
      sandboxId: "sandbox-2"
    });
    expect(provider.provisionCalls).toHaveLength(2);
    expect(provider.attachCalls).toEqual([]);

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
  failNextRun: boolean;
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
    failNextRun: false,

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
      if (this.failNextRun) {
        this.failNextRun = false;
        return {
          id: `${sandboxId}-run-1`,
          sandboxId,
          status: "failed",
          exitCode: 1
        };
      }
      sandboxes.set(
        sandboxId,
        cloneSandboxHandle({ ...sandbox, status: "ready" })
      );
      return {
        id: `${sandboxId}-run-1`,
        sandboxId,
        status: "finished",
        exitCode: 0
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
