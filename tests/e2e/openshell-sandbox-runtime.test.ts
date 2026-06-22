import { describe, expect, test } from "bun:test";
import { readConfig } from "../../src/config";
import { createTokenStore } from "../../src/db";
import { createConfiguredSandboxProvider } from "../../src/agent/sandbox-providers/configured";
import { createSandboxRuntimeFactory } from "../../src/agent/sandbox-runtime-factory";
import { runRuntimeReadinessCheck } from "../../src/agent/runtime-readiness-harness";
import type { SandboxCredentialBinding } from "../../src/agent/sandbox-provider";

describe("OpenShell sandbox runtime integration", () => {
  test("provisions a runtime through the configured OpenShell HTTP provider", async () => {
    const runtimeServer = startFakeRuntimeServer("hermes");
    const openshell = startFakeOpenShellServer({
      runtimeEndpoint: `http://127.0.0.1:${runtimeServer.port}`,
      token: "openshell-token"
    });
    const store = createTokenStore(":memory:");
    const principal = {
      workspaceId: "T_E2E_SANDBOX",
      slackUserId: "U_E2E_SANDBOX"
    };
    const config = readConfig({
      ...validAppEnv(),
      AGENT_RUNTIME: "burble-runtime",
      AGENT_RUNTIME_FACTORY: "sandbox",
      AGENT_RUNTIME_ENGINE: "hermes",
      AGENT_RUNTIME_TOKEN_SECRET: "runtime-secret",
      AGENT_RUNTIME_SANDBOX_URL: `http://127.0.0.1:${openshell.port}`,
      AGENT_RUNTIME_SANDBOX_TOKEN: "openshell-token",
      AGENT_RUNTIME_SANDBOX_TRANSPORT: "http",
      AGENT_RUNTIME_SANDBOX_START_COMMAND: '["runtime-entrypoint"]'
    });
    const provider = createConfiguredSandboxProvider(config);
    const factory = createSandboxRuntimeFactory({
      store,
      sandboxProvider: provider,
      engine: config.agentRuntimeEngine,
      image: config.agentRuntimeImage,
      toolGatewayUrl: config.agentRuntimeToolGatewayUrl,
      mcpGatewayUrl: config.agentRuntimeMcpGatewayUrl,
      mcpAudience: config.agentRuntimeMcpAudience,
      modelProviderUrls: ["https://api.openai.com/v1"],
      runtimeTokenSecret: config.agentRuntimeTokenSecret ?? "",
      startCommand: config.agentRuntimeSandboxStartCommand ?? [],
      healthCheckAttempts: 1,
      healthCheckIntervalMs: 1,
      fetch,
      env: { AI_MODEL: config.aiModel }
    });

    try {
      const report = await runRuntimeReadinessCheck({
        engine: "hermes",
        principal,
        runtimeFactory: factory,
        store,
        fetch
      });

      expect(report.signals.map((signal) => signal.name)).toEqual([
        "runtime.created",
        "runtime.container_started",
        "runtime.healthz_ok",
        "runtime.capabilities_ok",
        "runtime.ready_recorded"
      ]);
      expect(openshell.requests.every((request) => request.authorized)).toBe(
        true
      );
      expect(openshell.created?.compiledPolicy.egress).toEqual({
        default: "deny",
        allowHosts: ["api.openai.com", "burble-app:3000"]
      });
      expect(openshell.run?.argv).toEqual(["runtime-entrypoint"]);
      expect(openshell.run?.env).toMatchObject({
        BURBLE_RUNTIME_ID: report.runtimeId,
        BURBLE_TOOL_GATEWAY_URL: "http://burble-app:3000/internal/tools",
        AGENT_RUNTIME_ENGINE: "hermes",
        AGENT_RUNTIME_STATE_DIR: "/data/openclaw/state",
        AGENT_RUNTIME_CONFIG_PATH: "/data/openclaw/config/hermes.json",
        AGENT_RUNTIME_WORKSPACE_DIR: "/data/openclaw/workspace",
        HERMES_HOME: "/data/openclaw/hermes",
        AI_MODEL: "openai:gpt-5.4"
      });
      const runtimeToken = openshell.run?.env.BURBLE_INTERNAL_TOKEN;
      expect(runtimeToken).toBeTruthy();
      expect(JSON.stringify(openshell.run?.env)).not.toContain("runtime-secret");
      expect(store.getAgentRuntime(report.runtimeId)?.sandboxId).toBe(
        "openshell-sandbox-1"
      );
    } finally {
      await factory.reapIdleRuntimes(new Date(Date.now() + 90_000_000));
      store.close();
      openshell.stop();
      runtimeServer.stop();
    }
  });
});

