import { describe, expect, test } from "bun:test";
import { createOpenClawNemoClawAgentRunner } from "../../src/agent/runners/openclaw-nemoclaw";
import { collectAgentRun } from "../../src/agent/types";
import type { ProviderConnection } from "../../src/db";

const connection: ProviderConnection = {
  provider: "github",
  email: "person@example.com",
  slackUserId: "U123",
  providerLogin: "octocat",
  accessToken: "secret-token",
  connectedAt: "2026-05-19T00:00:00Z"
};

describe("createOpenClawNemoClawAgentRunner", () => {
  test("posts a sanitized run request to the remote runtime", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const runner = createOpenClawNemoClawAgentRunner({
      baseUrl: "http://openclaw-runtime:8080/",
      fetch: async (url, init) => {
        requests.push({ url: String(url), init: init ?? {} });

        return new Response(
          JSON.stringify({
            response: {
              classification: "user_private",
              text: "You have one issue."
            }
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }
    });

    const result = await collectAgentRun(runner, {
      text: "summarize my GitHub work",
      connections: { github: connection }
    });

    expect(result).toEqual({
      classification: "user_private",
      text: "You have one issue."
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("http://openclaw-runtime:8080/runs");
    expect(requests[0].init.method).toBe("POST");
    expect(requests[0].init.headers).toEqual({
      "content-type": "application/json"
    });

    const body = JSON.parse(String(requests[0].init.body));
    expect(body).toEqual({
      input: {
        text: "summarize my GitHub work",
        connections: {
          github: {
            connected: true,
            email: "person@example.com",
            providerLogin: "octocat"
          }
        }
      }
    });
    expect(JSON.stringify(body)).not.toContain("secret-token");
  });

  test("reports remote runtime failures without leaking response bodies", async () => {
    const runner = createOpenClawNemoClawAgentRunner({
      baseUrl: "http://openclaw-runtime:8080",
      fetch: async () =>
        new Response("token secret leaked by remote", {
          status: 500
        })
    });

    await expect(
      collectAgentRun(runner, {
        text: "hello",
        connections: { github: null }
      })
    ).rejects.toThrow("OpenClaw/NemoClaw runtime returned HTTP 500");
  });

  test("rejects malformed remote runtime responses", async () => {
    const runner = createOpenClawNemoClawAgentRunner({
      baseUrl: "http://openclaw-runtime:8080",
      fetch: async () =>
        Response.json({
          response: {
            classification: "everyone_can_see_this",
            text: "bad"
          }
        })
    });

    await expect(
      collectAgentRun(runner, {
        text: "hello",
        connections: { github: null }
      })
    ).rejects.toThrow("OpenClaw/NemoClaw runtime returned an invalid response");
  });
});
