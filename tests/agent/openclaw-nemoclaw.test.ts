import { describe, expect, test } from "bun:test";
import { createOpenClawNemoClawAgentRunner } from "../../src/agent/runners/openclaw-nemoclaw";
import { collectAgentRun } from "../../src/agent/types";
import type { ProviderConnection } from "../../src/db";
import type { ObservabilityEventInput } from "../../src/observability";

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

function sseEvent(event: unknown): string {
  const type =
    typeof event === "object" && event !== null && "type" in event
      ? String(event.type)
      : "message";
  return `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
}

class FakeRuntimeWebSocket {
  readonly listeners = {
    message: [] as Array<(event: { data?: unknown }) => void>,
    error: [] as Array<(event: { data?: unknown }) => void>,
    close: [] as Array<(event: { data?: unknown }) => void>
  };
  closed = false;

  constructor(readonly url: string) {}

  addEventListener(
    type: "message" | "error" | "close",
    listener: (event: { data?: unknown }) => void
  ): void {
    this.listeners[type].push(listener);
  }

  sendEvent(event: unknown): void {
    for (const listener of this.listeners.message) {
      listener({ data: JSON.stringify(event) });
    }
  }

  closeFromRuntime(): void {
    for (const listener of this.listeners.close) {
      listener({});
    }
  }

  close(): void {
    this.closed = true;
  }
}

async function waitForSocket(
  sockets: FakeRuntimeWebSocket[]
): Promise<FakeRuntimeWebSocket> {
  for (let index = 0; index < 20; index += 1) {
    if (sockets[0]) {
      return sockets[0];
    }
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for fake runtime WebSocket");
}

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
      executionMode: "openclaw-native",
      conversation,
      text: "summarize my GitHub work",
      attachments: [
        {
          id: "slack:F123",
          externalId: "F123",
          source: "slack",
          kind: "image",
          mimeType: "image/png",
          name: "screenshot.png",
          sizeBytes: 2048
        }
      ],
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
      accept: "application/json",
      "content-type": "application/json",
      prefer: "respond-async"
    });

    const body = JSON.parse(String(requests[0].init.body));
    expect(body).toMatchObject({
      principal,
      executionMode: "openclaw-native",
      input: {
        text: "summarize my GitHub work",
        attachments: [
          {
            id: "slack:F123",
            externalId: "F123",
            source: "slack",
            kind: "image",
            mimeType: "image/png",
            name: "screenshot.png",
            sizeBytes: 2048
          }
        ],
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
      accept: "application/json",
      "content-type": "application/json",
      prefer: "respond-async",
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
          githubConnected: true,
          googleConnected: false,
          jiraConnected: false,
          slackConnected: false
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

  test("emits observability events for remote runtime calls", async () => {
    const observabilityEvents: ObservabilityEventInput[] = [];
    const runner = createOpenClawNemoClawAgentRunner({
      runtimeFactory: {
        async getOrCreateRuntime() {
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
        recordRuntimeEvent() {}
      },
      observability: {
        emit: (event) => {
          observabilityEvents.push(event);
        }
      },
      fetch: async () =>
        Response.json({
          response: {
            classification: "user_private",
            text: "Runtime answer.",
            usage: {
              inputTokens: 12,
              outputTokens: 4,
              totalTokens: 16
            },
            telemetry: {
              promptChars: 4096,
              promptApproxTokens: 1024,
              steps: [
                {
                  step: 1,
                  usageSource: "provider-output"
                }
              ]
            }
          }
        })
    });

    const result = await collectAgentRun(runner, {
      principal,
      conversation,
      text: "summarize my GitHub work",
      connections: { github: connection }
    });

    expect(result.text).toBe("Runtime answer.");
    expect(observabilityEvents.map((event) => event.name)).toEqual([
      "runtime.run.started",
      "runtime.run.accepted",
      "runtime.run.completed"
    ]);
    expect(observabilityEvents[0]).toMatchObject({
      workspaceId: "T123",
      principalId: "T123:U123",
      runtimeId: "rt_u123",
      runtimeType: "openclaw",
      attributes: {
        conversationRoot: "dm:D123",
        textLength: 24,
        githubConnected: true
      }
    });
    expect(observabilityEvents[1]).toMatchObject({
      runtimeId: "rt_u123",
      runtimeType: "openclaw",
      status: "ok",
      attributes: {
        httpStatus: 200
      }
    });
    expect(observabilityEvents[2]).toMatchObject({
      runtimeId: "rt_u123",
      runtimeType: "openclaw",
      classification: "user_private",
      status: "ok",
      usage: {
        inputTokens: 12,
        outputTokens: 4,
        totalTokens: 16
      },
      attributes: {
        telemetry: {
          promptChars: 4096,
          promptApproxTokens: 1024,
          steps: [
            {
              step: 1,
              usageSource: "provider-output"
            }
          ]
        }
      }
    });
    expect(
      new Set(observabilityEvents.map((event) => event.runId)).size
    ).toBe(1);
    expect(JSON.stringify(observabilityEvents)).not.toContain("runtime-token");
    expect(JSON.stringify(observabilityEvents)).not.toContain("secret-token");
  });

  test("streams remote runtime events over WebSocket before returning the final response", async () => {
    const sockets: FakeRuntimeWebSocket[] = [];
    const runner = createOpenClawNemoClawAgentRunner({
      baseUrl: "http://openclaw-runtime:8080",
      fetch: async () =>
        Response.json({
          runId: "run-1",
          eventsUrl: "/runs/run-1/events"
        }),
      webSocketFactory: (url) => {
        const socket = new FakeRuntimeWebSocket(url);
        sockets.push(socket);
        return socket;
      }
    });
    const events: string[] = [];

    const resultPromise = collectAgentRun(
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
    const socket = await waitForSocket(sockets);

    expect(socket.url).toBe("ws://openclaw-runtime:8080/runs/run-1/events");
    socket.sendEvent({ type: "status", text: "Loading context..." });
    socket.sendEvent({
      type: "tool_call",
      toolName: "jira.searchIssues",
      callId: "call-1"
    });
    socket.sendEvent({
      type: "tool_result",
      toolName: "jira.searchIssues",
      callId: "call-1",
      classification: "user_private"
    });
    socket.sendEvent({ type: "message_delta", text: "Partial answer" });
    socket.sendEvent({
      type: "final",
      response: {
        classification: "user_private",
        text: "Final answer"
      }
    });

    const result = await resultPromise;

    expect(events).toEqual([
      "status:Starting agent runtime...",
      "status:Agent is thinking...",
      "status:Loading context...",
      "tool_call:",
      "tool_result:",
      "message_delta:Partial answer"
    ]);
    expect(result).toEqual({
      classification: "user_private",
      text: "Final answer"
    });
  });

  test("falls back to the run snapshot when the runtime event socket closes before final", async () => {
    const requests: Array<{
      url: string;
      method: string;
      body?: { runId?: string };
    }> = [];
    const sockets: FakeRuntimeWebSocket[] = [];
    const runner = createOpenClawNemoClawAgentRunner({
      baseUrl: "http://openclaw-runtime:8080",
      fetch: async (url, init) => {
        const headers = init.headers as Record<string, string>;
        requests.push({
          url,
          method: init.method ?? "GET",
          ...(init.body
            ? { body: JSON.parse(String(init.body)) as { runId?: string } }
            : {})
        });

        if (init.method === "POST") {
          return Response.json({
            runId: "run-closed",
            eventsUrl: "/runs/run-closed/events"
          });
        }

        return Response.json({
          response: {
            classification: "user_private",
            text: "Final answer from JSON fallback."
          }
        });
      },
      webSocketFactory: (url) => {
        const socket = new FakeRuntimeWebSocket(url);
        sockets.push(socket);
        return socket;
      }
    });
    const events: string[] = [];

    const resultPromise = collectAgentRun(
      runner,
      {
        principal,
        conversation,
        text: "which jira tickets mention onboarding?",
        connections: { github: connection }
      },
      (event) => {
        events.push(`${event.type}:${"text" in event ? event.text : ""}`);
      }
    );
    const socket = await waitForSocket(sockets);
    socket.sendEvent({
      type: "status",
      text: "Agent is thinking..."
    });
    socket.closeFromRuntime();

    const result = await resultPromise;

    expect(events).not.toContain(
      "status:Runtime stream closed; fetching final answer..."
    );
    expect(result).toEqual({
      classification: "user_private",
      text: "Final answer from JSON fallback."
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      url: "http://openclaw-runtime:8080/runs",
      method: "POST"
    });
    expect(requests[1]).toMatchObject({
      url: "http://openclaw-runtime:8080/runs/run-closed",
      method: "GET"
    });
    expect(requests[0].body?.runId).toBeString();
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
