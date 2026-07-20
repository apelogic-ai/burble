import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SCHEDULER_INTENT_TIMEOUT_MS,
  createLlmSchedulerIntentResolver,
  parseSchedulerIntentResponse,
} from "../../src/conversation/scheduler-intent-resolver";

describe("scheduler intent resolver", () => {
  test("allows production scheduler intent calls to outlast normal provider latency", () => {
    expect(DEFAULT_SCHEDULER_INTENT_TIMEOUT_MS).toBe(30_000);
  });

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

  test("parses generic recurring and preparation plans without flattening setup into the prompt", () => {
    expect(
      parseSchedulerIntentResponse(
        JSON.stringify({
          intent: "update_job_prompt",
          confidence: 0.98,
          jobId: "job_ai_news",
          taskPlan: {
            preparation: [
              {
                id: "create_state",
                tool: "google_docs_create_document",
                input: { name: "AI news topic history" },
                saveAs: "dedupe_document",
                purpose: "Track previously reported topics",
              },
            ],
            steps: [
              {
                id: "collect",
                instruction: "Find current AI news and select the top five.",
                tools: ["web_search"],
              },
              {
                id: "deduplicate",
                instruction:
                  "Read {{resources.dedupe_document.id}}, exclude known topics, and record new topics.",
                tools: [
                  "google_get_drive_file",
                  "google_append_to_drive_text_file",
                ],
              },
              {
                id: "report",
                instruction: "Return only net-new results.",
                tools: [],
              },
            ],
          },
        }),
      ),
    ).toEqual({
      intent: "update_job_prompt",
      confidence: 0.98,
      jobId: "job_ai_news",
      taskPlan: {
        preparation: [
          {
            id: "create_state",
            tool: "google_docs_create_document",
            input: { name: "AI news topic history" },
            saveAs: "dedupe_document",
            purpose: "Track previously reported topics",
          },
        ],
        steps: [
          {
            id: "collect",
            instruction: "Find current AI news and select the top five.",
            tools: ["web_search"],
          },
          {
            id: "deduplicate",
            instruction:
              "Read {{resources.dedupe_document.id}}, exclude known topics, and record new topics.",
            tools: [
              "google_get_drive_file",
              "google_append_to_drive_text_file",
            ],
          },
          {
            id: "report",
            instruction: "Return only net-new results.",
            tools: [],
          },
        ],
      },
    });
  });

  test("accepts ordinary JSON identifiers in generic task plans", () => {
    expect(
      parseSchedulerIntentResponse(
        JSON.stringify({
          intent: "update_job_prompt",
          confidence: 0.99,
          jobId: "job_pr_checker",
          taskPlan: {
            preparation: [
              {
                id: "createDedupState",
                tool: "google_create_drive_text_file",
                input: { name: "Open PR deduplication", text: "" },
                saveAs: "dedupState",
              },
            ],
            steps: [
              {
                id: "collectOpenPRs",
                instruction: "Find open pull requests.",
                tools: ["github_search_issues"],
              },
              {
                id: "deduplicateAndRecord",
                instruction:
                  "Use {{resources.dedupState.fileId}} to deduplicate results.",
                tools: [
                  "google_get_drive_file",
                  "google_append_to_drive_text_file",
                ],
              },
            ],
          },
        }),
      ),
    ).toMatchObject({
      taskPlan: {
        preparation: [
          {
            id: "createDedupState",
            saveAs: "dedupState",
          },
        ],
        steps: [
          { id: "collectOpenPRs" },
          {
            id: "deduplicateAndRecord",
            instruction:
              "Use {{resources.dedupState.fileId}} to deduplicate results.",
          },
        ],
      },
    });
  });

  test("parses explicit generic state-reference mutation semantics", () => {
    expect(
      parseSchedulerIntentResponse(
        JSON.stringify({
          intent: "update_job_prompt",
          confidence: 0.98,
          jobId: "job_stateful",
          taskPlan: {
            stateRefMode: "clear",
            preparation: [],
            steps: [
              {
                id: "report",
                instruction: "Report current results without prior state.",
                tools: [],
              },
            ],
          },
        }),
      ),
    ).toMatchObject({
      taskPlan: {
        stateRefMode: "clear",
        preparation: [],
      },
    });
  });

  test("rejects malformed preparation plans instead of accepting unsafe partial plans", () => {
    expect(
      parseSchedulerIntentResponse(
        '{"intent":"update_job_prompt","confidence":0.98,"jobId":"job_any","taskPlan":{"preparation":[{"id":"setup","tool":"google_docs_create_document","input":{},"saveAs":"resource"},{"id":"setup","tool":"google_create_drive_folder","input":{},"saveAs":"resource"}],"steps":[{"id":"run","instruction":"Use it.","tools":[]}]}}',
      ),
    ).toEqual({
      intent: "update_job_prompt",
      confidence: 0.98,
      jobId: "job_any",
    });
  });

  test("parses task runtime update intents", () => {
    expect(
      parseSchedulerIntentResponse(
        '{"intent":"update_job_runtime","confidence":0.95,"jobId":"job_ai_news","runtimeType":"burble-native"}',
      ),
    ).toEqual({
      intent: "update_job_runtime",
      confidence: 0.95,
      jobId: "job_ai_news",
      runtimeType: "burble-native",
    });
  });

  test("parses composite task update intents", () => {
    expect(
      parseSchedulerIntentResponse(
        '{"intent":"update_job","confidence":0.97,"jobId":"job_heart","prompt":"Post exactly this message: :heart:","schedule":{"kind":"cron","expression":"*/15 * * * *","timezone":"UTC"},"runtimeType":"burble-native"}',
      ),
    ).toEqual({
      intent: "update_job",
      confidence: 0.97,
      jobId: "job_heart",
      prompt: "Post exactly this message: :heart:",
      schedule: {
        kind: "cron",
        expression: "*/15 * * * *",
        timezone: "UTC",
      },
      runtimeType: "burble-native",
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
    let system = "";
    const resolver = createLlmSchedulerIntentResolver({
      model: "openai:gpt-test",
      resolveModel: () =>
        ({
          provider: "openai",
          modelId: "gpt-test",
        }) as never,
      generateText: async (request) => {
        prompt = request.prompt;
        system = request.system;
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
          expectedTools: ["github_search_issues"],
          stateRefs: [
            {
              provider: "object-store",
              kind: "checkpoint",
              id: "state-123",
              purpose: "Deduplicate prior results",
            },
          ],
          routeId: "convrt_123",
          updatedAt: "2026-06-24T12:00:00.000Z",
        },
      ],
    });

    expect(prompt).toContain("Current task/job specs");
    expect(prompt).toContain('"create"');
    expect(prompt).toContain('"schedule"');
    expect(system).toContain('"0 9 * * 1-5"');
    expect(prompt).toContain("job_github_checker");
    expect(prompt).toContain("GitHub PR checker");
    expect(prompt).toContain(
      'requiredTools=["github_list_my_pull_requests"]',
    );
    expect(prompt).toContain('expectedTools=["github_search_issues"]');
    expect(prompt).toContain('"provider":"object-store"');
    expect(prompt).toContain('"id":"state-123"');
    expect(system).toContain("Canonical provider tools");
    expect(system).toContain("github_search_issues");
    expect(system).toContain("google_get_drive_file");
    expect(system).toContain("google_append_to_drive_text_file");
    expect(system).toContain("stateRefInputs=fileId");
    expect(system).toContain(
      "Recurring tools marked stateRefRequired require a matching durable stateRef",
    );
    expect(system).toContain("stateRefRequired=true");
    expect(system).toContain(
      "Use only the exact canonical tool names listed below",
    );
    expect(result).toEqual({
      intent: "trigger_job",
      confidence: 0.97,
      jobId: "job_github_checker",
    });
  });

  test("repairs an unknown recurring tool once without changing scheduler intent", async () => {
    const requests: Array<{ system: string; prompt: string }> = [];
    const resolver = createLlmSchedulerIntentResolver({
      model: "openai:gpt-test",
      resolveModel: () =>
        ({
          provider: "openai",
          modelId: "gpt-test",
        }) as never,
      generateText: async (request) => {
        requests.push({ system: request.system, prompt: request.prompt });
        if (requests.length === 1) {
          return {
            text: JSON.stringify({
              intent: "update_job_prompt",
              confidence: 0.98,
              jobId: "job_pr_checker",
              taskPlan: {
                preparation: [],
                steps: [
                  {
                    id: "collect_open_prs",
                    instruction:
                      "Find open pull requests in the example-org organization.",
                    tools: ["github"],
                  },
                  {
                    id: "deduplicate",
                    instruction:
                      "Use the existing Drive state document to remove previously reported pull requests.",
                    tools: [
                      "google_get_drive_file",
                      "google_append_to_drive_text_file",
                    ],
                  },
                  {
                    id: "report",
                    instruction:
                      "Return only net-new pull requests or exactly: no new open PRs",
                    tools: [],
                  },
                ],
              },
            }),
          };
        }
        return {
          text: JSON.stringify({
            intent: "update_job_prompt",
            confidence: 0.4,
            jobId: "wrong_job",
            taskPlan: {
              preparation: [],
              steps: [
                {
                  id: "collect_open_prs",
                  instruction: "Replace the user task with something else.",
                  tools: ["github_search_issues"],
                },
                {
                  id: "deduplicate",
                  instruction:
                    "Use the existing Drive state document to remove previously reported pull requests.",
                  tools: [
                    "google_get_drive_file",
                    "google_append_to_drive_text_file",
                  ],
                },
                {
                  id: "report",
                  instruction:
                    "Return only net-new pull requests or exactly: no new open PRs",
                  tools: [],
                },
              ],
            },
          }),
        };
      },
    });

    const result = await resolver({
      text: "modify the open PRs cron job to run in steps",
      recentMessages: [],
      jobs: [
        {
          jobId: "job_pr_checker",
          title: "Open pull request checker",
          prompt: "Check for open pull requests.",
          schedule: { kind: "cron", expression: "*/15 * * * *" },
          state: "scheduled",
          runtimeType: "burble-native",
          requiredTools: [
            "github_search_issues",
            "google_get_drive_file",
            "google_append_to_drive_text_file",
          ],
          routeId: "convrt_123",
          updatedAt: "2026-07-18T16:00:00.000Z",
        },
      ],
    });

    expect(requests).toHaveLength(2);
    expect(requests[1]?.prompt).toContain(
      "Recurring step collect_open_prs references unknown provider tool github.",
    );
    expect(requests[1]?.system).toContain("github_search_issues");
    expect(result.intent).toBe("update_job_prompt");
    expect(result.jobId).toBe("job_pr_checker");
    expect(result.confidence).toBe(0.98);
    expect(result.taskPlan?.steps[0]?.tools).toEqual([
      "github_search_issues",
    ]);
    expect(result.taskPlan?.steps[0]?.instruction).toBe(
      "Find open pull requests in the example-org organization.",
    );
  });

  test("repairs one malformed scheduler mutation payload", async () => {
    const prompts: string[] = [];
    const warnings: string[] = [];
    const resolver = createLlmSchedulerIntentResolver({
      model: "openai:gpt-test",
      resolveModel: () =>
        ({ provider: "openai", modelId: "gpt-test" }) as never,
      generateText: async (request) => {
        prompts.push(request.prompt);
        if (prompts.length === 1) {
          return {
            text: JSON.stringify({
              intent: "update_job_prompt",
              confidence: 0.99,
              jobId: "job_pr_checker",
              taskPlan: {
                preparation: "invalid",
                steps: [
                  {
                    id: "collect",
                    instruction: "Find open pull requests.",
                    tools: ["github_search_issues"],
                  },
                ],
              },
            }),
          };
        }
        return {
          text: JSON.stringify({
            intent: "update_job_prompt",
            confidence: 0.99,
            jobId: "job_pr_checker",
            taskPlan: {
              preparation: [],
              steps: [
                {
                  id: "collect",
                  instruction: "Find open pull requests.",
                  tools: ["github_search_issues"],
                },
              ],
            },
          }),
        };
      },
      logWarn: (message) => warnings.push(message),
    });

    const result = await resolver({
      text: "modify the open PR checker job",
      recentMessages: [],
      jobs: [],
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Repair this scheduler-intent JSON");
    expect(prompts[1]).toContain("Preserve the original intent and jobId");
    expect(warnings).toEqual([
      "Scheduler intent resolver returned an incomplete or malformed mutation payload; attempting one structural repair.",
    ]);
    expect(result).toMatchObject({
      intent: "update_job_prompt",
      jobId: "job_pr_checker",
      taskPlan: {
        preparation: [],
        steps: [{ id: "collect", tools: ["github_search_issues"] }],
      },
    });
  });

  test("rejects a structural repair that changes the selected job", async () => {
    let calls = 0;
    const resolver = createLlmSchedulerIntentResolver({
      model: "openai:gpt-test",
      resolveModel: () =>
        ({ provider: "openai", modelId: "gpt-test" }) as never,
      generateText: async () => {
        calls += 1;
        return {
          text: JSON.stringify({
            intent: "update_job_prompt",
            confidence: 0.99,
            jobId: calls === 1 ? "job_pr_checker" : "job_other",
          }),
        };
      },
    });

    await expect(
      resolver({
        text: "modify the open PR checker job",
        recentMessages: [],
        jobs: [],
      }),
    ).resolves.toEqual({
      intent: "none",
      confidence: 0,
      jobId: null,
      failure: "invalid_response",
    });
    expect(calls).toBe(2);
  });

  test("includes deterministic pre-flight feedback in a bounded repair request", async () => {
    let prompt = "";
    const resolver = createLlmSchedulerIntentResolver({
      model: "openai:gpt-test",
      resolveModel: () =>
        ({ provider: "openai", modelId: "gpt-test" }) as never,
      generateText: async (request) => {
        prompt = request.prompt;
        return {
          text: JSON.stringify({
            intent: "update_job_prompt",
            confidence: 0.99,
            jobId: "job_stateful",
            taskPlan: {
              preparation: [],
              steps: [
                {
                  id: "read",
                  instruction: "Read the configured state.",
                  tools: ["google_get_drive_file"],
                },
              ],
            },
          }),
        };
      },
    });

    await resolver({
      text: "Update the stateful task.",
      recentMessages: [],
      jobs: [],
      repair: {
        jobId: "job_stateful",
        errors: [
          "missing_required_tool: Task requires google_get_drive_file but the grant does not include it.",
        ],
      },
    });

    expect(prompt).toContain("Pre-flight repair request");
    expect(prompt).toContain("job_stateful");
    expect(prompt).toContain("missing_required_tool");
    expect(prompt).toContain("Return one corrected candidate");
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
      failure: "timeout",
    });
    expect(warnings).toEqual(["Scheduler intent resolver timed out."]);
  });

  test("marks invalid resolver output as a resolution failure", async () => {
    const resolver = createLlmSchedulerIntentResolver({
      model: "openai:gpt-test",
      resolveModel: () =>
        ({
          provider: "openai",
          modelId: "gpt-test",
        }) as never,
      generateText: async () => ({ text: "not json" }),
    });

    await expect(
      resolver({
        text: "modify the heart job",
        recentMessages: [],
        jobs: [],
      }),
    ).resolves.toEqual({
      intent: "none",
      confidence: 0,
      jobId: null,
      failure: "invalid_response",
    });
  });
});
