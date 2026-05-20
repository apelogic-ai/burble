import { describe, expect, test } from "bun:test";
import { handleRuntimeRequest } from "../../../runtimes/openclaw-nemoclaw/src/server";
import type { RuntimeConfig } from "../../../runtimes/openclaw-nemoclaw/src/config";

const config: RuntimeConfig = {
  port: 8080,
  toolGatewayUrl: "http://burble-app:3000/internal/tools",
  internalToken: "secret",
  engine: "deterministic",
  openClawCommand: "openclaw",
  openClawAgent: "main",
  openClawTimeoutMs: 60000
};

describe("handleRuntimeRequest", () => {
  test("serves health checks", async () => {
    const response = await handleRuntimeRequest(
      new Request("http://runtime/healthz"),
      config
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  test("handles run requests", async () => {
    const response = await handleRuntimeRequest(
      new Request("http://runtime/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input: {
            text: "who am I on GitHub?",
            connections: {
              github: {
                connected: true,
                email: "person@example.com"
              }
            }
          }
        })
      }),
      config,
      async () => ({
        classification: "user_private",
        content: { login: "octocat" }
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      response: {
        classification: "user_private",
        text: "Authenticated to GitHub as `octocat`."
      }
    });
  });

  test("rejects malformed run requests", async () => {
    const response = await handleRuntimeRequest(
      new Request("http://runtime/runs", {
        method: "POST",
        body: JSON.stringify({ input: { text: "" } })
      }),
      config
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Invalid run request");
  });
});
