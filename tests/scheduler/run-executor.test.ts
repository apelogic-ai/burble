import { describe, expect, test } from "bun:test";
import { createTokenStore } from "../../src/db";
import { createSchedulerRunExecutor } from "../../src/scheduler/run-executor";
import type { AgentRunner } from "../../src/agent/types";

describe("scheduler run executor", () => {
  test("claims a queued run, executes the job prompt, delivers to the route, and marks success", async () => {
    const store = createTokenStore(":memory:");
    const route = store.upsertConversationRoute({
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destination: {
        channelId: "D123",
        isDirectMessage: true,
        rootId: "dm:D123"
      },
      now: new Date("2026-06-25T17:00:00.000Z")
    });
    const job = store.upsertScheduledJob({
      jobId: "job-ai-news",
      workspaceId: "T123",
      slackUserId: "U123",
      title: "Hourly AI news summary",
      prompt: "Find fresh AI news and summarize it.",
      schedule: { kind: "interval", every: { hours: 1 } },
      routeId: route.id,
      runtimeType: "openclaw",
      state: "scheduled",
      now: new Date("2026-06-25T17:01:00.000Z")
    });
    const run = store.createAgentJobRun({
      runId: "jobrun-ai-news",
      jobId: job.jobId,
      workspaceId: "T123",
      slackUserId: "U123",
      triggerSource: "manual",
      status: "queued",
      now: new Date("2026-06-25T17:02:00.000Z")
    });
    const runnerInputs: unknown[] = [];
    const runner: AgentRunner = {
      name: "test-runner",
      capabilities: {
        streaming: true,
        toolEvents: true,
        remote: true
      },
      async *run(input) {
        runnerInputs.push(input);
        yield {
          type: "final",
          response: {
            classification: "public",
            text: "AI news summary result."
          }
        };
      }
    };
    const posts: Array<{ channel: string; text: string; thread_ts?: string }> =
      [];
    const executor = createSchedulerRunExecutor({
      store,
      agentRunner: runner,
      slackClient: {
        chat: {
          postMessage: async (message) => {
            posts.push(message);
            return {};
          }
        }
      }
    });

    await executor.executeRun(run.runId);

    expect(runnerInputs).toHaveLength(1);
    expect(runnerInputs[0]).toMatchObject({
      principal: { workspaceId: "T123", slackUserId: "U123" },
      text: "Find fresh AI news and summarize it.",
      scheduledJob: {
        jobId: "job-ai-news",
        routeId: route.id,
        runtimeType: "openclaw"
      },
      conversation: {
        routeId: route.id,
        channelId: "D123",
        rootId: "dm:D123",
        isDirectMessage: true
      }
    });
    expect(posts).toEqual([
      {
        channel: "D123",
        text: "AI news summary result."
      }
    ]);
    expect(store.getAgentJobRun(run.runId)).toMatchObject({
      runId: run.runId,
      status: "succeeded"
    });

    store.close();
  });
});
