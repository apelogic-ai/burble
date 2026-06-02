import { describe, expect, test } from "bun:test";
import { createConfiguredAgentRunner } from "../../src/agent/runtime";
import type { DirectLanguageModel } from "../../src/agent/providers";
import { createGitHubTools } from "../../src/tools/github";

const githubTools = createGitHubTools({
  getGitHubUser: async () => ({ login: "octocat" }),
  listAssignedIssues: async () => [],
  searchIssues: async () => [],
  listMyPullRequests: async () => []
});

describe("createConfiguredAgentRunner", () => {
  test("selects the AI SDK runner by default", () => {
    const runner = createConfiguredAgentRunner({
      runtime: "ai-sdk",
      model: "openai:test-model",
      githubTools,
      resolveModel: () =>
        ({ provider: "test", modelId: "model" }) as DirectLanguageModel
    });

    expect(runner.name).toBe("ai-sdk");
    expect(runner.capabilities).toMatchObject({
      remote: false,
      toolEvents: true
    });
  });

  test("selects the managed runtime runner when configured", () => {
    const runner = createConfiguredAgentRunner({
      runtime: "burble-runtime",
      model: "openai:test-model",
      githubTools,
      managedRuntimeUrl: "http://managed-runtime:8080"
    });

    expect(runner.name).toBe("burble-runtime");
    expect(runner.capabilities).toMatchObject({
      remote: true,
      requiresToolGateway: true
    });
  });

  test("keeps the legacy OpenClaw/NemoClaw URL dependency as an alias", () => {
    const runner = createConfiguredAgentRunner({
      runtime: "burble-runtime",
      model: "openai:test-model",
      githubTools,
      openClawNemoClawUrl: "http://openclaw-runtime:8080"
    });

    expect(runner.name).toBe("burble-runtime");
  });

  test("selects the managed runtime runner with a runtime factory", () => {
    const runner = createConfiguredAgentRunner({
      runtime: "burble-runtime",
      model: "openai:test-model",
      githubTools,
      runtimeFactory: {
        async getOrCreateRuntime() {
          throw new Error("not called during construction");
        },
        async stopRuntime() {},
        async reapIdleRuntimes() {}
      }
    });

    expect(runner.name).toBe("burble-runtime");
  });

  test("requires a runtime URL for managed runtimes", () => {
    expect(() =>
      createConfiguredAgentRunner({
        runtime: "burble-runtime",
        model: "openai:test-model",
        githubTools
      })
    ).toThrow("managed runtime URL is required");
  });
});
