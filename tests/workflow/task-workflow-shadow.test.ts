import { describe, expect, test } from "bun:test";
import {
  recordTaskWorkflowRunFailed,
  recordTaskWorkflowRunStarted,
  recordTaskWorkflowRunSucceeded,
  recordTaskWorkflowRunTriggered,
} from "../../src/workflow/task-workflow-shadow";
import { createInMemoryTaskWorkflowEventStore } from "../../src/workflow/task-workflow-store";
import type { AgentJobRunRecord } from "../../src/db";

describe("task workflow shadow recorder", () => {
  test("mirrors run trigger, start, and success into workflow state", () => {
    const store = createInMemoryTaskWorkflowEventStore();
    const run = scheduledRun({
      triggerSource: "schedule",
      createdAt: "2026-06-29T10:00:00.000Z",
      startedAt: "2026-06-29T10:00:01.000Z",
      finishedAt: "2026-06-29T10:00:05.000Z",
    });

    recordTaskWorkflowRunTriggered({ store, run });
    recordTaskWorkflowRunStarted({ store, run });
    recordTaskWorkflowRunSucceeded({
      store,
      run,
      outputText: "Done.",
      routeId: "convrt_123",
    });

    const events = store.listEvents();
    expect(events.map((event) => event.event.type)).toEqual([
      "task_triggered",
      "validation_passed",
      "attempt_started",
      "attempt_succeeded",
      "delivery_started",
      "delivery_succeeded",
    ]);
    expect(events.map((event) => event.event.at)).toEqual([
      "2026-06-29T10:00:00.000Z",
      "2026-06-29T10:00:01.000Z",
      "2026-06-29T10:00:01.000Z",
      "2026-06-29T10:00:05.000Z",
      "2026-06-29T10:00:05.000Z",
      "2026-06-29T10:00:05.000Z",
    ]);
    expect(store.replayState().runs["jobrun-1"]).toMatchObject({
      jobRunId: "jobrun-1",
      taskId: "job-1",
      source: "schedule",
      status: "succeeded",
      attempt: 1,
    });
  });

  test("records terminal run failures without throwing", () => {
    const store = createInMemoryTaskWorkflowEventStore();
    const warnings: string[] = [];
    const run = scheduledRun({
      triggerSource: "manual",
      createdAt: "2026-06-29T10:00:00.000Z",
      startedAt: "2026-06-29T10:00:01.000Z",
      finishedAt: "2026-06-29T10:00:07.000Z",
    });

    recordTaskWorkflowRunTriggered({ store, run });
    recordTaskWorkflowRunStarted({ store, run });
    recordTaskWorkflowRunFailed({
      store,
      run,
      failureClass: "runtime_failed",
      reason: "provider timeout",
      logWarn: (message) => warnings.push(message),
    });

    expect(warnings).toEqual([]);
    expect(store.listEvents().at(-1)?.event.at).toBe(
      "2026-06-29T10:00:07.000Z",
    );
    expect(store.replayState().runs["jobrun-1"]).toMatchObject({
      status: "failed",
      failureClass: "runtime_failed",
      failureReason: "provider timeout",
    });
  });

  test("uses stable event ids for duplicate shadow writes", () => {
    const store = createInMemoryTaskWorkflowEventStore();
    const run = scheduledRun({ triggerSource: "manual" });

    recordTaskWorkflowRunTriggered({ store, run });
    recordTaskWorkflowRunTriggered({ store, run });

    expect(store.listEvents()).toHaveLength(1);
  });

  test("swallows recorder failures", () => {
    const warnings: string[] = [];
    const store = {
      appendEvent() {
        throw new Error("shadow store down");
      },
    };

    expect(() =>
      recordTaskWorkflowRunTriggered({
        store,
        run: scheduledRun({ triggerSource: "manual" }),
        logWarn: (message) => warnings.push(message),
      }),
    ).not.toThrow();
    expect(warnings[0]).toContain("shadow store down");
  });
});

function scheduledRun(
  input: Partial<AgentJobRunRecord> & {
    triggerSource: AgentJobRunRecord["triggerSource"];
  },
): AgentJobRunRecord {
  return {
    runId: "jobrun-1",
    jobId: "job-1",
    workspaceId: "T123",
    slackUserId: "U123",
    triggerSource: input.triggerSource,
    status: input.status ?? "queued",
    failureReason: input.failureReason ?? null,
    createdAt: input.createdAt ?? "2026-06-29T10:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-06-29T10:00:00.000Z",
    startedAt: input.startedAt ?? null,
    finishedAt: input.finishedAt ?? null,
  };
}
