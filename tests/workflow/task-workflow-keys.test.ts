import { describe, expect, test } from "bun:test";
import {
  taskWorkflowDeliveryKey,
  taskWorkflowFailureWindowKey,
  taskWorkflowManualTriggerKey,
  taskWorkflowScheduledTriggerKey,
  taskWorkflowStepAttemptKey,
} from "../../src/workflow/task-workflow-keys";

describe("task workflow keys", () => {
  test("creates stable scheduled trigger keys from a task and due slot", () => {
    expect(
      taskWorkflowScheduledTriggerKey({
        taskId: "task-pr-monitor",
        dueSlot: "2026-06-28T17:00:00.000Z",
      }),
    ).toBe(
      "task:task-pr-monitor:trigger:schedule:2026-06-28T17%3A00%3A00.000Z",
    );
  });

  test("creates stable manual trigger keys from a request id", () => {
    expect(
      taskWorkflowManualTriggerKey({
        taskId: "task-pr-monitor",
        requestId: "slack-msg-123",
      }),
    ).toBe("task:task-pr-monitor:trigger:manual:slack-msg-123");
  });

  test("creates step attempt keys scoped by job run, step, and attempt", () => {
    expect(
      taskWorkflowStepAttemptKey({
        jobRunId: "jobrun-1",
        stepId: "github_prs",
        attempt: 2,
      }),
    ).toBe("jobrun:jobrun-1:step:github_prs:attempt:2");
  });

  test("creates delivery keys from route and output digest", () => {
    expect(
      taskWorkflowDeliveryKey({
        jobRunId: "jobrun-1",
        deliveryRouteId: "convrt_123",
        outputDigest: "sha256:abc",
      }),
    ).toBe("jobrun:jobrun-1:delivery:convrt_123:sha256%3Aabc");
  });

  test("creates failure window keys for failure caps", () => {
    expect(
      taskWorkflowFailureWindowKey({
        taskId: "task-ai-news",
        failureClass: "invalid_grant",
        window: "2026-06-28",
      }),
    ).toBe("task:task-ai-news:failure:invalid_grant:window:2026-06-28");
  });

  test("rejects empty key parts", () => {
    expect(() =>
      taskWorkflowManualTriggerKey({
        taskId: "task-ai-news",
        requestId: " ",
      }),
    ).toThrow("Task workflow key part requestId is empty");
  });

  test("rejects unsafe separators in key parts", () => {
    expect(() =>
      taskWorkflowStepAttemptKey({
        jobRunId: "jobrun:1",
        stepId: "render",
        attempt: 1,
      }),
    ).toThrow("Task workflow key part jobRunId cannot contain ':'");
  });
});
