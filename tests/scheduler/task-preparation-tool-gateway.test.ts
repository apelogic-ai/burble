import { describe, expect, test } from "bun:test";
import type { Config } from "../../src/config";
import type { TokenStore } from "../../src/db";
import type { RuntimeFactory } from "../../src/agent/runtime-factory";
import { createToolGatewayScheduledTaskPreparationExecutor } from "../../src/scheduler/task-preparation-tool-gateway";

describe("tool-gateway scheduled task preparation", () => {
  test("executes generic preparation calls through the principal runtime gateway", async () => {
    const requests: Array<{ toolName: string; request: Request }> = [];
    const executor = createToolGatewayScheduledTaskPreparationExecutor({
      config: {} as Config,
      store: {} as TokenStore,
      runtimeFactory: runtimeFactory(),
      getSlackEmail: async () => "person@example.com",
      handleRequest: async (_config, _store, toolName, request) => {
        requests.push({ toolName, request });
        return Response.json({
          classification: "user_private",
          content: {
            mcpGw: true,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    documentId: "doc-123",
                    title: "AI news topic history",
                    webViewLink:
                      "https://docs.google.com/document/d/doc-123/edit",
                  }),
                },
              ],
            },
          },
        });
      },
    });

    const result = await executor({
      workspaceId: "T123",
      slackUserId: "U123",
      tool: "google_docs_create_document",
      input: { name: "AI news topic history" },
      purpose: "Track previously reported topics",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.toolName).toBe("google_docs_create_document");
    expect(requests[0]?.request.headers.get("authorization")).toBe(
      "Bearer runtime-token",
    );
    expect(requests[0]?.request.headers.get("x-burble-runtime-id")).toBe(
      "runtime-1",
    );
    await expect(requests[0]?.request.json()).resolves.toEqual({
      input: { name: "AI news topic history" },
    });
    expect(result).toEqual({
      value: {
        id: "doc-123",
        name: "AI news topic history",
        webViewLink: "https://docs.google.com/document/d/doc-123/edit",
      },
      stateRef: {
        provider: "google",
        kind: "google_docs_create_document",
        id: "doc-123",
        name: "AI news topic history",
        purpose: "Track previously reported topics",
      },
    });
  });

  test("fails preparation when the provider gateway returns an error result", async () => {
    const executor = createToolGatewayScheduledTaskPreparationExecutor({
      config: {} as Config,
      store: {} as TokenStore,
      runtimeFactory: runtimeFactory(),
      getSlackEmail: async () => "person@example.com",
      handleRequest: async () =>
        Response.json({
          classification: "user_private",
          content: {
            error: "google_not_connected",
            message: "Reconnect with /auth google.",
          },
        }),
    });

    await expect(
      executor({
        workspaceId: "T123",
        slackUserId: "U123",
        tool: "google_docs_create_document",
        input: { name: "State" },
      }),
    ).rejects.toThrow("Reconnect with /auth google");
  });
});

function runtimeFactory(): RuntimeFactory {
  return {
    getOrCreateRuntime: async () => ({
      id: "runtime-1",
      engine: "burble-native",
      endpointUrl: "http://runtime",
      authToken: "runtime-token",
      status: "ready",
      statePath: "/tmp/state",
      configPath: "/tmp/config",
      workspacePath: "/tmp/workspace",
    }),
    stopRuntime: async () => undefined,
    reapIdleRuntimes: async () => undefined,
  };
}
