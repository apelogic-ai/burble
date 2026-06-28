import { describe, expect, test } from "bun:test";
import { validateTaskWorkflowPlan } from "../../src/workflow/task-workflow-plan";

describe("task workflow plan validation", () => {
  test("accepts a valid multi-step provider/model/delivery workflow", () => {
    expect(
      validateTaskWorkflowPlan({
        mode: "burble_workflow",
        grants: {
          tools: [
            "jira_search_issues",
            "github_search_issues",
            "google_update_drive_text_file",
            "conversation_send_message",
          ],
        },
        availableBindings: ["lastRunAt", "delivery.routeId"],
        steps: [
          {
            id: "jira_issues",
            kind: "provider_call",
            tool: "jira_search_issues",
            input: {
              jql: 'priority in (P0, P1) AND updated >= "{lastRunAt}"',
            },
            saveAs: "issues",
          },
          {
            id: "github_prs",
            kind: "provider_call",
            foreach: "issues.items",
            tool: "github_search_issues",
            input: {
              query: 'org:apelogic-ai is:pr is:open "{item.key}"',
            },
            saveAs: "prs",
          },
          {
            id: "render",
            kind: "model",
            input: {
              data: "{prs}",
            },
            saveAs: "message",
          },
          {
            id: "update_seen",
            kind: "provider_call",
            tool: "google_update_drive_text_file",
            input: {
              fileId: "drive-file-id",
              text: "{prs}",
            },
            idempotencyKey: "{jobRunId}:update_seen",
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
      }),
    ).toEqual({ ok: true, errors: [] });
  });

  test("rejects duplicate step ids", () => {
    expect(
      validateTaskWorkflowPlan({
        mode: "burble_workflow",
        grants: { tools: ["github_search_issues"] },
        steps: [
          {
            id: "search",
            kind: "provider_call",
            tool: "github_search_issues",
            input: {},
          },
          {
            id: "search",
            kind: "model",
            input: {},
          },
        ],
      }),
    ).toEqual({
      ok: false,
      errors: [
        {
          code: "duplicate_step_id",
          stepId: "search",
          message: "Workflow step id search is duplicated.",
        },
      ],
    });
  });

  test("rejects provider and delivery tools not present in grants", () => {
    const result = validateTaskWorkflowPlan({
      mode: "burble_workflow",
      grants: { tools: ["github_search_issues"] },
      steps: [
        {
          id: "drive_write",
          kind: "provider_call",
          tool: "google_update_drive_text_file",
          input: {},
          idempotencyKey: "{jobRunId}:drive_write",
        },
        {
          id: "deliver",
          kind: "delivery",
          tool: "conversation_send_message",
          input: { text: "done" },
          idempotencyKey: "{jobRunId}:deliver",
        },
      ],
    });

    expect(result).toEqual({
      ok: false,
      errors: [
        {
          code: "tool_not_granted",
          stepId: "drive_write",
          message:
            "Workflow step drive_write uses ungranted tool google_update_drive_text_file.",
        },
        {
          code: "tool_not_granted",
          stepId: "deliver",
          message:
            "Workflow step deliver uses ungranted tool conversation_send_message.",
        },
      ],
    });
  });

  test("requires idempotency keys for mutating provider and delivery steps", () => {
    const result = validateTaskWorkflowPlan({
      mode: "burble_workflow",
      grants: {
        tools: ["google_update_drive_text_file", "conversation_send_message"],
      },
      steps: [
        {
          id: "update_seen",
          kind: "provider_call",
          tool: "google_update_drive_text_file",
          input: {},
        },
        {
          id: "deliver",
          kind: "delivery",
          tool: "conversation_send_message",
          input: { text: "done" },
        },
      ],
    });

    expect(result).toEqual({
      ok: false,
      errors: [
        {
          code: "missing_idempotency_key",
          stepId: "update_seen",
          message:
            "Workflow step update_seen uses a mutating tool and requires an idempotencyKey.",
        },
        {
          code: "missing_idempotency_key",
          stepId: "deliver",
          message: "Workflow delivery step deliver requires an idempotencyKey.",
        },
      ],
    });
  });

  test("rejects unknown provider tools even when granted", () => {
    const result = validateTaskWorkflowPlan({
      mode: "burble_workflow",
      grants: { tools: ["custom_create_ticket"] },
      steps: [
        {
          id: "write",
          kind: "provider_call",
          tool: "custom_create_ticket",
          input: {},
          idempotencyKey: "{jobRunId}:write",
        },
      ],
    });

    expect(result).toEqual({
      ok: false,
      errors: [
        {
          code: "unknown_provider_tool",
          stepId: "write",
          message:
            "Workflow step write uses unknown provider tool custom_create_ticket.",
        },
      ],
    });
  });

  test("validates idempotency key template bindings", () => {
    const result = validateTaskWorkflowPlan({
      mode: "burble_workflow",
      grants: { tools: ["conversation_send_message"] },
      steps: [
        {
          id: "deliver",
          kind: "delivery",
          tool: "conversation_send_message",
          input: { text: "done" },
          idempotencyKey: "{missing.id}:deliver",
        },
      ],
    });

    expect(result).toEqual({
      ok: false,
      errors: [
        {
          code: "unbound_template_variable",
          stepId: "deliver",
          message:
            "Workflow step deliver references unbound template variable missing.id.",
        },
      ],
    });
  });

  test("rejects unbound template variables before execution", () => {
    const result = validateTaskWorkflowPlan({
      mode: "burble_workflow",
      grants: { tools: ["github_search_issues"] },
      availableBindings: ["lastRunAt"],
      steps: [
        {
          id: "github_prs",
          kind: "provider_call",
          tool: "github_search_issues",
          input: {
            query: "org:apelogic-ai is:pr updated:>{missingSince}",
          },
        },
      ],
    });

    expect(result).toEqual({
      ok: false,
      errors: [
        {
          code: "unbound_template_variable",
          stepId: "github_prs",
          message:
            "Workflow step github_prs references unbound template variable missingSince.",
        },
      ],
    });
  });
});
