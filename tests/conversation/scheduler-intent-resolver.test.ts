import { describe, expect, test } from "bun:test";
import {
  createLlmSchedulerIntentResolver,
  parseSchedulerIntentResponse,
} from "../../src/conversation/scheduler-intent-resolver";

describe("scheduler intent resolver", () => {
  test("parses strict JSON scheduler intent responses", () => {
    expect(
      parseSchedulerIntentResponse(
        '{"intent":"trigger_job","confidence":0.91,"jobId":"job_123"}',
      ),
    ).toEqual({
      intent: "trigger_job",
      confidence: 0.91,
      jobId: "job_123",
    });
  });

  test("extracts fenced JSON and clamps confidence", () => {
    expect(
      parseSchedulerIntentResponse(
        '```json\n{"intent":"list_jobs","confidence":3,"jobId":null}\n```',
      ),
    ).toEqual({
      intent: "list_jobs",
      confidence: 1,
      jobId: null,
    });
  });

  test("parses job-run list intents", () => {
    expect(
      parseSchedulerIntentResponse(
        '{"intent":"list_job_runs","confidence":0.86,"jobId":null}',
      ),
    ).toEqual({
      intent: "list_job_runs",
      confidence: 0.86,
      jobId: null,
    });
  });

  test("parses task creation intents", () => {
    expect(
      parseSchedulerIntentResponse(
        '{"intent":"create_job","confidence":0.9,"jobId":null,"create":{"title":"Heart emoji every 30 min","prompt":"Post exactly this message: ❤️","schedule":{"kind":"cron","expression":"*/30 * * * *","timezone":"UTC"}}}',
      ),
    ).toEqual({
      intent: "create_job",
      confidence: 0.9,
      jobId: null,
      create: {
        title: "Heart emoji every 30 min",
        prompt: "Post exactly this message: ❤️",
        schedule: {
          kind: "cron",
          expression: "*/30 * * * *",
          timezone: "UTC",
        },
      },
    });
  });

  test("parses delivery update intents", () => {
    expect(
      parseSchedulerIntentResponse(
        '{"intent":"update_job_delivery","confidence":0.88,"jobId":"job_ai_news"}',
      ),
    ).toEqual({
      intent: "update_job_delivery",
      confidence: 0.88,
      jobId: "job_ai_news",
    });
  });

  test("parses schedule update intents", () => {
    expect(
      parseSchedulerIntentResponse(
        '{"intent":"update_job_schedule","confidence":0.92,"jobId":"job_heart","schedule":{"kind":"cron","expression":"*/45 * * * *","timezone":"UTC"}}',
      ),
    ).toEqual({
      intent: "update_job_schedule",
      confidence: 0.92,
      jobId: "job_heart",
      schedule: {
        kind: "cron",
        expression: "*/45 * * * *",
        timezone: "UTC",
      },
    });
  });

  test("parses task prompt update intents", () => {
    expect(
      parseSchedulerIntentResponse(
        '{"intent":"update_job_prompt","confidence":0.93,"jobId":"job_heart","prompt":"Post exactly this message: ❤️❤️"}',
      ),
    ).toEqual({
      intent: "update_job_prompt",
      confidence: 0.93,
      jobId: "job_heart",
      prompt: "Post exactly this message: ❤️❤️",
    });
  });

  test("parses task validation intents", () => {
    expect(
      parseSchedulerIntentResponse(
        '{"intent":"validate_task","confidence":0.89,"jobId":"job_github_checker"}',
      ),
    ).toEqual({
      intent: "validate_task",
      confidence: 0.89,
      jobId: "job_github_checker",
    });
  });

  test("parses task detail intents", () => {
    expect(
      parseSchedulerIntentResponse(
        '{"intent":"show_task","confidence":0.91,"jobId":"job_github_checker"}',
      ),
    ).toEqual({
      intent: "show_task",
      confidence: 0.91,
      jobId: "job_github_checker",
    });
  });

  test("rejects unsupported intents", () => {
    expect(
      parseSchedulerIntentResponse(
        '{"intent":"github_search","confidence":0.9,"jobId":null}',
      ),
    ).toBeNull();
  });

  test("includes current task specs for bounded job disambiguation", async () => {
    let prompt = "";
    const resolver = createLlmSchedulerIntentResolver({
      model: "openai:gpt-test",
      resolveModel: () =>
        ({
          provider: "openai",
          modelId: "gpt-test",
        }) as never,
      generateText: async (request) => {
        prompt = request.prompt;
        return {
          text: '{"intent":"trigger_job","confidence":0.97,"jobId":"job_github_checker"}',
        };
      },
    });

    const result = await resolver({
      text: "test run the GitHub checker job",
      recentMessages: [],
      jobs: [
        {
          jobId: "job_github_checker",
          title: "GitHub PR checker",
          prompt: "check for new open PRs in the apelogic-ai GitHub org",
          schedule: { kind: "interval", every: { minutes: 15 } },
          state: "scheduled",
          runtimeType: "openclaw",
          requiredTools: ["github_list_my_pull_requests"],
          routeId: "convrt_123",
          updatedAt: "2026-06-24T12:00:00.000Z",
        },
      ],
    });

    expect(prompt).toContain("Current task/job specs");
    expect(prompt).toContain('"create"');
    expect(prompt).toContain('"schedule"');
    expect(prompt).toContain("job_github_checker");
    expect(prompt).toContain("GitHub PR checker");
    expect(result).toEqual({
      intent: "trigger_job",
      confidence: 0.97,
      jobId: "job_github_checker",
    });
  });

  test("returns none when the LLM intent resolver times out", async () => {
    const warnings: string[] = [];
    const resolver = createLlmSchedulerIntentResolver({
      model: "openai:gpt-test",
      timeoutMs: 1,
      logWarn: (message) => warnings.push(message),
      resolveModel: () =>
        ({
          provider: "openai",
          modelId: "gpt-test",
        }) as never,
      generateText: () => new Promise(() => {}),
    });

    await expect(
      resolver({
        text: "test run the GitHub checker job",
        recentMessages: [],
        jobs: [],
      }),
    ).resolves.toEqual({
      intent: "none",
      confidence: 0,
      jobId: null,
    });
    expect(warnings).toEqual(["Scheduler intent resolver timed out."]);
  });
});
