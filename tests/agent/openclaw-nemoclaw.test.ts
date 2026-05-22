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

const principal = {
  workspaceId: "T123",
  slackUserId: "U123"
};

const conversation = {
  source: "slack" as const,
  workspaceId: "T123",
  channelId: "D123",
  rootId: "dm:D123",
  isDirectMessage: true
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
      principal,
      conversation,
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
      accept: "application/x-ndjson, application/json",
      "content-type": "application/json"
    });

    const body = JSON.parse(String(requests[0].init.body));
    expect(body).toMatchObject({
      input: {
        text: "summarize my GitHub work",
        conversation,
        connections: {
          github: {
            connected: true,
            email: "person@example.com",
            providerLogin: "octocat"
          }
        }
      }
    });
    expect(body.runId).toBeString();
    expect(JSON.stringify(body)).not.toContain("secret-token");
  });

  test("routes requests through a principal-scoped runtime factory", async () => {
    const principals: unknown[] = [];
    const runtimeEvents: unknown[] = [];
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const runner = createOpenClawNemoClawAgentRunner({
      runtimeFactory: {
        async getOrCreateRuntime(runtimePrincipal) {
          principals.push(runtimePrincipal);
          return {
            id: "rt_u123",
            engine: "openclaw",
            endpointUrl: "http://runtime-u123:8080/",
            authToken: "runtime-token",
            status: "ready",
            statePath: "/data/runtimes/rt_u123/state",
            configPath: "/data/runtimes/rt_u123/config/openclaw.json",
            workspacePath: "/data/runtimes/rt_u123/workspace"
          };
        },
        async stopRuntime() {},
        async reapIdleRuntimes() {},
        recordRuntimeEvent(runtimeId, event) {
          runtimeEvents.push({ runtimeId, ...event });
        }
      },
      fetch: async (url, init) => {
        requests.push({ url: String(url), init: init ?? {} });
        return Response.json({
          response: {
            classification: "user_private",
            text: "Runtime answer."
          }
        });
      }
    });

    const result = await collectAgentRun(runner, {
      principal,
      conversation,
      text: "summarize my GitHub work",
      connections: { github: connection }
    });

    expect(result.text).toBe("Runtime answer.");
    expect(principals).toEqual([principal]);
    expect(requests[0].url).toBe("http://runtime-u123:8080/runs");
    expect(requests[0].init.headers).toEqual({
      accept: "application/x-ndjson, application/json",
      "content-type": "application/json",
      "x-burble-runtime-id": "rt_u123"
    });
    expect(JSON.parse(String(requests[0].init.body))).toMatchObject({
      runtime: {
        id: "rt_u123",
        engine: "openclaw",
        status: "ready"
      }
    });
    expect(String(requests[0].init.body)).not.toContain("runtime-token");
    expect(runtimeEvents).toEqual([
      {
        runtimeId: "rt_u123",
        eventType: "runtime_run_started",
        summary: {
          conversationRoot: "dm:D123",
          textLength: 24,
          githubConnected: true
        }
      },
      {
        runtimeId: "rt_u123",
        eventType: "runtime_run_finished",
        summary: {
          classification: "user_private",
          textLength: 15
        }
      }
    ]);
  });

  test("streams remote runtime events before returning the final response", async () => {
    const runner = createOpenClawNemoClawAgentRunner({
      baseUrl: "http://openclaw-runtime:8080",
      fetch: async () =>
        new Response(
          [
            JSON.stringify({ type: "status", text: "Loading context..." }),
            JSON.stringify({ type: "message_delta", text: "Partial answer" }),
            JSON.stringify({
              type: "final",
              response: {
                classification: "user_private",
                text: "Final answer"
              }
            })
          ].join("\n"),
          {
            status: 200,
            headers: { "content-type": "application/x-ndjson; charset=utf-8" }
          }
        )
    });
    const events: string[] = [];

    const result = await collectAgentRun(
      runner,
      {
        principal,
        conversation,
        text: "summarize my GitHub work",
        connections: { github: connection }
      },
      (event) => {
        events.push(`${event.type}:${"text" in event ? event.text : ""}`);
      }
    );

    expect(events).toEqual([
      "status:Preparing your OpenClaw/NemoClaw runtime...",
      "status:Running OpenClaw/NemoClaw...",
      "status:Loading context...",
      "message_delta:Partial answer"
    ]);
    expect(result).toEqual({
      classification: "user_private",
      text: "Final answer"
    });
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
        principal,
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
        principal,
        text: "hello",
        connections: { github: null }
      })
    ).rejects.toThrow("OpenClaw/NemoClaw runtime returned an invalid response");
  });
});
