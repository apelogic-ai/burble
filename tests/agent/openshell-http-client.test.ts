import { describe, expect, test } from "bun:test";
import { createOpenShellSandboxProvider } from "../../src/agent/sandbox-providers/openshell";
import { createOpenShellHttpSandboxClient } from "../../src/agent/sandbox-providers/openshell-http-client";

describe("OpenShell HTTP sandbox client", () => {
  test("maps sandbox operations to the OpenShell HTTP boundary", async () => {
    const requests: Array<{
      url: string;
      method: string;
      authorization: string | null;
      body: unknown;
    }> = [];
    const fetch = async (
      input: string,
      init?: RequestInit
    ): Promise<Response> => {
      const headers = new Headers(init?.headers);
      const method = init?.method ?? "GET";
      const body =
        typeof init?.body === "string" && init.body
          ? JSON.parse(init.body)
          : null;
      const bodyRecord = body as Record<string, unknown>;
      requests.push({
        url: input,
        method,
        authorization: headers.get("authorization"),
        body
      });

      if (input.endsWith("/sandboxes") && method === "POST") {
        return jsonResponse({
          sandboxId: "osb-1",
          endpoint: "http://osb-1.local:8080",
          workspacePath: "/openshell/osb-1/workspace",
          status: "ready",
          principal: bodyRecord.principal,
          runtime: bodyRecord.runtime,
          labels: bodyRecord.labels,
          credentials: []
        });
      }
      if (input.endsWith("/policy") && method === "POST") {
        return jsonResponse({ ok: true });
      }
      if (input.endsWith("/credentials") && method === "POST") {
        return jsonResponse({ ok: true });
      }
      if (input.endsWith("/runs") && method === "POST") {
        return jsonResponse({
          runId: "run-1",
          status: "finished",
          exitCode: 0
        });
      }
      if (input.endsWith("/events") && method === "GET") {
        return new Response(
          [
            ":keep-alive",
            "event: run_started",
            "id: 1",
            `data: ${JSON.stringify({
              sandboxId: "osb-1",
              type: "run_started",
              at: "2026-06-19T00:00:00.000Z",
              detail: { argv: ["bun", "src/index.ts"] }
            })}`,
            "retry: 1000",
            `data: ${JSON.stringify({
              sandboxId: "osb-1",
              type: "run_finished",
              at: "2026-06-19T00:00:01.000Z",
              detail: { exitCode: 0 }
            })}`
          ].join("\n"),
          { headers: { "content-type": "application/x-ndjson" } }
        );
      }
      if (input.endsWith("/sandboxes/osb-1") && method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      if (input.endsWith("/sandboxes/osb-1") && method === "GET") {
        return jsonResponse({
          id: "osb-1",
          endpointUrl: "http://osb-1.local:8080",
          workspacePath: "/openshell/osb-1/workspace",
          status: "ready",
          principal: { workspaceId: "T123", userId: "U123" },
          runtime: { engine: "hermes", image: "burble-runtime:dev" },
          labels: { runtimeDataId: "runtime-data" },
          credentials: []
        });
      }

      return jsonResponse({ error: "unexpected request" }, 404);
    };

    const provider = createOpenShellSandboxProvider({
      client: createOpenShellHttpSandboxClient({
        baseUrl: "https://openshell.example.test/",
        token: "openshell-token",
        fetch
      })
    });

    const sandbox = await provider.provision({
      principal: { workspaceId: "T123", userId: "U123" },
      runtime: { engine: "hermes", image: "burble-runtime:dev" },
      labels: { runtimeDataId: "runtime-data" }
    });
    await provider.applyPolicy(sandbox.id, {
      network: {
        egress: "allowlist",
        allowedHosts: ["burble-app:3000", "api.openai.com"]
      }
    });
    await provider.bindCredentials(sandbox.id, [
      {
        name: "github",
        kind: "provider-token",
        ref: "provider:github:T123:U123",
        delivery: "gateway_callback"
      },
      {
        name: "runtime-config",
        kind: "secret-ref",
        ref: "secret:runtime-config",
        delivery: "sandbox_reference"
      }
    ]);
    await provider.run(sandbox.id, { argv: ["bun", "src/index.ts"] });
    await provider.attach(sandbox.id);
    const events = [];
    for await (const event of provider.streamEvents(sandbox.id)) {
      events.push(event.type);
    }
    await provider.terminate(sandbox.id);

    expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
      "POST https://openshell.example.test/sandboxes",
      "POST https://openshell.example.test/sandboxes/osb-1/policy",
      "GET https://openshell.example.test/sandboxes/osb-1",
      "POST https://openshell.example.test/sandboxes/osb-1/credentials",
      "GET https://openshell.example.test/sandboxes/osb-1",
      "POST https://openshell.example.test/sandboxes/osb-1/runs",
      "GET https://openshell.example.test/sandboxes/osb-1",
      "GET https://openshell.example.test/sandboxes/osb-1/events",
      "DELETE https://openshell.example.test/sandboxes/osb-1"
    ]);
    expect(
      requests.every(
        (request) => request.authorization === "Bearer openshell-token"
      )
    ).toBe(true);
    expect(requests[1]?.body).toMatchObject({
      compiledPolicy: {
        egress: {
          default: "deny",
          allowHosts: ["api.openai.com", "burble-app:3000"]
        }
      }
    });
    expect(requests[3]?.body).toMatchObject({
      materializedCredentials: [
        {
          name: "runtime-config",
          ref: "secret:runtime-config",
          delivery: "sandbox_reference"
        }
      ]
    });
    expect(
      JSON.stringify(
        (requests[3]?.body as { materializedCredentials?: unknown })
          .materializedCredentials
      )
    ).not.toContain("provider:github:T123:U123");
    expect(JSON.stringify(requests[3]?.body)).toContain(
      "provider:github:T123:U123"
    );
    expect(events).toEqual(["run_started", "run_finished"]);
  });

  test("times out hung OpenShell requests", async () => {
    const client = createOpenShellHttpSandboxClient({
      baseUrl: "https://openshell.example.test",
      requestTimeoutMs: 1,
      fetch: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        })
    });

    await expect(client.getSandbox({ sandboxId: "osb-1" })).rejects.toThrow(
      "OpenShell request GET /sandboxes/osb-1 timed out after 1ms"
    );
  });

  test("does not attach the unary timeout signal to event streams", async () => {
    let eventRequestSignal: AbortSignal | undefined;
    const client = createOpenShellHttpSandboxClient({
      baseUrl: "https://openshell.example.test",
      requestTimeoutMs: 1,
      fetch: async (_input, init) => {
        eventRequestSignal = init?.signal ?? undefined;
        return new Response(
          `data: ${JSON.stringify({
            sandboxId: "osb-1",
            type: "run_started",
            at: "2026-06-19T00:00:00.000Z"
          })}\n`,
          { headers: { "content-type": "text/event-stream" } }
        );
      }
    });

    const events = [];
    for await (const event of client.events({ sandboxId: "osb-1" })) {
      events.push(event.type);
    }

    expect(eventRequestSignal).toBeUndefined();
    expect(events).toEqual(["run_started"]);
  });
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}
