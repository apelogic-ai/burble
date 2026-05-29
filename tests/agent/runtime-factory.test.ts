import { describe, expect, test } from "bun:test";
import { createTokenStore } from "../../src/db";
import {
  createStaticRuntimeFactory,
  nativeAgentConfigFileName
} from "../../src/agent/runtime-factory";

describe("createStaticRuntimeFactory", () => {
  test("returns a principal-scoped runtime handle backed by the registry", async () => {
    const store = createTokenStore(":memory:");
    const factory = createStaticRuntimeFactory({
      store,
      engine: "openclaw",
      endpointUrl: "http://openclaw-nemoclaw:8080",
      authToken: "runtime-token",
      dataRoot: "/data/runtimes",
      buildManifest: (principal) =>
        ({
          version: "1",
          principal,
          runtime: {
            engine: "openclaw",
            factory: "static",
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

    const first = await factory.getOrCreateRuntime({
      workspaceId: "T123",
      slackUserId: "U123"
    });
    const second = await factory.getOrCreateRuntime({
      workspaceId: "T123",
      slackUserId: "U123"
    });
    const otherUser = await factory.getOrCreateRuntime({
      workspaceId: "T123",
      slackUserId: "U456"
    });

    expect(second).toEqual(first);
    expect(otherUser.id).not.toBe(first.id);
    expect(first).toMatchObject({
      engine: "openclaw",
      endpointUrl: "http://openclaw-nemoclaw:8080",
      authToken: "runtime-token",
      status: "ready"
    });
    expect(first.manifest?.policyHash).toBe("policy-hash");
    expect(first.statePath).toStartWith("/data/runtimes/");
    expect(first.configPath).toEndWith("/config/openclaw.json");
    expect(first.workspacePath).toEndWith("/workspace");

    const stored = store.getAgentRuntime(first.id);
    expect(stored).toMatchObject({
      id: first.id,
      workspaceId: "T123",
      slackUserId: "U123",
      engine: "openclaw",
      endpointUrl: "http://openclaw-nemoclaw:8080"
    });
    expect(stored?.authTokenHash).not.toBe("runtime-token");

    store.close();
  });

  test("can stop a registered runtime without deleting its record", async () => {
    const store = createTokenStore(":memory:");
    const factory = createStaticRuntimeFactory({
      store,
      engine: "deterministic",
      endpointUrl: "http://runtime:8080",
      authToken: "runtime-token",
      dataRoot: "/data/runtimes"
    });

    const runtime = await factory.getOrCreateRuntime({
      workspaceId: "T123",
      slackUserId: "U123"
    });
    await factory.stopRuntime(runtime.id);

    expect(store.getAgentRuntime(runtime.id)).toMatchObject({
      id: runtime.id,
      status: "stopped",
      stoppedAt: expect.any(String)
    });

    store.close();
  });
});

describe("nativeAgentConfigFileName", () => {
  test("uses the selected runtime engine config shape", () => {
    expect(nativeAgentConfigFileName("openclaw")).toBe("openclaw.json");
    expect(nativeAgentConfigFileName("burble-direct")).toBe("openclaw.json");
    expect(nativeAgentConfigFileName("hermes")).toBe("hermes.json");
  });
});
