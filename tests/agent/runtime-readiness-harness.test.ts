import { describe, expect, test } from "bun:test";
import { createTokenStore } from "../../src/db";
import { runRuntimeReadinessCheck } from "../../src/agent/runtime-readiness-harness";
import type { RuntimeFactory } from "../../src/agent/runtime-factory";

describe("runtime readiness harness", () => {
  test("checks managed runtime creation, health, capabilities, and stored ready state", async () => {
    const store = createTokenStore(":memory:");
    const principal = {
      workspaceId: "T123",
      slackUserId: "U123"
    };
    const runtime = store.getOrCreateAgentRuntime({
      ...principal,
      engine: "hermes",
      endpointUrl: "http://runtime.local",
      authTokenHash: "hash",
      statePath: "/data/state",
      configPath: "/data/config/hermes.json",
      workspacePath: "/data/workspace",
      policyHash: "policy"
    });
    store.recordAgentRuntimeEvent({
      runtimeId: runtime.id,
      eventType: "runtime_provision_requested",
      summary: { engine: "hermes" }
    });

    const factory: RuntimeFactory = {
      async getOrCreateRuntime() {
        return {
          id: runtime.id,
          engine: "hermes",
          endpointUrl: runtime.endpointUrl,
          authToken: "runtime-token",
          status: "ready",
          statePath: runtime.statePath,
          configPath: runtime.configPath,
          workspacePath: runtime.workspacePath
        };
      },
      async stopRuntime() {},
      async reapIdleRuntimes() {}
    };
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];

    await expect(
      runRuntimeReadinessCheck({
        engine: "hermes",
        principal,
        runtimeFactory: factory,
        store,
        fetch: async (url, init) => {
          requests.push({
            url,
            headers: Object.fromEntries(new Headers(init?.headers).entries())
          });
          if (url === "http://runtime.local/healthz") {
            return new Response("ok");
          }
          if (url === "http://runtime.local/capabilities") {
            return Response.json({
              runtimeType: "hermes",
              version: "1",
              transports: ["http", "websocket"],
              streaming: true,
              cancellation: false,
              nativeScheduler: true,
              scheduledProviderCalls: true,
              toolCalls: true,
              toolBridgeModes: ["tool_gateway"],
              usageReporting: "exact",
              multimodalInput: false,
              multimodalOutput: false,
              memory: false,
              durableWorkflowState: true,
              attachments: false,
              conversationSend: true,
              jobScopedAuth: true
            });
          }
          throw new Error(`unexpected fetch ${url}`);
        }
      })
    ).resolves.toEqual({
      engine: "hermes",
      runtimeId: runtime.id,
      endpointUrl: "http://runtime.local",
      signals: [
        { name: "runtime.created", status: "ok" },
        { name: "runtime.container_started", status: "ok" },
        { name: "runtime.healthz_ok", status: "ok" },
        { name: "runtime.capabilities_ok", status: "ok" },
        { name: "runtime.ready_recorded", status: "ok" }
      ]
    });
    expect(requests).toEqual([
      {
        url: "http://runtime.local/healthz",
        headers: {
          authorization: "Bearer runtime-token",
          "x-burble-runtime-id": runtime.id
        }
      },
      {
        url: "http://runtime.local/capabilities",
        headers: {
          authorization: "Bearer runtime-token",
          "x-burble-runtime-id": runtime.id
        }
      }
    ]);

    store.close();
  });

  test("fails when the runtime is not recorded ready", async () => {
    const store = createTokenStore(":memory:");
    const principal = {
      workspaceId: "T123",
      slackUserId: "U123"
    };
    const runtime = store.getOrCreateAgentRuntime({
      ...principal,
      engine: "hermes",
      endpointUrl: "http://runtime.local",
      authTokenHash: "hash",
      statePath: "/data/state",
      configPath: "/data/config/hermes.json",
      workspacePath: "/data/workspace",
      policyHash: "policy"
    });
    store.recordAgentRuntimeEvent({
      runtimeId: runtime.id,
      eventType: "runtime_provision_requested",
      summary: { engine: "hermes" }
    });
    store.updateAgentRuntimeStatus(runtime.id, { status: "failed" });

    const factory: RuntimeFactory = {
      async getOrCreateRuntime() {
        return {
          id: runtime.id,
          engine: "hermes",
          endpointUrl: runtime.endpointUrl,
          authToken: "runtime-token",
          status: "ready",
          statePath: runtime.statePath,
          configPath: runtime.configPath,
          workspacePath: runtime.workspacePath
        };
      },
      async stopRuntime() {},
      async reapIdleRuntimes() {}
    };

    await expect(
      runRuntimeReadinessCheck({
        engine: "hermes",
        principal,
        runtimeFactory: factory,
        store,
        fetch: async (url) => {
          if (url === "http://runtime.local/healthz") {
            return new Response("ok");
          }
          return Response.json({
            runtimeType: "hermes",
            version: "1",
            transports: ["http", "websocket"],
            streaming: true,
            cancellation: false,
            nativeScheduler: true,
            scheduledProviderCalls: true,
            toolCalls: true,
            toolBridgeModes: ["tool_gateway"],
            usageReporting: "exact",
            multimodalInput: false,
            multimodalOutput: false,
            memory: false,
            durableWorkflowState: true,
            attachments: false,
            conversationSend: true,
            jobScopedAuth: true
          });
        }
      })
    ).rejects.toThrow("Runtime readiness check failed: runtime.ready_recorded");

    store.close();
  });
});
