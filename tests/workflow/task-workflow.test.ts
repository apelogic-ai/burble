import { describe, expect, test } from "bun:test";
import {
  applyTaskWorkflowEvent,
  createInitialTaskWorkflowState,
  reduceTaskWorkflowEvents,
  transitionTaskWorkflowEvent,
  type TaskWorkflowEvent,
} from "../../src/workflow/task-workflow";

describe("task workflow reducer", () => {
  test("uses trigger keys to make scheduled/manual run creation idempotent", () => {
    const events: TaskWorkflowEvent[] = [
      {
        type: "task_triggered",
        taskId: "task-pr-monitor",
        jobRunId: "jobrun-1",
        triggerKey: "task-pr-monitor:slot:2026-06-28T17:00Z",
        source: "schedule",
        at: "2026-06-28T17:00:00.000Z",
      },
      {
        type: "task_triggered",
        taskId: "task-pr-monitor",
        jobRunId: "jobrun-duplicate",
        triggerKey: "task-pr-monitor:slot:2026-06-28T17:00Z",
        source: "schedule",
        at: "2026-06-28T17:00:01.000Z",
      },
    ];

    const state = reduceTaskWorkflowEvents(events);

    expect(state.triggerKeys).toEqual({
      "task-pr-monitor:slot:2026-06-28T17:00Z": "jobrun-1",
    });
    expect(Object.keys(state.runs)).toEqual(["jobrun-1"]);
    expect(state.runs["jobrun-1"]).toMatchObject({
      status: "created",
      triggerKey: "task-pr-monitor:slot:2026-06-28T17:00Z",
      source: "schedule",
    });
  });

  test("emits validate command for a newly triggered task", () => {
    const result = transitionTaskWorkflowEvent(createInitialTaskWorkflowState(), {
      type: "task_triggered",
      taskId: "task-pr-monitor",
      jobRunId: "jobrun-1",
      triggerKey: "task-pr-monitor:slot:2026-06-28T17:00Z",
      source: "schedule",
      at: "2026-06-28T17:00:00.000Z",
    });

    expect(result.commands).toEqual([
      {
        type: "validate_task",
        taskId: "task-pr-monitor",
        jobRunId: "jobrun-1",
      },
    ]);
  });

  test("does not emit commands for duplicate triggers", () => {
    let state = createInitialTaskWorkflowState();
    state = transitionTaskWorkflowEvent(state, {
      type: "task_triggered",
      taskId: "task-pr-monitor",
      jobRunId: "jobrun-1",
      triggerKey: "task-pr-monitor:slot:2026-06-28T17:00Z",
      source: "schedule",
      at: "2026-06-28T17:00:00.000Z",
    }).state;

    const result = transitionTaskWorkflowEvent(state, {
      type: "task_triggered",
      taskId: "task-pr-monitor",
      jobRunId: "jobrun-duplicate",
      triggerKey: "task-pr-monitor:slot:2026-06-28T17:00Z",
      source: "schedule",
      at: "2026-06-28T17:00:01.000Z",
    });

    expect(result.commands).toEqual([]);
  });

  test("records validation failure as a terminal failed run with notification pending", () => {
    const state = reduceTaskWorkflowEvents([
      {
        type: "task_triggered",
        taskId: "task-ai-news",
        jobRunId: "jobrun-1",
        triggerKey: "task-ai-news:manual:req-1",
        source: "manual",
        at: "2026-06-28T17:00:00.000Z",
      },
      {
        type: "validation_failed",
        taskId: "task-ai-news",
        jobRunId: "jobrun-1",
        failureClass: "invalid_grant",
        reason: "Missing required tool web_search",
        at: "2026-06-28T17:00:02.000Z",
      },
    ]);

    expect(state.runs["jobrun-1"]).toMatchObject({
      status: "failed",
      failureClass: "invalid_grant",
      failureReason: "Missing required tool web_search",
      notificationPending: true,
    });
    expect(state.failureCounts["task-ai-news:invalid_grant"]).toBe(1);
  });

  test("auto-pauses a task after repeated validation failures", () => {
    let state = createInitialTaskWorkflowState({
      failurePauseThreshold: 2,
    });

    state = applyTaskWorkflowEvent(state, {
      type: "task_triggered",
      taskId: "task-ai-news",
      jobRunId: "jobrun-1",
      triggerKey: "task-ai-news:slot:1",
      source: "schedule",
      at: "2026-06-28T17:00:00.000Z",
    });
    state = applyTaskWorkflowEvent(state, {
      type: "validation_failed",
      taskId: "task-ai-news",
      jobRunId: "jobrun-1",
      failureClass: "invalid_grant",
      reason: "Missing required tool web_search",
      at: "2026-06-28T17:00:02.000Z",
    });
    state = applyTaskWorkflowEvent(state, {
      type: "task_triggered",
      taskId: "task-ai-news",
      jobRunId: "jobrun-2",
      triggerKey: "task-ai-news:slot:2",
      source: "schedule",
      at: "2026-06-28T18:00:00.000Z",
    });
    state = applyTaskWorkflowEvent(state, {
      type: "validation_failed",
      taskId: "task-ai-news",
      jobRunId: "jobrun-2",
      failureClass: "invalid_grant",
      reason: "Missing required tool web_search",
      at: "2026-06-28T18:00:02.000Z",
    });

    expect(state.tasks["task-ai-news"]).toEqual({
      status: "needs_repair",
      pausedReason: "Repeated invalid_grant failures",
    });
    expect(state.runs["jobrun-2"]).toMatchObject({
      status: "paused_after_failures",
      failureClass: "invalid_grant",
      notificationPending: true,
    });
  });

  test("tracks attempt, delivery, and success transitions", () => {
    const state = reduceTaskWorkflowEvents([
      {
        type: "task_triggered",
        taskId: "task-heart",
        jobRunId: "jobrun-1",
        triggerKey: "task-heart:manual:req-1",
        source: "manual",
        at: "2026-06-28T17:00:00.000Z",
      },
      {
        type: "validation_passed",
        taskId: "task-heart",
        jobRunId: "jobrun-1",
        at: "2026-06-28T17:00:01.000Z",
      },
      {
        type: "attempt_started",
        taskId: "task-heart",
        jobRunId: "jobrun-1",
        attempt: 1,
        mode: "agent",
        at: "2026-06-28T17:00:02.000Z",
      },
      {
        type: "attempt_succeeded",
        taskId: "task-heart",
        jobRunId: "jobrun-1",
        attempt: 1,
        outputDigest: "sha256:heart",
        at: "2026-06-28T17:00:03.000Z",
      },
      {
        type: "delivery_started",
        taskId: "task-heart",
        jobRunId: "jobrun-1",
        deliveryKey: "jobrun-1:route-1:sha256:heart",
        at: "2026-06-28T17:00:04.000Z",
      },
      {
        type: "delivery_succeeded",
        taskId: "task-heart",
        jobRunId: "jobrun-1",
        deliveryKey: "jobrun-1:route-1:sha256:heart",
        at: "2026-06-28T17:00:05.000Z",
      },
    ]);

    expect(state.runs["jobrun-1"]).toMatchObject({
      status: "succeeded",
      attempt: 1,
      outputDigest: "sha256:heart",
      deliveryKey: "jobrun-1:route-1:sha256:heart",
    });
  });

  test("emits lifecycle commands after validation and successful attempts", () => {
    let state = createInitialTaskWorkflowState();
    state = transitionTaskWorkflowEvent(state, {
      type: "task_triggered",
      taskId: "task-heart",
      jobRunId: "jobrun-1",
      triggerKey: "task-heart:manual:req-1",
      source: "manual",
      at: "2026-06-28T17:00:00.000Z",
    }).state;

    const validation = transitionTaskWorkflowEvent(state, {
      type: "validation_passed",
      taskId: "task-heart",
      jobRunId: "jobrun-1",
      at: "2026-06-28T17:00:01.000Z",
    });
    expect(validation.commands).toEqual([
      {
        type: "start_attempt",
        taskId: "task-heart",
        jobRunId: "jobrun-1",
        attempt: 1,
        mode: "agent",
      },
    ]);

    const attempt = transitionTaskWorkflowEvent(validation.state, {
      type: "attempt_succeeded",
      taskId: "task-heart",
      jobRunId: "jobrun-1",
      attempt: 1,
      outputDigest: "sha256:heart",
      at: "2026-06-28T17:00:03.000Z",
    });
    expect(attempt.commands).toEqual([
      {
        type: "deliver_output",
        taskId: "task-heart",
        jobRunId: "jobrun-1",
        outputDigest: "sha256:heart",
      },
    ]);
  });

  test("emits notify and pause commands for repeated failures", () => {
    let state = createInitialTaskWorkflowState({
      failurePauseThreshold: 1,
    });
    state = transitionTaskWorkflowEvent(state, {
      type: "task_triggered",
      taskId: "task-ai-news",
      jobRunId: "jobrun-1",
      triggerKey: "task-ai-news:slot:1",
      source: "schedule",
      at: "2026-06-28T17:00:00.000Z",
    }).state;

    const result = transitionTaskWorkflowEvent(state, {
      type: "validation_failed",
      taskId: "task-ai-news",
      jobRunId: "jobrun-1",
      failureClass: "invalid_grant",
      reason: "Missing required tool web_search",
      at: "2026-06-28T17:00:02.000Z",
    });

    expect(result.commands).toEqual([
      {
        type: "notify_failure",
        taskId: "task-ai-news",
        jobRunId: "jobrun-1",
        failureClass: "invalid_grant",
        reason: "Missing required tool web_search",
      },
      {
        type: "pause_task",
        taskId: "task-ai-news",
        reason: "Repeated invalid_grant failures",
      },
    ]);
  });
});
