import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { Config } from "../../src/config";
import { handleConversation } from "../../src/conversation/orchestrator";
import type { ConversationDeps } from "../../src/conversation/types";
import { createTokenStore } from "../../src/db";
import { createSchedulerControlPlane } from "../../src/scheduler/control-plane";
import { handleToolGatewayRequest } from "../../src/tool-gateway";
import { createGitHubTools } from "../../src/tools/github";

const config = {
  internalApiToken: "internal-secret"
} as Config;

function hashRuntimeToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function runtimeRequest(
  toolName: string,
  body: unknown,
  runtimeId: string,
  runtimeToken: string
): Request {
  return new Request(`https://example.test/internal/tools/${toolName}/execute`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${runtimeToken}`,
      "x-burble-runtime-id": runtimeId
    },
    body: JSON.stringify(body)
  });
}

function schedulerConversationDeps(
  schedulerControl: ConversationDeps["schedulerControl"]
): ConversationDeps {
  return {
    createGitHubOAuthUrl: () => "https://github.example/oauth",
    getConnection: () => null,
    tools: {
      github: createGitHubTools({
        getGitHubUser: async () => ({ login: "octocat" }),
        listAssignedIssues: async () => [],
        searchIssues: async () => [],
        listMyPullRequests: async () => []
      })
    },
    agentMode: "llm",
    schedulerControl,
    agentRunner: {
      name: "throwing-test-runner",
      capabilities: {
        streaming: true,
        toolEvents: true,
        remote: false
      },
      async *run() {
        throw new Error("Scheduler control conformance path invoked the LLM");
      }
    }
  };
}

describe("scheduler control conformance", () => {
  test("runtime gateway triggers are visible to deterministic scheduler commands", async () => {
    const store = createTokenStore(":memory:");
    const runtimeToken = "runtime-token-u123";
    const runtime = store.getOrCreateAgentRuntime({
      workspaceId: "T123",
      slackUserId: "U123",
      engine: "openclaw",
      endpointUrl: "http://runtime-u123:8080",
      authTokenHash: hashRuntimeToken(runtimeToken),
      statePath: "/data/runtimes/u123/state",
      configPath: "/data/runtimes/u123/config/openclaw.json",
      workspacePath: "/data/runtimes/u123/workspace",
      policyHash: "policy-hash"
    });
    store.upsertScheduledJob({
      jobId: "ai-news-hourly",
      workspaceId: "T123",
      slackUserId: "U123",
      title: "Hourly AI news summary",
      prompt: "Find fresh AI news and summarize it.",
      schedule: { kind: "interval", every: { hours: 1 } },
      routeId: "convrt_abcdefabcdefabcdefabcdef",
      runtimeType: "openclaw",
      now: new Date("2026-06-24T12:00:00.000Z")
    });

    const schedulerControl = createSchedulerControlPlane(store);
    const deps = schedulerConversationDeps(schedulerControl);
    const listResponse = await handleConversation(
      {
        source: "slack",
        workspaceId: "T123",
        channelId: "D123",
        messageTs: "1710000000.000100",
        isDirectMessage: true,
        user: {
          slackUserId: "U123",
          email: "person@example.com"
        },
        text: "do we have any cron jobs configured?"
      },
      deps
    );

    expect(listResponse.text).toContain("ai-news-hourly");

    const triggerResponse = await handleToolGatewayRequest(
      config,
      store,
      "scheduledJob.trigger",
      runtimeRequest("scheduledJob.trigger", {
        input: { jobId: "ai-news-hourly" }
      }, runtime.id, runtimeToken)
    );

    expect(triggerResponse.status).toBe(200);
    const triggerBody = await triggerResponse.json();
    expect(triggerBody.content).toMatchObject({
      ok: true,
      jobId: "ai-news-hourly",
      run: {
        jobId: "ai-news-hourly",
        workspaceId: "T123",
        slackUserId: "U123",
        triggerSource: "manual",
        status: "queued"
      }
    });

    const statusResponse = await handleConversation(
      {
        source: "slack",
        workspaceId: "T123",
        channelId: "D123",
        messageTs: "1710000000.000200",
        isDirectMessage: true,
        user: {
          slackUserId: "U123",
          email: "person@example.com"
        },
        text: "did the manual cron job run finish?"
      },
      deps
    );

    expect(statusResponse.text).toContain("Latest scheduled job run");
    expect(statusResponse.text).toContain("ai-news-hourly");
    expect(statusResponse.text).toContain("status: queued");

    store.close();
  });

  test("runtime-created scheduler jobs are controlled by deterministic commands", async () => {
    const store = createTokenStore(":memory:");
    const runtimeToken = "runtime-token-u123";
    const runtime = store.getOrCreateAgentRuntime({
      workspaceId: "T123",
      slackUserId: "U123",
      engine: "hermes",
      endpointUrl: "http://runtime-u123:8080",
      authTokenHash: hashRuntimeToken(runtimeToken),
      statePath: "/data/runtimes/u123/state",
      configPath: "/data/runtimes/u123/config/hermes.json",
      workspacePath: "/data/runtimes/u123/workspace",
      policyHash: "policy-hash"
    });

    const createResponse = await handleToolGatewayRequest(
      config,
      store,
      "scheduledJob.create",
      runtimeRequest("scheduledJob.create", {
        input: {
          title: "Hourly AI news summary",
          prompt: "Find fresh AI-related news and summarize it.",
          schedule: { kind: "interval", every: { hours: 1 } }
        }
      }, runtime.id, runtimeToken)
    );
    expect(createResponse.status).toBe(200);
    const createBody = await createResponse.json();
    const jobId = createBody.content.job.jobId;
    expect(jobId).toStartWith("job_");

    const schedulerControl = createSchedulerControlPlane(store);
    const deps = schedulerConversationDeps(schedulerControl);
    const listResponse = await handleConversation(
      {
        source: "slack",
        workspaceId: "T123",
        channelId: "D123",
        messageTs: "1710000000.000300",
        isDirectMessage: true,
        user: {
          slackUserId: "U123",
          email: "person@example.com"
        },
        text: "do we have any cron jobs configured?"
      },
      deps
    );

    expect(listResponse.text).toContain("Hourly AI news summary");
    expect(listResponse.text).toContain("state: scheduled");

    const pauseResponse = await handleToolGatewayRequest(
      config,
      store,
      "scheduledJob.pause",
      runtimeRequest("scheduledJob.pause", {
        input: { jobId }
      }, runtime.id, runtimeToken)
    );
    expect(pauseResponse.status).toBe(200);
    expect(await pauseResponse.json()).toMatchObject({
      content: {
        ok: true,
        job: {
          jobId,
          state: "paused"
        }
      }
    });

    const pausedListResponse = await handleConversation(
      {
        source: "slack",
        workspaceId: "T123",
        channelId: "D123",
        messageTs: "1710000000.000400",
        isDirectMessage: true,
        user: {
          slackUserId: "U123",
          email: "person@example.com"
        },
        text: "show my cron jobs"
      },
      deps
    );
    expect(pausedListResponse.text).toContain("state: paused");

    const deleteResponse = await handleToolGatewayRequest(
      config,
      store,
      "scheduledJob.delete",
      runtimeRequest("scheduledJob.delete", {
        input: { jobId }
      }, runtime.id, runtimeToken)
    );
    expect(deleteResponse.status).toBe(200);
    expect(await deleteResponse.json()).toMatchObject({
      content: {
        ok: true,
        jobId
      }
    });

    const finalListResponse = await handleConversation(
      {
        source: "slack",
        workspaceId: "T123",
        channelId: "D123",
        messageTs: "1710000000.000500",
        isDirectMessage: true,
        user: {
          slackUserId: "U123",
          email: "person@example.com"
        },
        text: "show my cron jobs"
      },
      deps
    );
    expect(finalListResponse.text).toBe("No scheduled tasks are configured.");

    store.close();
  });
});
