import { describe, expect, test } from "bun:test";
import {
  reduceTaskWorkflowEvents,
  type TaskWorkflowEvent,
  type TaskWorkflowState,
} from "../../src/workflow/task-workflow";
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
      async heartbeat() {
        return;
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
      "attempt_started",
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

  test("calls onEvent before reducing each workflow event", async () => {
    const observed: string[] = [];
    const result = await runTaskWorkflowDriver({
      initialEvent: {
        type: "task_triggered",
        taskId: "task-heart",
        jobRunId: "jobrun-1",
        triggerKey: "task-heart:manual:req-1",
        source: "manual",
        at: "2026-06-28T17:00:00.000Z",
      },
      onEvent: async (event) => {
        observed.push(event.type);
      },
      handlers: {
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
        deliverOutput: async (command) => ({
          type: "delivery_succeeded",
          taskId: command.taskId,
          jobRunId: command.jobRunId,
          deliveryKey: `${command.jobRunId}:route-1:${command.outputDigest}`,
          at: "2026-06-28T17:00:03.000Z",
        }),
      },
    });

    expect(observed).toEqual(result.events.map((event) => event.type));
    expect(observed).toContain("attempt_started");
  });

  test("drives a retryable attempt failure into the next bounded attempt", async () => {
    const startedAttempts: number[] = [];
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
        startAttempt: async (command) => {
          startedAttempts.push(command.attempt);
          if (command.attempt === 1) {
            return {
              type: "attempt_failed",
              taskId: command.taskId,
              jobRunId: command.jobRunId,
              attempt: command.attempt,
              failureClass: "runtime_timeout",
              reason: "model provider timed out",
              retryable: true,
              at: "2026-06-28T17:00:02.000Z",
            };
          }
          return {
            type: "attempt_succeeded",
            taskId: command.taskId,
            jobRunId: command.jobRunId,
            attempt: command.attempt,
            outputDigest: "sha256:heart",
            at: "2026-06-28T17:00:03.000Z",
          };
        },
        deliverOutput: async (command) => [
          {
            type: "delivery_started",
            taskId: command.taskId,
            jobRunId: command.jobRunId,
            deliveryKey: `${command.jobRunId}:route-1:${command.outputDigest}`,
            at: "2026-06-28T17:00:04.000Z",
          },
          {
            type: "delivery_succeeded",
            taskId: command.taskId,
            jobRunId: command.jobRunId,
            deliveryKey: `${command.jobRunId}:route-1:${command.outputDigest}`,
            at: "2026-06-28T17:00:05.000Z",
          },
        ],
      },
    });

    expect(startedAttempts).toEqual([1, 2]);
    expect(result.events.map((event) => event.type)).toEqual([
      "task_triggered",
      "validation_passed",
      "attempt_started",
      "attempt_failed",
      "attempt_started",
      "attempt_succeeded",
      "delivery_started",
      "delivery_succeeded",
    ]);
    expect(result.state.runs["jobrun-1"]).toMatchObject({
      status: "succeeded",
      attempt: 2,
      outputDigest: "sha256:heart",
    });
    expect(
      result.state.failureCounts["task-heart:runtime_timeout"],
    ).toBeUndefined();
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
        maxAttempts: 2,
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
      "attempt_started",
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

  test("lets command handlers emit workflow heartbeats", async () => {
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
        startAttempt: async (command, ctx) => {
          await ctx.heartbeat({
            taskId: command.taskId,
            jobRunId: command.jobRunId,
            at: "2026-06-28T17:00:02.500Z",
          });
          return {
            type: "attempt_succeeded",
            taskId: command.taskId,
            jobRunId: command.jobRunId,
            attempt: command.attempt,
            outputDigest: "sha256:heart",
            at: "2026-06-28T17:00:03.000Z",
          };
        },
        deliverOutput: async (command) => [
          {
            type: "delivery_started",
            taskId: command.taskId,
            jobRunId: command.jobRunId,
            deliveryKey: "jobrun-1:route-1:sha256:heart",
            at: "2026-06-28T17:00:04.000Z",
          },
          {
            type: "delivery_succeeded",
            taskId: command.taskId,
            jobRunId: command.jobRunId,
            deliveryKey: "jobrun-1:route-1:sha256:heart",
            at: "2026-06-28T17:00:05.000Z",
          },
        ],
      },
    });

    expect(result.events.map((event) => event.type)).toContain("run_heartbeat");
    expect(result.state.runs["jobrun-1"]).toMatchObject({
      status: "succeeded",
      heartbeatAt: "2026-06-28T17:00:02.500Z",
    });
  });

  test("fails when an attempt handler returns a mismatched attempt", async () => {
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
        startAttempt: async (command) => ({
          type: "attempt_succeeded",
          taskId: command.taskId,
          jobRunId: command.jobRunId,
          attempt: command.attempt + 1,
          outputDigest: "sha256:heart",
          at: "2026-06-28T17:00:03.000Z",
        }),
        deliverOutput: async () => null,
      },
    });

    expect(result.events.map((event) => event.type)).toEqual([
      "task_triggered",
      "validation_passed",
      "attempt_started",
      "handler_failed",
    ]);
    expect(result.state.runs["jobrun-1"]).toMatchObject({
      status: "failed",
      failureClass: "handler_failed",
      failureReason:
        "Workflow start_attempt handler returned attempt_succeeded for attempt 2, expected attempt 1.",
    });
  });

  test("records notify handler throws as side-effect failures", async () => {
    const result = await runTaskWorkflowDriver({
      initialEvent: {
        type: "task_triggered",
        taskId: "task-ai-news",
        jobRunId: "jobrun-1",
        triggerKey: "task-ai-news:manual:req-1",
        source: "manual",
        at: "2026-06-28T17:00:00.000Z",
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
        notifyFailure: async () => {
          throw new Error("Slack post failed");
        },
      },
    });

    expect(result.events.map((event) => event.type)).toEqual([
      "task_triggered",
      "validation_failed",
      "side_effect_failed",
    ]);
    expect(Object.values(result.state.sideEffectFailures ?? {})).toMatchObject([
      {
        taskId: "task-ai-news",
        jobRunId: "jobrun-1",
        commandType: "notify_failure",
        failureClass: "invalid_grant",
        reason: "Slack post failed",
      },
    ]);
  });

  test("records pause handler throws as side-effect failures", async () => {
    const result = await runTaskWorkflowDriver({
      initialEvent: {
        type: "task_triggered",
        taskId: "task-ai-news",
        jobRunId: "jobrun-1",
        triggerKey: "task-ai-news:manual:req-1",
        source: "manual",
        at: "2026-06-28T17:00:00.000Z",
      },
      initialState: {
        failurePauseThreshold: 1,
        maxAttempts: 2,
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
        notifyFailure: async () => null,
        pauseTask: async () => {
          throw new Error("Pause API unavailable");
        },
      },
    });

    expect(result.state.tasks["task-ai-news"]).toEqual({
      status: "needs_repair",
      pausedReason: "Repeated invalid_grant failures",
    });
    expect(Object.values(result.state.sideEffectFailures ?? {})).toMatchObject([
      {
        taskId: "task-ai-news",
        commandType: "pause_task",
        reason: "Pause API unavailable",
      },
    ]);
  });

  test("records a workflow failure when maxCommands is exceeded", async () => {
    const events: TaskWorkflowEvent[] = [];

    await expect(
      runTaskWorkflowDriver({
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
        onEvent: (event) => {
          events.push(event);
        },
      }),
    ).rejects.toThrow("Task workflow driver exceeded maxCommands=1");

    expect(events.map((event) => event.type)).toEqual([
      "task_triggered",
      "validation_passed",
      "handler_failed",
    ]);
    expect(reduceTaskWorkflowEvents(events).runs["jobrun-1"]).toMatchObject({
      status: "failed",
      failureClass: "handler_failed",
      failureReason: "Task workflow driver exceeded maxCommands=1",
    });
  });

  test("throws when maxCommands is exceeded before a retry attempt starts", async () => {
    const events: TaskWorkflowEvent[] = [];
    const initialState: TaskWorkflowState = {
      failurePauseThreshold: 3,
      maxAttempts: 3,
      triggerKeys: {},
      failureCounts: {},
      tasks: {},
      runs: {},
    };

    await expect(
      runTaskWorkflowDriver({
        maxCommands: 2,
        initialState,
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
          startAttempt: async (command) => ({
            type: "attempt_failed",
            taskId: command.taskId,
            jobRunId: command.jobRunId,
            attempt: command.attempt,
            failureClass: "runtime_failed",
            reason: "runtime timeout",
            retryable: true,
            at: "2026-06-28T17:00:02.000Z",
          }),
          deliverOutput: async () => null,
        },
        onEvent: (event) => {
          events.push(event);
        },
      }),
    ).rejects.toThrow("Task workflow driver exceeded maxCommands=2");

    expect(events.map((event) => event.type)).toEqual([
      "task_triggered",
      "validation_passed",
      "attempt_started",
      "attempt_failed",
      "handler_failed",
    ]);
    expect(
      reduceTaskWorkflowEvents(events, initialState).runs["jobrun-1"],
    ).toMatchObject({
      status: "running",
      attempt: 1,
    });
  });
});