const realOpenShellDescribe =
  Bun.env.BURBLE_E2E_OPENSHELL === "1" ? describe : describe.skip;

realOpenShellDescribe("real OpenShell sandbox runtime e2e", () => {
  test(
    "provisions a real sandbox-backed runtime and reaches the runtime contract",
    async () => {
      const store = createTokenStore(":memory:");
      const principal = {
        workspaceId: Bun.env.BURBLE_E2E_WORKSPACE_ID ?? "T_E2E_OPENSHELL",
        slackUserId: `U_E2E_OPENSHELL_${Date.now()}`
      };
      const config = readConfig({
        ...validAppEnv(),
        AGENT_RUNTIME: "burble-runtime",
        AGENT_RUNTIME_FACTORY: "sandbox",
        AGENT_RUNTIME_ENGINE: Bun.env.BURBLE_E2E_RUNTIME_ENGINE ?? "hermes",
        AGENT_RUNTIME_IMAGE:
          Bun.env.BURBLE_E2E_RUNTIME_IMAGE ?? "burble-nemo-hermes:dev",
        AGENT_RUNTIME_TOKEN_SECRET:
          Bun.env.BURBLE_E2E_RUNTIME_TOKEN_SECRET ?? "runtime-e2e-secret",
        AGENT_RUNTIME_SANDBOX_URL: requiredEnv("AGENT_RUNTIME_SANDBOX_URL"),
        AGENT_RUNTIME_SANDBOX_TOKEN: Bun.env.AGENT_RUNTIME_SANDBOX_TOKEN ?? "",
        AGENT_RUNTIME_SANDBOX_START_COMMAND: requiredEnv(
          "AGENT_RUNTIME_SANDBOX_START_COMMAND"
        )
      });
      const factory = createSandboxRuntimeFactory({
        store,
        sandboxProvider: createConfiguredSandboxProvider(config),
        engine: config.agentRuntimeEngine,
        image: config.agentRuntimeImage,
        toolGatewayUrl: config.agentRuntimeToolGatewayUrl,
        mcpGatewayUrl: config.agentRuntimeMcpGatewayUrl,
        mcpAudience: config.agentRuntimeMcpAudience,
        modelProviderUrls: ["https://api.openai.com/v1"],
        runtimeTokenSecret: config.agentRuntimeTokenSecret ?? "",
        startCommand: config.agentRuntimeSandboxStartCommand ?? [],
        healthCheckAttempts: Number.parseInt(
          Bun.env.BURBLE_E2E_HEALTH_ATTEMPTS ?? "120",
          10
        ),
        healthCheckIntervalMs: Number.parseInt(
          Bun.env.BURBLE_E2E_HEALTH_INTERVAL_MS ?? "1000",
          10
        ),
        env: Bun.env
      });
      let runtimeId: string | null = null;

      try {
        const report = await runRuntimeReadinessCheck({
          engine: config.agentRuntimeEngine,
          principal,
          runtimeFactory: factory,
          store
        });
        runtimeId = report.runtimeId;
        expect(report.signals.at(-1)).toEqual({
          name: "runtime.ready_recorded",
          status: "ok"
        });
      } finally {
        if (runtimeId) {
          await factory.stopRuntime(runtimeId);
        }
        store.close();
      }
    },
    { timeout: Number.parseInt(Bun.env.BURBLE_E2E_TIMEOUT_MS ?? "180000", 10) }
  );
});

type FakeOpenShellRequest = {
  method: string;
  pathname: string;
  authorized: boolean;
};

type FakeOpenShellServer = {
  port: number;
  requests: FakeOpenShellRequest[];
  created: { policy: unknown; compiledPolicy: { egress: unknown } } | null;
  policy: { policy: unknown; compiledPolicy: { egress: unknown } } | null;
  credentials: {
    credentialBindings: SandboxCredentialBinding[];
    materializedCredentials: SandboxCredentialBinding[];
  } | null;
  run: { argv: string[]; env: Record<string, string> } | null;
  stop(): void;
};

