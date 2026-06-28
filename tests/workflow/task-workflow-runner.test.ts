import { describe, expect, test } from "bun:test";
import { executeTaskWorkflowPlan } from "../../src/workflow/task-workflow-runner";

describe("task workflow runner", () => {
  test("validates the plan before executing handlers", async () => {
    const calls: string[] = [];

    const result = await executeTaskWorkflowPlan({
      plan: {
        mode: "burble_workflow",
        grants: { tools: ["google_update_drive_text_file"] },
        steps: [
          {
            id: "write",
            kind: "provider_call",
            tool: "google_update_drive_text_file",
            input: { text: "hello" },
          },
        ],
      },
      handlers: {
        providerCall: async () => {
          calls.push("provider");
          return {};
        },
        model: async () => ({}),
        delivery: async () => ({}),
      },
    });

    expect(calls).toEqual([]);
    expect(result).toEqual({
      ok: false,
      errors: [
        {
          code: "missing_idempotency_key",
          stepId: "write",
          message:
            "Workflow step write uses a mutating tool and requires an idempotencyKey.",
        },
      ],
    });
  });

  test("executes provider, model, and delivery steps with resolved bindings", async () => {
    const providerCalls: unknown[] = [];
    const modelCalls: unknown[] = [];
    const deliveryCalls: unknown[] = [];

    const result = await executeTaskWorkflowPlan({
      plan: {
        mode: "burble_workflow",
        grants: {
          tools: ["github_search_issues", "conversation_send_message"],
        },
        availableBindings: ["lastRunAt", "delivery.routeId"],
        steps: [
          {
            id: "github_prs",
            kind: "provider_call",
            tool: "github_search_issues",
            input: {
              query: "org:apelogic-ai is:pr updated:>{lastRunAt}",
            },
            saveAs: "prs",
          },
          {
            id: "render",
            kind: "model",
            input: {
              data: "{prs.items}",
            },
            saveAs: "message",
          },
          {
            id: "deliver",
            kind: "delivery",
            tool: "conversation_send_message",
            input: {
              routeId: "{delivery.routeId}",
              text: "{message.text}",
            },
            idempotencyKey: "{jobRunId}:deliver",
          },
        ],
      },
      initialBindings: {
        jobRunId: "jobrun-1",
        lastRunAt: "2026-06-28",
        delivery: { routeId: "convrt_123" },
      },
      handlers: {
        providerCall: async (input) => {
          providerCalls.push(input);
          return {
            items: [
              {
                repo: "burble",
                title: "Add scheduler task inspection",
              },
            ],
          };
        },
        model: async (input) => {
          modelCalls.push(input);
          const modelInput = input.input as { data?: unknown[] };
          return {
            text: `New PRs: ${Array.isArray(modelInput.data) ? modelInput.data.length : 0}`,
          };
        },
        delivery: async (input) => {
          deliveryCalls.push(input);
          return { ok: true };
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(providerCalls).toEqual([
      {
        stepId: "github_prs",
        tool: "github_search_issues",
        input: {
          query: "org:apelogic-ai is:pr updated:>2026-06-28",
        },
        idempotencyKey: undefined,
      },
    ]);
    expect(modelCalls).toEqual([
      {
        stepId: "render",
        modelProfile: undefined,
        input: {
          data: [
            {
              repo: "burble",
              title: "Add scheduler task inspection",
            },
          ],
        },
      },
    ]);
    expect(deliveryCalls).toEqual([
      {
        stepId: "deliver",
        tool: "conversation_send_message",
        input: {
          routeId: "convrt_123",
          text: "New PRs: 1",
        },
        idempotencyKey: "jobrun-1:deliver",
      },
    ]);
  });

  test("stops at the first handler failure", async () => {
    const result = await executeTaskWorkflowPlan({
      plan: {
        mode: "burble_workflow",
        grants: { tools: ["github_search_issues"] },
        steps: [
          {
            id: "github_prs",
            kind: "provider_call",
            tool: "github_search_issues",
            input: {},
          },
        ],
      },
      handlers: {
        providerCall: async () => {
          throw new Error("GitHub failed");
        },
        model: async () => ({}),
        delivery: async () => ({}),
      },
    });

    expect(result).toEqual({
      ok: false,
      errors: [
        {
          code: "step_failed",
          stepId: "github_prs",
          message: "Workflow step github_prs failed: GitHub failed",
        },
      ],
    });
  });
});
