import { describe, expect, test } from "bun:test";
import { createBurbleToolExecutor } from "../../../runtimes/openclaw-nemoclaw/src/burble-tools";
import type { RuntimeConfig } from "../../../runtimes/openclaw-nemoclaw/src/config";

const config: RuntimeConfig = {
  port: 8080,
  toolGatewayUrl: "http://burble-app:3000/internal/tools",
  internalToken: "runtime-secret",
  engine: "deterministic",
  openClawCommand: "openclaw",
  openClawAgent: "main",
  openClawTimeoutMs: 60000,
  openClawStateDir: "/data/openclaw/state",
  openClawConfigPath: "/data/openclaw/config/openclaw.json",
  openClawWorkspaceDir: "/data/openclaw/workspace",
  openClawSetupOnStart: true,
  openClawConfigPatchPath: null,
  openClawValidateOnStart: true
};

describe("createBurbleToolExecutor", () => {
  test("sends the runtime id header when provided", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Request[] = [];
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json({
        classification: "user_private",
        content: { login: "octocat" }
      });
    }) as typeof fetch;

    try {
      const executor = createBurbleToolExecutor(config, "rt_u123");
      const result = await executor("github.getAuthenticatedUser", {
        user: { email: "person@example.com" }
      });

      expect(result.content).toEqual({ login: "octocat" });
      expect(requests[0].url).toBe(
        "http://burble-app:3000/internal/tools/github.getAuthenticatedUser/execute"
      );
      expect(requests[0].headers.get("authorization")).toBe(
        "Bearer runtime-secret"
      );
      expect(requests[0].headers.get("x-burble-runtime-id")).toBe("rt_u123");
      expect(await requests[0].json()).toEqual({
        user: { email: "person@example.com" }
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