function startFakeOpenShellServer(input: {
  runtimeEndpoint: string;
  token: string;
}): FakeOpenShellServer {
  const requests: FakeOpenShellRequest[] = [];
  const state: Omit<FakeOpenShellServer, "port" | "requests" | "stop"> = {
    created: null,
    policy: null,
    credentials: null,
    run: null
  };
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const authorized =
        request.headers.get("authorization") === `Bearer ${input.token}`;
      requests.push({
        method: request.method,
        pathname: url.pathname,
        authorized
      });
      if (!authorized) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }

      if (url.pathname === "/sandboxes" && request.method === "POST") {
        const body = (await request.json()) as {
          principal: unknown;
          runtime: unknown;
          labels: Record<string, string>;
          policy?: unknown;
          compiledPolicy?: { egress: unknown };
        };
        state.created =
          body.compiledPolicy === undefined
            ? null
            : { policy: body.policy, compiledPolicy: body.compiledPolicy };
        return Response.json({
          sandboxId: "openshell-sandbox-1",
          endpoint: input.runtimeEndpoint,
          workspacePath: "/openshell/openshell-sandbox-1/workspace",
          status: "ready",
          principal: body.principal,
          runtime: body.runtime,
          labels: body.labels,
          credentials: []
        });
      }
      if (
        url.pathname === "/sandboxes/openshell-sandbox-1/policy" &&
        request.method === "POST"
      ) {
        state.policy = (await request.json()) as typeof state.policy;
        return Response.json({ ok: true });
      }
      if (
        url.pathname === "/sandboxes/openshell-sandbox-1/credentials" &&
        request.method === "POST"
      ) {
        state.credentials = (await request.json()) as typeof state.credentials;
        return Response.json({ ok: true });
      }
      if (
        url.pathname === "/sandboxes/openshell-sandbox-1/runs" &&
        request.method === "POST"
      ) {
        state.run = (await request.json()) as typeof state.run;
        return Response.json({
          runId: "openshell-run-1",
          status: "running"
        });
      }
      if (
        url.pathname === "/sandboxes/openshell-sandbox-1" &&
        request.method === "GET"
      ) {
        return Response.json({
          sandboxId: "openshell-sandbox-1",
          endpoint: input.runtimeEndpoint,
          workspacePath: "/openshell/openshell-sandbox-1/workspace",
          status: "ready",
          principal: { workspaceId: "T_E2E_SANDBOX", userId: "U_E2E_SANDBOX" },
          runtime: { engine: "hermes", image: "burble-nemo-hermes:dev" },
          labels: { runtimeDataId: "sandbox-runtime-data" },
          policy: state.policy?.policy,
          credentials: state.credentials?.credentialBindings ?? []
        });
      }
      if (
        url.pathname === "/sandboxes/openshell-sandbox-1" &&
        request.method === "DELETE"
      ) {
        return new Response(null, { status: 204 });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    }
  });

  return {
    get port() {
      return server.port ?? 0;
    },
    requests,
    get created() {
      return state.created;
    },
    get policy() {
      return state.policy;
    },
    get credentials() {
      return state.credentials;
    },
    get run() {
      return state.run;
    },
    stop() {
      server.stop(true);
    }
  };
}

function startFakeRuntimeServer(engine: "hermes") {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/healthz") {
        return Response.json({ ok: true });
      }
      if (url.pathname === "/capabilities") {
        return Response.json({
          runtimeType: engine,
          version: "1",
          transports: ["http", "websocket"],
          streaming: true,
          cancellation: false,
          nativeScheduler: true,
          scheduledProviderCalls: true,
          toolCalls: true,
          toolBridgeModes: ["tool_gateway"],
          usageReporting: "exact",
          multimodalInput: false,
          multimodalOutput: false,
          memory: false,
          durableWorkflowState: true,
          attachments: false,
          conversationSend: true,
          jobScopedAuth: true
        });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    }
  });

  return {
    get port() {
      return server.port;
    },
    stop() {
      server.stop(true);
    }
  };
}

function validAppEnv(): Record<string, string> {
  return {
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_APP_TOKEN: "xapp-test",
    GITHUB_CLIENT_ID: "github-client-id",
    GITHUB_CLIENT_SECRET: "github-client-secret",
    BASE_URL: "https://burble.example.test",
    INTERNAL_API_TOKEN: "internal-secret",
    AI_MODEL: "openai:gpt-5.4"
  };
}

function requiredEnv(name: string): string {
  const value = Bun.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
