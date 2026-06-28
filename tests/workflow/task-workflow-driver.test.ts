import { describe, expect, test } from "bun:test";
import {
  runTaskWorkflowDriver,
  type TaskWorkflowDriverContext,
  type TaskWorkflowDriverHandlers,
} from "../../src/workflow/task-workflow-driver";

describe("task workflow driver", () => {
  test("drives validate, attempt, and delivery commands to success", async () => {
    const runNames: string[] = [];
    const ctx: TaskWorkflowDriverContext = {
      async run(name, fn) {
        runNames.push(name);
        return fn();
      },
    };
    const handlers: TaskWorkflowDriverHandlers = {
      validateTask: async (command) => ({
        type: "validation_passed",
        taskId: command.taskId,
        jobRunId: command.jobRunId,
        at: "2026-06-28T17:00:01.000Z",
      }),
      startAttempt: async (command) => ({
        type: "attempt_succeeded",
        taskId: command.taskId,
        jobRunId: command.jobRunId,
        attempt: command.attempt,
        outputDigest: "sha256:heart",
        at: "2026-06-28T17:00:02.000Z",
      }),
      deliverOutput: async (command) => [
        {
          type: "delivery_started",
          taskId: command.taskId,
          jobRunId: command.jobRunId,
          deliveryKey: "jobrun-1:route-1:sha256:heart",
          at: "2026-06-28T17:00:03.000Z",
        },
        {
          type: "delivery_succeeded",
          taskId: command.taskId,
          jobRunId: command.jobRunId,
          deliveryKey: "jobrun-1:route-1:sha256:heart",
          at: "2026-06-28T17:00:04.000Z",
        },
      ],
    };

    const result = await runTaskWorkflowDriver({
      initialEvent: {
        type: "task_triggered",
        taskId: "task-heart",
        jobRunId: "jobrun-1",
        triggerKey: "task-heart:manual:req-1",
        source: "manual",
        at: "2026-06-28T17:00:00.000Z",
      },
      handlers,
      ctx,
    });

    expect(result.state.runs["jobrun-1"]).toMatchObject({
      status: "succeeded",
      outputDigest: "sha256:heart",
      deliveryKey: "jobrun-1:route-1:sha256:heart",
    });
    expect(result.commands.map((command) => command.type)).toEqual([
      "validate_task",
      "start_attempt",
      "deliver_output",
    ]);
    expect(result.events.map((event) => event.type)).toEqual([
      "task_triggered",
      "validation_passed",
      "attempt_succeeded",
      "delivery_started",
      "delivery_succeeded",
    ]);
    expect(runNames).toEqual([
      "jobrun-1:validate_task",
      "jobrun-1:attempt:1",
      "jobrun-1:deliver:sha256:heart",
    ]);
  });

  test("feeds validation failures through notify and pause command handlers", async () => {
    const observedCommands: string[] = [];
    const result = await runTaskWorkflowDriver({
      initialEvent: {
        type: "task_triggered",
        taskId: "task-ai-news",
        jobRunId: "jobrun-1",
        triggerKey: "task-ai-news:slot:1",
        source: "schedule",
        at: "2026-06-28T17:00:00.000Z",
      },
      initialState: {
        failurePauseThreshold: 1,
        triggerKeys: {},
        failureCounts: {},
        tasks: {},
        runs: {},
      },
      handlers: {
        validateTask: async (command) => ({
          type: "validation_failed",
          taskId: command.taskId,
          jobRunId: command.jobRunId,
          failureClass: "invalid_grant",
          reason: "Missing required tool web_search",
          at: "2026-06-28T17:00:01.000Z",
        }),
        startAttempt: async () => null,
        deliverOutput: async () => null,
        notifyFailure: async (command) => {
          observedCommands.push(`${command.type}:${command.failureClass}`);
        },
        pauseTask: async (command) => {
          observedCommands.push(`${command.type}:${command.reason}`);
        },
      },
    });

    expect(result.state.tasks["task-ai-news"]).toEqual({
      status: "needs_repair",
      pausedReason: "Repeated invalid_grant failures",
    });
    expect(result.state.runs["jobrun-1"]).toMatchObject({
      status: "paused_after_failures",
      failureClass: "invalid_grant",
      notificationPending: true,
    });
    expect(observedCommands).toEqual([
      "notify_failure:invalid_grant",
      "pause_task:Repeated invalid_grant failures",
    ]);
  });

  test("records handler throws as workflow failure events", async () => {
    const observedCommands: string[] = [];
    const result = await runTaskWorkflowDriver({
      initialEvent: {
        type: "task_triggered",
        taskId: "task-heart",
        jobRunId: "jobrun-1",
        triggerKey: "task-heart:manual:req-1",
        source: "manual",
        at: "2026-06-28T17:00:00.000Z",
      },
      handlers: {
        validateTask: async (command) => ({
          type: "validation_passed",
          taskId: command.taskId,
          jobRunId: command.jobRunId,
          at: "2026-06-28T17:00:01.000Z",
        }),
        startAttempt: async () => {
          throw new Error("model provider timeout");
        },
        deliverOutput: async () => null,
        notifyFailure: async (command) => {
          observedCommands.push(`${command.type}:${command.failureClass}`);
        },
      },
    });

    expect(result.events.map((event) => event.type)).toEqual([
      "task_triggered",
      "validation_passed",
      "handler_failed",
    ]);
    expect(result.state.runs["jobrun-1"]).toMatchObject({
      status: "failed",
      failureClass: "handler_failed",
      failureReason: "model provider timeout",
      notificationPending: true,
    });
    expect(observedCommands).toEqual(["notify_failure:handler_failed"]);
  });

  test("records a workflow failure when maxCommands is exceeded", async () => {
    const result = await runTaskWorkflowDriver({
      maxCommands: 1,
      initialEvent: {
        type: "task_triggered",
        taskId: "task-loop",
        jobRunId: "jobrun-1",
        triggerKey: "task-loop:manual:req-1",
        source: "manual",
        at: "2026-06-28T17:00:00.000Z",
      },
      handlers: {
        validateTask: async (command) => ({
          type: "validation_passed",
          taskId: command.taskId,
          jobRunId: command.jobRunId,
          at: "2026-06-28T17:00:01.000Z",
        }),
        startAttempt: async () => null,
        deliverOutput: async () => null,
      },
    });

    expect(result.events.map((event) => event.type)).toEqual([
      "task_triggered",
      "validation_passed",
      "handler_failed",
    ]);
    expect(result.state.runs["jobrun-1"]).toMatchObject({
      status: "failed",
      failureClass: "handler_failed",
      failureReason: "Task workflow driver exceeded maxCommands=1",
    });
  });
});
