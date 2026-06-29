import {
  type TaskWorkflowCommand,
  type TaskWorkflowEvent,
  type TaskWorkflowState,
  createInitialTaskWorkflowState,
  transitionTaskWorkflowEvent,
} from "./task-workflow";

export type TaskWorkflowDriverCommandResult =
  TaskWorkflowEvent | TaskWorkflowEvent[] | null | undefined | void;

export type TaskWorkflowDriverContext = {
  run<T>(name: string, fn: () => Promise<T>): Promise<T>;
  heartbeat(input: {
    taskId: string;
    jobRunId: string;
    at?: string;
  }): Promise<void>;
};

export type TaskWorkflowDriverHandlers = {
  validateTask(
    command: Extract<TaskWorkflowCommand, { type: "validate_task" }>,
    ctx: TaskWorkflowDriverContext,
  ): Promise<TaskWorkflowDriverCommandResult>;
  startAttempt(
    command: Extract<TaskWorkflowCommand, { type: "start_attempt" }>,
    ctx: TaskWorkflowDriverContext,
  ): Promise<TaskWorkflowDriverCommandResult>;
  deliverOutput(
    command: Extract<TaskWorkflowCommand, { type: "deliver_output" }>,
    ctx: TaskWorkflowDriverContext,
  ): Promise<TaskWorkflowDriverCommandResult>;
  notifyFailure?(
    command: Extract<TaskWorkflowCommand, { type: "notify_failure" }>,
    ctx: TaskWorkflowDriverContext,
  ): Promise<TaskWorkflowDriverCommandResult>;
  pauseTask?(
    command: Extract<TaskWorkflowCommand, { type: "pause_task" }>,
    ctx: TaskWorkflowDriverContext,
  ): Promise<TaskWorkflowDriverCommandResult>;
};

export type RunTaskWorkflowDriverResult = {
  state: TaskWorkflowState;
  events: TaskWorkflowEvent[];
  commands: TaskWorkflowCommand[];
};

export async function runTaskWorkflowDriver(input: {
  initialEvent: TaskWorkflowEvent;
  initialState?: TaskWorkflowState;
  handlers: TaskWorkflowDriverHandlers;
  ctx?: TaskWorkflowDriverContext;
  maxCommands?: number;
}): Promise<RunTaskWorkflowDriverResult> {
  const baseCtx = input.ctx ?? createInProcessWorkflowDriverContext();
  const maxCommands = input.maxCommands ?? 100;
  const events: TaskWorkflowEvent[] = [];
  const commands: TaskWorkflowCommand[] = [];
  const pendingCommands: TaskWorkflowCommand[] = [];
  let state = input.initialState ?? createInitialTaskWorkflowState();

  const applyEvent = (event: TaskWorkflowEvent): void => {
    const transition = transitionTaskWorkflowEvent(state, event);
    state = transition.state;
    events.push(event);
    commands.push(...transition.commands);
    pendingCommands.push(...transition.commands);
  };

  const ctx: TaskWorkflowDriverContext = {
    run: baseCtx.run.bind(baseCtx),
    async heartbeat(heartbeatInput) {
      applyEvent({
        type: "run_heartbeat",
        taskId: heartbeatInput.taskId,
        jobRunId: heartbeatInput.jobRunId,
        at: heartbeatInput.at ?? new Date().toISOString(),
      });
    },
  };

  applyEvent(input.initialEvent);

  let executedCommands = 0;
  while (pendingCommands.length > 0) {
    const command = pendingCommands.shift();
    if (!command) {
      continue;
    }

    if (executedCommands >= maxCommands) {
      const event = commandHandlerFailedEvent(
        command,
        new Error(`Task workflow driver exceeded maxCommands=${maxCommands}`),
      );
      if (event) {
        applyEvent(event);
      }
      break;
    }
    executedCommands += 1;

    const startedEvent = commandStartedEvent(command);
    if (startedEvent) {
      applyEvent(startedEvent);
    }

    const result = await executeCommand(command, input.handlers, ctx);
    for (const event of normalizeCommandResult(result)) {
      applyEvent(event);
    }
  }

  return { state, events, commands };
}

export function createInProcessWorkflowDriverContext(): TaskWorkflowDriverContext {
  return {
    async run<T>(_name: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    async heartbeat(): Promise<void> {
      return;
    },
  };
}

function normalizeCommandResult(
  result: TaskWorkflowDriverCommandResult,
): TaskWorkflowEvent[] {
  if (!result) {
    return [];
  }
  return Array.isArray(result) ? result : [result];
}

async function executeCommand(
  command: TaskWorkflowCommand,
  handlers: TaskWorkflowDriverHandlers,
  ctx: TaskWorkflowDriverContext,
): Promise<TaskWorkflowDriverCommandResult> {
  try {
    return await ctx.run(commandRunName(command), async () => {
      switch (command.type) {
        case "validate_task":
          return handlers.validateTask(command, ctx);
        case "start_attempt":
          return handlers.startAttempt(command, ctx);
        case "deliver_output":
          return handlers.deliverOutput(command, ctx);
        case "notify_failure":
          return handlers.notifyFailure?.(command, ctx);
        case "pause_task":
          return handlers.pauseTask?.(command, ctx);
      }
    });
  } catch (error) {
    return commandHandlerFailedEvent(command, error);
  }
}

function commandStartedEvent(
  command: TaskWorkflowCommand,
): TaskWorkflowEvent | null {
  if (command.type !== "start_attempt") {
    return null;
  }
  return {
    type: "attempt_started",
    taskId: command.taskId,
    jobRunId: command.jobRunId,
    attempt: command.attempt,
    mode: command.mode,
    at: new Date().toISOString(),
  };
}

function commandRunName(command: TaskWorkflowCommand): string {
  switch (command.type) {
    case "validate_task":
      return `${command.jobRunId}:validate_task`;
    case "start_attempt":
      return `${command.jobRunId}:attempt:${command.attempt}`;
    case "deliver_output":
      return `${command.jobRunId}:deliver:${command.outputDigest}`;
    case "notify_failure":
      return `${command.jobRunId}:notify_failure:${command.failureClass}`;
    case "pause_task":
      return `${command.taskId}:pause_task`;
  }
}

function commandHandlerFailedEvent(
  command: TaskWorkflowCommand,
  error: unknown,
): TaskWorkflowEvent {
  if (command.type === "notify_failure") {
    return {
      type: "side_effect_failed",
      taskId: command.taskId,
      jobRunId: command.jobRunId,
      commandType: command.type,
      failureClass: command.failureClass,
      reason: errorMessage(error),
      at: new Date().toISOString(),
    };
  }

  if (command.type === "pause_task") {
    return {
      type: "side_effect_failed",
      taskId: command.taskId,
      commandType: command.type,
      reason: errorMessage(error),
      at: new Date().toISOString(),
    };
  }

  const event: TaskWorkflowEvent = {
    type: "handler_failed",
    taskId: command.taskId,
    jobRunId: command.jobRunId,
    commandType: command.type,
    failureClass: "handler_failed",
    reason: errorMessage(error),
    at: new Date().toISOString(),
    ...(command.type === "start_attempt" ? { attempt: command.attempt } : {}),
    ...(command.type === "deliver_output"
      ? { outputDigest: command.outputDigest }
      : {}),
  };
  return event;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}
