import { describe, expect, test } from "bun:test";
import {
  buildContainerRuntimeSpec,
  createDockerRuntimeFactory,
  deriveRuntimeToken,
  toRuntimeContainerPath
} from "../../src/agent/container-runtime-factory";
import { buildRuntimeDataId } from "../../src/agent/runtime-factory";
import { createTokenStore } from "../../src/db";

const principal = {
  workspaceId: "T123",
  slackUserId: "U123"
};

describe("buildContainerRuntimeSpec", () => {
  test("forwards only approved runtime environment variables", () => {
    const runtimeDataId = buildRuntimeDataId(principal, "openclaw");
    const spec = buildContainerRuntimeSpec({
      principal,
      engine: "openclaw",
      image: "burble-openclaw-nemoclaw:dev",
      dataRoot: "/data/runtimes",
      dockerNetwork: "compose_default",
      toolGatewayUrl: "http://burble-app:3000/internal/tools",
      mcpGatewayUrl: "http://agentgateway:3000/mcp",
      runtimeToken: "runtime-token",
      runtimeId: "rt_u123",
      runtimeJwt: "runtime-jwt",
      runtimeDataId,
      manifest: {
        version: "1",
        principal,
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
        memoryContext: [],
        disabledTools: [],
        policyHash: "policy"
      },
      openClawConfigPatchPath: "/opt/burble/openclaw-patches",
      env: {
        AI_MODEL: "ollama:qwen3-coder:30b-cloud",
        OPENAI_API_KEY: "openai-key",
        OPENAI_BASE_URL: "https://openai-compatible.example/v1",
        OPENROUTER_API_KEY: "openrouter-key",
        GOOGLE_API_KEY: "google-key",
        GEMINI_API_KEY: "gemini-key",
        ANTHROPIC_API_KEY: "anthropic-key",
        OLLAMA_API_KEY: "ollama-key",
        OLLAMA_BASE_URL: "https://ollama.com",
        OLLAMA_OPENAI_BASE_URL: "https://ollama.com/v1",
        OPENCLAW_TIMEOUT_MS: "180000",
        OPENCLAW_STREAM_DEBUG: "true",
        OPENCLAW_LOG_LEVEL: "debug",
        OPENCLAW_DIAGNOSTICS: "model.*",
        OPENCLAW_DEBUG_MODEL_TRANSPORT: "true",
        OPENCLAW_DEBUG_MODEL_PAYLOAD: "summary",
        OPENCLAW_DEBUG_SSE: "events",
        OPENCLAW_DEBUG_CODE_MODE: "true",
        OPENCLAW_FAST_MODE: "true",
        OPENCLAW_RAW_STREAM_DEBUG: "true",
        OPENCLAW_GATEWAY_PORT: "18790",
        OPENCLAW_GATEWAY_BIND: "loopback",
        OPENCLAW_GATEWAY_TOKEN: "gateway-token",
        HERMES_INFERENCE_MODEL: "openai:gpt-5.4",
        HERMES_INFERENCE_PROVIDER: "openai-api",
        HERMES_RUN_TIMEOUT_SECONDS: "240",
        HERMES_PROGRESS_INTERVAL_SECONDS: "8",
        HERMES_WEB_BACKEND: "ddgs",
        HERMES_WEB_SEARCH_BACKEND: "ddgs",
        HERMES_WEB_EXTRACT_BACKEND: "firecrawl",
        WEB_TOOLS_DEBUG: "true",
        EXA_API_KEY: "exa-key",
        PARALLEL_API_KEY: "parallel-key",
        PARALLEL_SEARCH_MODE: "web",
        TAVILY_API_KEY: "tavily-key",
        FIRECRAWL_API_KEY: "firecrawl-key",
        FIRECRAWL_API_URL: "https://firecrawl.example",
        FIRECRAWL_GATEWAY_URL: "https://firecrawl-gateway.example",
        SEARXNG_URL: "https://searxng.example",
        BRAVE_SEARCH_API_KEY: "brave-key",
        AGENT_BROWSER_ENGINE: "chrome",
        AGENT_BROWSER_ARGS: "--no-sandbox",
        AGENT_BROWSER_EXECUTABLE_PATH: "/usr/bin/chromium",
        AGENT_BROWSER_IDLE_TIMEOUT_MS: "300000",
        BROWSER_INACTIVITY_TIMEOUT: "300",
        BROWSER_CDP_URL: "ws://browser.example/devtools/browser/1",
        BROWSER_USE_API_KEY: "browser-use-key",
        BROWSERBASE_API_KEY: "browserbase-key",
        BROWSERBASE_PROJECT_ID: "browserbase-project",
        BROWSERBASE_PROXIES: "false",
        BROWSERBASE_ADVANCED_STEALTH: "true",
        BROWSERBASE_KEEP_ALIVE: "true",
        BROWSERBASE_SESSION_TIMEOUT: "600",
        HERMES_BROWSER_ENGINE: "chrome",
        HERMES_BROWSER_CLOUD_PROVIDER: "browser-use",
        GITHUB_TOKEN: "github-secret",
        SLACK_BOT_TOKEN: "slack-secret"
      }
    });

    expect(spec.name).toBe(`burble-rt-${runtimeDataId}`);
    expect(spec.endpointUrl).toBe(`http://burble-rt-${runtimeDataId}:8080`);
    expect(spec.env).toMatchObject({
      BURBLE_TOOL_GATEWAY_URL: "http://burble-app:3000/internal/tools",
      BURBLE_INTERNAL_TOKEN: "runtime-token",
      BURBLE_RUNTIME_ID: "rt_u123",
      BURBLE_MCP_GATEWAY_URL: "http://agentgateway:3000/mcp",
      BURBLE_RUNTIME_JWT: "runtime-jwt",
      AGENT_RUNTIME_ENGINE: "openclaw",
      AGENT_RUNTIME_STATE_DIR: "/data/openclaw/state",
      AGENT_RUNTIME_CONFIG_PATH: "/data/openclaw/config/openclaw.json",
      AGENT_RUNTIME_WORKSPACE_DIR: "/data/openclaw/workspace",
      OPENCLAW_NEMOCLAW_ENGINE: "openclaw",
      OPENCLAW_CONFIG_PATH: "/data/openclaw/config/openclaw.json",
      AI_MODEL: "openai:gpt-5.4",
      OPENAI_API_KEY: "openai-key",
      OPENAI_BASE_URL: "https://openai-compatible.example/v1",
      OPENROUTER_API_KEY: "openrouter-key",
      GOOGLE_API_KEY: "google-key",
      GEMINI_API_KEY: "gemini-key",
      ANTHROPIC_API_KEY: "anthropic-key",
      OLLAMA_API_KEY: "ollama-key",
      OLLAMA_BASE_URL: "https://ollama.com",
      OLLAMA_OPENAI_BASE_URL: "https://ollama.com/v1",
      OPENCLAW_TIMEOUT_MS: "180000",
      OPENCLAW_STREAM_DEBUG: "true",
      OPENCLAW_LOG_LEVEL: "debug",
      OPENCLAW_DIAGNOSTICS: "model.*",
      OPENCLAW_DEBUG_MODEL_TRANSPORT: "true",
      OPENCLAW_DEBUG_MODEL_PAYLOAD: "summary",
      OPENCLAW_DEBUG_SSE: "events",
      OPENCLAW_DEBUG_CODE_MODE: "true",
      OPENCLAW_FAST_MODE: "true",
      OPENCLAW_RAW_STREAM_DEBUG: "true",
      OPENCLAW_GATEWAY_PORT: "18790",
      OPENCLAW_GATEWAY_BIND: "loopback",
      OPENCLAW_GATEWAY_TOKEN: "gateway-token",
      HERMES_INFERENCE_MODEL: "openai:gpt-5.4",
      HERMES_INFERENCE_PROVIDER: "openai-api",
      HERMES_RUN_TIMEOUT_SECONDS: "240",
      HERMES_PROGRESS_INTERVAL_SECONDS: "8",
      HERMES_WEB_BACKEND: "ddgs",
      HERMES_WEB_SEARCH_BACKEND: "ddgs",
      HERMES_WEB_EXTRACT_BACKEND: "firecrawl",
      WEB_TOOLS_DEBUG: "true",
      EXA_API_KEY: "exa-key",
      PARALLEL_API_KEY: "parallel-key",
      PARALLEL_SEARCH_MODE: "web",
      TAVILY_API_KEY: "tavily-key",
      FIRECRAWL_API_KEY: "firecrawl-key",
      FIRECRAWL_API_URL: "https://firecrawl.example",
      FIRECRAWL_GATEWAY_URL: "https://firecrawl-gateway.example",
      SEARXNG_URL: "https://searxng.example",
      BRAVE_SEARCH_API_KEY: "brave-key",
      AGENT_BROWSER_ENGINE: "chrome",
      AGENT_BROWSER_ARGS: "--no-sandbox",
      AGENT_BROWSER_EXECUTABLE_PATH: "/usr/bin/chromium",
      AGENT_BROWSER_IDLE_TIMEOUT_MS: "300000",
      BROWSER_INACTIVITY_TIMEOUT: "300",
      BROWSER_CDP_URL: "ws://browser.example/devtools/browser/1",
      BROWSER_USE_API_KEY: "browser-use-key",
      BROWSERBASE_API_KEY: "browserbase-key",
      BROWSERBASE_PROJECT_ID: "browserbase-project",
      BROWSERBASE_PROXIES: "false",
      BROWSERBASE_ADVANCED_STEALTH: "true",
      BROWSERBASE_KEEP_ALIVE: "true",
      BROWSERBASE_SESSION_TIMEOUT: "600",
      HERMES_BROWSER_ENGINE: "chrome",
      HERMES_BROWSER_CLOUD_PROVIDER: "browser-use"
    });
    expect(spec.env.GITHUB_TOKEN).toBeUndefined();
    expect(spec.env.SLACK_BOT_TOKEN).toBeUndefined();
    expect(spec.volumes).toContainEqual({
      source: `/data/runtimes/${runtimeDataId}`,
      target: "/data/openclaw"
    });
  });

  test("uses engine-specific runtime config filenames", () => {
    const runtimeDataId = buildRuntimeDataId(principal, "hermes");
    const spec = buildContainerRuntimeSpec({
      principal,
      engine: "hermes",
      image: "nemo-hermes:dev",
      dataRoot: "/data/runtimes",
      dockerNetwork: "compose_default",
      toolGatewayUrl: "http://burble-app:3000/internal/tools",
      runtimeToken: "runtime-token",
      runtimeDataId
    });

    expect(spec.env).toMatchObject({
      AGENT_RUNTIME_ENGINE: "hermes",
      AGENT_RUNTIME_CONFIG_PATH: "/data/openclaw/config/hermes.json",
      HERMES_HOME: "/data/openclaw/hermes"
    });
    expect(spec.env.OPENCLAW_NEMOCLAW_ENGINE).toBeUndefined();
    expect(spec.env.OPENCLAW_CONFIG_PATH).toBeUndefined();
  });

  test("makes the manifest model authoritative for Hermes runtime config", () => {
    const runtimeDataId = buildRuntimeDataId(principal, "hermes");
    const spec = buildContainerRuntimeSpec({
      principal,
      engine: "hermes",
      image: "nemo-hermes:dev",
      dataRoot: "/data/runtimes",
      dockerNetwork: "compose_default",
      toolGatewayUrl: "http://burble-app:3000/internal/tools",
      runtimeToken: "runtime-token",
      runtimeDataId,
      manifest: {
        version: "1",
        principal,
        runtime: {
          engine: "hermes",
          factory: "docker",
          ttlMs: 86400000,
          reaperEnabled: true
        },
        model: { provider: "openai", model: "gpt-5.4-mini" },
        tools: [],
        skills: [],
        memory: {
          userMemoryEnabled: false,
          workspaceMemoryEnabled: false,
          jobMemoryEnabled: true
        },
        disabledTools: [],
        policyHash: "policy"
      } as never,
      env: {
        AI_MODEL: "openai:gpt-5.5",
        HERMES_INFERENCE_MODEL: "openai:gpt-5.5",
        HERMES_INFERENCE_PROVIDER: "openai-api"
      }
    });

    expect(spec.env).toMatchObject({
      AI_MODEL: "openai:gpt-5.4-mini",
      HERMES_INFERENCE_MODEL: "openai:gpt-5.4-mini",
      HERMES_INFERENCE_PROVIDER: "openai"
    });
  });
});

