import { describe, expect, test } from "bun:test";
import {
  buildContainerRuntimeSpec,
  createDockerRuntimeFactory,
  deriveRuntimeToken
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
      runtimeToken: "runtime-token",
      runtimeDataId,
      openClawConfigPatchPath: "/opt/burble/openclaw-patches",
      env: {
        OPENAI_API_KEY: "openai-key",
        ANTHROPIC_API_KEY: "anthropic-key",
        OPENCLAW_STREAM_DEBUG: "true",
        GITHUB_TOKEN: "github-secret",
        SLACK_BOT_TOKEN: "slack-secret"
      }
    });

    expect(spec.name).toBe(`burble-rt-${runtimeDataId}`);
    expect(spec.endpointUrl).toBe(`http://burble-rt-${runtimeDataId}:8080`);
    expect(spec.env).toMatchObject({
      BURBLE_TOOL_GATEWAY_URL: "http://burble-app:3000/internal/tools",
      BURBLE_INTERNAL_TOKEN: "runtime-token",
      OPENCLAW_NEMOCLAW_ENGINE: "openclaw",
      OPENAI_API_KEY: "openai-key",
      ANTHROPIC_API_KEY: "anthropic-key",
      OPENCLAW_STREAM_DEBUG: "true"
    });
    expect(spec.env.GITHUB_TOKEN).toBeUndefined();
    expect(spec.env.SLACK_BOT_TOKEN).toBeUndefined();
    expect(spec.volumes).toContainEqual({
      source: `/data/runtimes/${runtimeDataId}`,
      target: "/data/openclaw"
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
      runtimeTokenSecret: "runtime-secret",
      openClawConfigPatchPath: "/opt/burble/openclaw-patches",
      env: { OPENAI_API_KEY: "openai-key", GITHUB_TOKEN: "github-secret" },
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
      }
    });

    const handle = await factory.getOrCreateRuntime(principal);
    const runtimeDataId = buildRuntimeDataId(principal, "openclaw");
    const stored = store.getAgentRuntime(handle.id);
    const events = store.listAgentRuntimeEvents(handle.id);

    expect(handle.endpointUrl).toBe(`http://burble-rt-${runtimeDataId}:8080`);
    expect(handle.statePath).toBe(`/data/runtimes/${runtimeDataId}/state`);
    expect(stored?.status).toBe("ready");
    expect(stored?.authTokenHash).not.toContain("runtime-secret");
    expect(healthChecks).toBe(2);
    expect(commands.map((command) => command.args[0])).toEqual([
      "inspect",
      "run"
    ]);
    expect(commands[1].args).toContain("OPENAI_API_KEY=openai-key");
    expect(commands[1].args.join(" ")).not.toContain("github-secret");
    expect(events.map((event) => event.eventType)).toEqual([
      "runtime_provision_requested",
      "runtime_provision_finished"
    ]);
    expect(events.map((event) => event.summaryJson).join("\n")).not.toContain(
      "github-secret"
    );

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