describe("deriveRuntimeToken", () => {
  test("derives stable principal-scoped tokens", () => {
    const first = deriveRuntimeToken({
      secret: "runtime-secret",
      principal,
      engine: "openclaw"
    });
    const second = deriveRuntimeToken({
      secret: "runtime-secret",
      principal,
      engine: "openclaw"
    });
    const otherUser = deriveRuntimeToken({
      secret: "runtime-secret",
      principal: { ...principal, slackUserId: "U456" },
      engine: "openclaw"
    });

    expect(first).toBe(second);
    expect(first).not.toBe(otherUser);
    expect(first).toStartWith("burble_rt_");
  });
});

describe("toRuntimeContainerPath", () => {
  test("maps runtime-root host paths into the mounted container path", () => {
    expect(
      toRuntimeContainerPath({
        hostPath: "/opt/burble/runtimes/u123/config/runtime.json",
        runtimeRoot: "/opt/burble/runtimes/u123"
      })
    ).toBe("/data/openclaw/config/runtime.json");

    expect(
      toRuntimeContainerPath({
        hostPath: "/shared/runtime.json",
        runtimeRoot: "/opt/burble/runtimes/u123"
      })
    ).toBe("/shared/runtime.json");
  });
});

describe("createDockerRuntimeFactory", () => {
  test("starts a runtime container and waits for health", async () => {
    const store = createTokenStore(":memory:");
    const commands: Array<{ command: string; args: string[] }> = [];
    let healthChecks = 0;
    const factory = createDockerRuntimeFactory({
      store,
      engine: "openclaw",
      image: "burble-openclaw-nemoclaw:dev",
      dataRoot: "/data/runtimes",
      dockerNetwork: "compose_default",
      toolGatewayUrl: "http://burble-app:3000/internal/tools",
      mcpGatewayUrl: "http://agentgateway:3000/mcp",
      mcpAudience: "http://agentgateway:3000/mcp",
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
      runtimeJwtTtlSeconds: 86400,
      runtimeTokenSecret: "runtime-secret",
      openClawConfigPatchPath: "/opt/burble/openclaw-patches",
      env: {
        AI_MODEL: "ollama:qwen3-coder:30b-cloud",
        OPENAI_API_KEY: "openai-key",
        GITHUB_TOKEN: "github-secret"
      },
      healthCheckAttempts: 2,
      healthCheckIntervalMs: 0,
      execute: async (command, args) => {
        commands.push({ command, args });
        if (args[0] === "inspect") {
          return { code: 1, stdout: "", stderr: "not found" };
        }
        return { code: 0, stdout: "container-id\n", stderr: "" };
      },
      fetch: async () => {
        healthChecks += 1;
        return new Response("ok", { status: healthChecks === 1 ? 503 : 200 });
      },
      buildManifest: (principal) =>
        ({
          version: "1",
          principal,
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
          disabledTools: [],
          policyHash: "policy-hash"
        }) as never
    });

    const handle = await factory.getOrCreateRuntime(principal);
    const runtimeDataId = buildRuntimeDataId(principal, "openclaw");
    const stored = store.getAgentRuntime(handle.id);
    const events = store.listAgentRuntimeEvents(handle.id);

    expect(handle.endpointUrl).toBe(`http://burble-rt-${runtimeDataId}:8080`);
    expect(handle.manifest?.policyHash).toBe("policy-hash");
    expect(handle.statePath).toBe(`/data/runtimes/${runtimeDataId}/state`);
    expect(stored?.status).toBe("ready");
    expect(stored?.policyHash).toBe("policy-hash");
    expect(stored?.authTokenHash).not.toContain("runtime-secret");
    expect(healthChecks).toBe(2);
    expect(commands.map((command) => command.args[0])).toEqual([
      "inspect",
      "run"
    ]);
    expect(commands[1].args).toContain("OPENAI_API_KEY=openai-key");
    expect(commands[1].args).toContain("AI_MODEL=openai:gpt-5.4");
    expect(commands[1].args).toContain("BURBLE_MCP_GATEWAY_URL=http://agentgateway:3000/mcp");
    expect(commands[1].args.join(" ")).toContain(`BURBLE_RUNTIME_JWT=jwt:http://agentgateway:3000/mcp:${handle.id}:T123:U123:86400`);
    expect(commands[1].args.join(" ")).not.toContain("github-secret");
    expect(events.map((event) => event.eventType)).toEqual([
      "runtime_provision_requested",
      "runtime_provision_finished"
    ]);
    expect(events.map((event) => event.summaryJson).join("\n")).not.toContain(
      "github-secret"
    );
    expect(events[0].summaryJson).toContain("policy-hash");

    store.close();
  });

  test("reads runtime config through the runtime container mount", async () => {
    const store = createTokenStore(":memory:");
    const commands: Array<{ command: string; args: string[] }> = [];
    const factory = createDockerRuntimeFactory({
      store,
      engine: "openclaw",
      image: "burble-openclaw-nemoclaw:dev",
      dataRoot: "/opt/burble/runtimes",
      dockerNetwork: "compose_default",
      toolGatewayUrl: "http://burble-app:3000/internal/tools",
      runtimeTokenSecret: "runtime-secret",
      healthCheckAttempts: 1,
      execute: async (command, args) => {
        commands.push({ command, args });
        if (args[0] === "inspect") {
          return { code: 1, stdout: "", stderr: "not found" };
        }
        if (args[0] === "exec") {
          return {
            code: 0,
            stdout: "{\"runtime\":true}\n",
            stderr: ""
          };
        }
        return { code: 0, stdout: "container-id\n", stderr: "" };
      },
      fetch: async () => new Response("ok")
    });

    const handle = await factory.getOrCreateRuntime(principal);
    const config = await factory.readRuntimeConfig?.(handle.id);
    const execCommand = commands.find((command) => command.args[0] === "exec");

    expect(config).toEqual({
      path: `/opt/burble/runtimes/${buildRuntimeDataId(principal, "openclaw")}/config/openclaw.json`,
      text: "{\"runtime\":true}\n"
    });
    expect(execCommand?.args).toEqual([
      "exec",
      `burble-rt-${buildRuntimeDataId(principal, "openclaw")}`,
      "cat",
      "/data/openclaw/config/openclaw.json"
    ]);

    store.close();
  });

  test("recreates a stopped MCP runtime instead of reusing stale JWT env", async () => {
    const store = createTokenStore(":memory:");
    const commands: Array<{ command: string; args: string[] }> = [];
    const factory = createDockerRuntimeFactory({
      store,
      engine: "openclaw",
      image: "burble-openclaw-nemoclaw:dev",
      dataRoot: "/data/runtimes",
      dockerNetwork: "compose_default",
      toolGatewayUrl: "http://burble-app:3000/internal/tools",
      mcpGatewayUrl: "http://agentgateway:3000/mcp",
      runtimeJwtIssuer: {
        issueRuntimeJwt: (claims: { runtimeId: string }) =>
          `fresh-jwt:${claims.runtimeId}`
      } as never,
      runtimeTokenSecret: "runtime-secret",
      healthCheckAttempts: 1,
      healthCheckIntervalMs: 0,
      execute: async (command, args) => {
        commands.push({ command, args });
        if (args[0] === "inspect") {
          return { code: 0, stdout: "false\n", stderr: "" };
        }
        return { code: 0, stdout: "ok\n", stderr: "" };
      },
      fetch: async () => new Response("ok")
    });

    await factory.getOrCreateRuntime(principal);

    expect(commands.map((command) => command.args[0])).toEqual([
      "inspect",
      "rm",
      "run"
    ]);
    expect(commands[2].args.join(" ")).toContain("BURBLE_RUNTIME_JWT=fresh-jwt:");
    expect(commands[2].args.join(" ")).not.toContain("docker start");

    store.close();
  });

  test("marks runtime failed when health checks fail", async () => {
    const store = createTokenStore(":memory:");
    const factory = createDockerRuntimeFactory({
      store,
      engine: "openclaw",
      image: "burble-openclaw-nemoclaw:dev",
      dataRoot: "/data/runtimes",
      dockerNetwork: "compose_default",
      toolGatewayUrl: "http://burble-app:3000/internal/tools",
      runtimeTokenSecret: "runtime-secret",
      healthCheckAttempts: 1,
      healthCheckIntervalMs: 0,
      execute: async (_command, args) =>
        args[0] === "inspect"
          ? { code: 1, stdout: "", stderr: "not found" }
          : { code: 0, stdout: "container-id\n", stderr: "" },
      fetch: async () => new Response("not ready", { status: 503 })
    });

    await expect(factory.getOrCreateRuntime(principal)).rejects.toThrow(
      "Runtime health check failed"
    );

    const runtimeDataId = buildRuntimeDataId(principal, "openclaw");
    const runtimeId = `rt_${runtimeDataId}`;
    expect(store.getAgentRuntime(runtimeId)).toMatchObject({
      status: "failed",
      failureReason: "Runtime health check failed: HTTP 503"
    });
    expect(
      store
        .listAgentRuntimeEvents(runtimeId)
        .map((event) => event.eventType)
    ).toEqual(["runtime_provision_requested", "runtime_provision_failed"]);

    store.close();
  });

  test("syncs stale ready state when the container is gone", async () => {
    const store = createTokenStore(":memory:");
    const runtime = store.getOrCreateAgentRuntime({
      workspaceId: "T123",
      slackUserId: "U123",
      engine: "hermes",
      endpointUrl: "http://burble-rt-hermes:8080",
      authTokenHash: "hash",
      statePath: "/data/state",
      configPath: "/data/config/hermes.json",
      workspacePath: "/data/workspace",
      policyHash: "policy"
    });
    const factory = createDockerRuntimeFactory({
      store,
      engine: "hermes",
      image: "burble-nemo-hermes:dev",
      dataRoot: "/data/runtimes",
      dockerNetwork: "compose_default",
      toolGatewayUrl: "http://burble-app:3000/internal/tools",
      runtimeTokenSecret: "runtime-secret",
      execute: async () => ({ code: 1, stdout: "", stderr: "not found" }),
      fetch: async () => new Response("not used")
    });

    const synced = await factory.syncRuntimeStatus?.(runtime.id);

    expect(synced?.status).toBe("stopped");
    expect(synced?.failureReason).toBe("Runtime container is not present");
    expect(store.getAgentRuntime(runtime.id)?.status).toBe("stopped");

    store.close();
  });

  test("syncs runtime as failed when health check fails", async () => {
    const store = createTokenStore(":memory:");
    const runtime = store.getOrCreateAgentRuntime({
      workspaceId: "T123",
      slackUserId: "U123",
      engine: "hermes",
      endpointUrl: "http://burble-rt-hermes:8080",
      authTokenHash: "hash",
      statePath: "/data/state",
      configPath: "/data/config/hermes.json",
      workspacePath: "/data/workspace",
      policyHash: "policy"
    });
    const factory = createDockerRuntimeFactory({
      store,
      engine: "hermes",
      image: "burble-nemo-hermes:dev",
      dataRoot: "/data/runtimes",
      dockerNetwork: "compose_default",
      toolGatewayUrl: "http://burble-app:3000/internal/tools",
      runtimeTokenSecret: "runtime-secret",
      execute: async () => ({
        code: 0,
        stdout: "{\"Running\":true,\"Restarting\":false,\"ExitCode\":0}\n",
        stderr: ""
      }),
      fetch: async () => new Response("not ready", { status: 503 })
    });

    const synced = await factory.syncRuntimeStatus?.(runtime.id);

    expect(synced?.status).toBe("failed");
    expect(synced?.failureReason).toBe(
      "Runtime health check failed: HTTP 503"
    );

    store.close();
  });

  test("retries health checks when the runtime port is not ready yet", async () => {
    const store = createTokenStore(":memory:");
    let healthChecks = 0;
    const factory = createDockerRuntimeFactory({
      store,
      engine: "openclaw",
      image: "burble-openclaw-nemoclaw:dev",
      dataRoot: "/data/runtimes",
      dockerNetwork: "compose_default",
      toolGatewayUrl: "http://burble-app:3000/internal/tools",
      runtimeTokenSecret: "runtime-secret",
      healthCheckAttempts: 3,
      healthCheckIntervalMs: 0,
      execute: async (_command, args) =>
        args[0] === "inspect"
          ? { code: 1, stdout: "", stderr: "not found" }
          : { code: 0, stdout: "container-id\n", stderr: "" },
      fetch: async () => {
        healthChecks += 1;
        if (healthChecks < 3) {
          throw new Error("ConnectionRefused");
        }
        return new Response("ok");
      }
    });

    await expect(factory.getOrCreateRuntime(principal)).resolves.toMatchObject({
      endpointUrl: expect.stringContaining("burble-rt-")
    });
    expect(healthChecks).toBe(3);

    store.close();
  });

  test("reaps stale ready and idle containers only", async () => {
    const store = createTokenStore(":memory:");
    const stopped: string[] = [];
    const factory = createDockerRuntimeFactory({
      store,
      engine: "openclaw",
      image: "burble-openclaw-nemoclaw:dev",
      dataRoot: "/data/runtimes",
      dockerNetwork: "compose_default",
      toolGatewayUrl: "http://burble-app:3000/internal/tools",
      runtimeTokenSecret: "runtime-secret",
      idleTtlMs: 5 * 60 * 1000,
      execute: async (_command, args) => {
        if (args[0] === "stop") {
          stopped.push(args[1]);
        }
        return { code: 0, stdout: "true\n", stderr: "" };
      },
      fetch: async () => new Response("ok")
    });

    const stale = await factory.getOrCreateRuntime(principal);
    const fresh = await factory.getOrCreateRuntime({
      ...principal,
      slackUserId: "U456"
    });
    const busy = await factory.getOrCreateRuntime({
      ...principal,
      slackUserId: "U789"
    });
    store.touchAgentRuntime(
      stale.id,
      new Date("2026-05-21T00:00:00.000Z")
    );
    store.touchAgentRuntime(
      fresh.id,
      new Date("2026-05-21T00:08:00.000Z")
    );
    store.touchAgentRuntime(busy.id, new Date("2026-05-21T00:00:00.000Z"));
    store.updateAgentRuntimeStatus(busy.id, {
      status: "busy",
      now: new Date("2026-05-21T00:09:00.000Z")
    });

    await factory.reapIdleRuntimes(new Date("2026-05-21T00:10:00.000Z"));

    expect(stopped).toEqual([
      `burble-rt-${buildRuntimeDataId(principal, "openclaw")}`
    ]);
    expect(
      store
        .listAgentRuntimeEvents(stale.id)
        .some((event) => event.eventType === "runtime_stopped")
    ).toBe(true);
    expect(store.getAgentRuntime(stale.id)?.status).toBe("stopped");
    expect(store.getAgentRuntime(fresh.id)?.status).toBe("ready");
    expect(store.getAgentRuntime(busy.id)?.status).toBe("busy");

    store.close();
  });
});
