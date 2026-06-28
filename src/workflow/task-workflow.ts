export type TaskWorkflowTriggerSource = "schedule" | "manual";

export type TaskWorkflowRunStatus =
  | "created"
  | "validating"
  | "running"
  | "delivering"
  | "succeeded"
  | "failed"
  | "paused_after_failures";

export type TaskWorkflowTaskStatus = "active" | "needs_repair";

export type TaskWorkflowAttemptMode =
  "provider" | "transform" | "model" | "agent";

export type TaskWorkflowCommand =
  | {
      type: "validate_task";
      taskId: string;
      jobRunId: string;
    }
  | {
      type: "start_attempt";
      taskId: string;
      jobRunId: string;
      attempt: number;
      mode: TaskWorkflowAttemptMode;
    }
  | {
      type: "deliver_output";
      taskId: string;
      jobRunId: string;
      outputDigest: string;
    }
  | {
      type: "notify_failure";
      taskId: string;
      jobRunId: string;
      failureClass: string;
      reason: string;
    }
  | {
      type: "pause_task";
      taskId: string;
      reason: string;
    };

export type TaskWorkflowEvent =
  | {
      type: "task_triggered";
      taskId: string;
      jobRunId: string;
      triggerKey: string;
      source: TaskWorkflowTriggerSource;
      at: string;
    }
  | {
      type: "validation_passed";
      taskId: string;
      jobRunId: string;
      at: string;
    }
  | {
      type: "validation_failed";
      taskId: string;
      jobRunId: string;
      failureClass: string;
      reason: string;
      at: string;
    }
  | {
      type: "attempt_started";
      taskId: string;
      jobRunId: string;
      attempt: number;
      mode: TaskWorkflowAttemptMode;
      at: string;
    }
  | {
      type: "attempt_failed";
      taskId: string;
      jobRunId: string;
      attempt: number;
      failureClass: string;
      reason: string;
      at: string;
    }
  | {
      type: "attempt_succeeded";
      taskId: string;
      jobRunId: string;
      attempt: number;
      outputDigest: string;
      at: string;
    }
  | {
      type: "delivery_started";
      taskId: string;
      jobRunId: string;
      deliveryKey: string;
      at: string;
    }
  | {
      type: "delivery_failed";
      taskId: string;
      jobRunId: string;
      deliveryKey: string;
      reason: string;
      at: string;
    }
  | {
      type: "delivery_succeeded";
      taskId: string;
      jobRunId: string;
      deliveryKey: string;
      at: string;
    };

export type TaskWorkflowRunState = {
  taskId: string;
  jobRunId: string;
  triggerKey: string;
  source: TaskWorkflowTriggerSource;
  status: TaskWorkflowRunStatus;
  createdAt: string;
  updatedAt: string;
  attempt?: number;
  attemptMode?: TaskWorkflowAttemptMode;
  outputDigest?: string;
  deliveryKey?: string;
  failureClass?: string;
  failureReason?: string;
  notificationPending?: boolean;
};

export type TaskWorkflowTaskState = {
  status: TaskWorkflowTaskStatus;
  pausedReason?: string;
};

export type TaskWorkflowState = {
  failurePauseThreshold: number;
  triggerKeys: Record<string, string>;
  failureCounts: Record<string, number>;
  tasks: Record<string, TaskWorkflowTaskState>;
  runs: Record<string, TaskWorkflowRunState>;
};

export function createInitialTaskWorkflowState(input?: {
  failurePauseThreshold?: number;
}): TaskWorkflowState {
  return {
    failurePauseThreshold: input?.failurePauseThreshold ?? 3,
    triggerKeys: {},
    failureCounts: {},
    tasks: {},
    runs: {},
  };
}

export function reduceTaskWorkflowEvents(
  events: TaskWorkflowEvent[],
  initialState: TaskWorkflowState = createInitialTaskWorkflowState(),
): TaskWorkflowState {
  return events.reduce(applyTaskWorkflowEvent, initialState);
}

export function applyTaskWorkflowEvent(
  state: TaskWorkflowState,
  event: TaskWorkflowEvent,
): TaskWorkflowState {
  return transitionTaskWorkflowEvent(state, event).state;
}

export type TaskWorkflowTransitionResult = {
  state: TaskWorkflowState;
  commands: TaskWorkflowCommand[];
};

export function transitionTaskWorkflowEvent(
  state: TaskWorkflowState,
  event: TaskWorkflowEvent,
): TaskWorkflowTransitionResult {
  switch (event.type) {
    case "task_triggered":
      return transitionTaskTriggered(state, event);
    case "validation_passed":
      if (!canValidateRun(state, event.jobRunId)) {
        return withCommands(state, []);
      }
      return withCommands(
        updateRun(state, event.jobRunId, event.at, (run) => ({
          ...run,
          status: "running",
        })),
        runExists(state, event.jobRunId)
          ? [
              {
                type: "start_attempt",
                taskId: event.taskId,
                jobRunId: event.jobRunId,
                attempt: 1,
                mode: "agent",
              },
            ]
          : [],
      );
    case "validation_failed":
      if (!canValidateRun(state, event.jobRunId)) {
        return withCommands(state, []);
      }
      return transitionRunFailure(state, event, {
        status: "failed",
        notificationPending: true,
      });
    case "attempt_started":
      if (!canStartAttempt(state, event.jobRunId, event.attempt)) {
        return withCommands(state, []);
      }
      return withCommands(
        updateRun(state, event.jobRunId, event.at, (run) => ({
          ...run,
          status: "running",
          attempt: event.attempt,
          attemptMode: event.mode,
        })),
        [],
      );
    case "attempt_failed":
      if (!canFinishAttempt(state, event.jobRunId, event.attempt)) {
        return withCommands(state, []);
      }
      return transitionRunFailure(state, event, {
        status: "failed",
        attempt: event.attempt,
        notificationPending: true,
      });
    case "attempt_succeeded":
      if (!canFinishAttempt(state, event.jobRunId, event.attempt)) {
        return withCommands(state, []);
      }
      return withCommands(
        updateRun(state, event.jobRunId, event.at, (run) => ({
          ...run,
          status: "delivering",
          attempt: event.attempt,
          outputDigest: event.outputDigest,
        })),
        runExists(state, event.jobRunId)
          ? [
              {
                type: "deliver_output",
                taskId: event.taskId,
                jobRunId: event.jobRunId,
                outputDigest: event.outputDigest,
              },
            ]
          : [],
      );
    case "delivery_started":
      if (!canStartDelivery(state, event.jobRunId, event.deliveryKey)) {
        return withCommands(state, []);
      }
      return withCommands(
        updateRun(state, event.jobRunId, event.at, (run) => ({
          ...run,
          status: "delivering",
          deliveryKey: event.deliveryKey,
        })),
        [],
      );
    case "delivery_failed":
      if (!canFinishDelivery(state, event.jobRunId, event.deliveryKey)) {
        return withCommands(state, []);
      }
      return withCommands(
        updateRun(state, event.jobRunId, event.at, (run) => ({
          ...run,
          status: "failed",
          deliveryKey: event.deliveryKey,
          failureClass: "delivery_failed",
          failureReason: event.reason,
          notificationPending: true,
        })),
        runExists(state, event.jobRunId)
          ? [
              {
                type: "notify_failure",
                taskId: event.taskId,
                jobRunId: event.jobRunId,
                failureClass: "delivery_failed",
                reason: event.reason,
              },
            ]
          : [],
      );
    case "delivery_succeeded":
      if (!canFinishDelivery(state, event.jobRunId, event.deliveryKey)) {
        return withCommands(state, []);
      }
      return withCommands(
        updateRun(state, event.jobRunId, event.at, (run) => ({
          ...run,
          status: "succeeded",
          deliveryKey: event.deliveryKey,
          notificationPending: false,
        })),
        [],
      );
  }
}

function withCommands(
  state: TaskWorkflowState,
  commands: TaskWorkflowCommand[],
): TaskWorkflowTransitionResult {
  return { state, commands };
}

function canValidateRun(state: TaskWorkflowState, jobRunId: string): boolean {
  const run = state.runs[jobRunId];
  return Boolean(
    run && (run.status === "created" || run.status === "validating"),
  );
}

function canStartAttempt(
  state: TaskWorkflowState,
  jobRunId: string,
  attempt: number,
): boolean {
  const run = state.runs[jobRunId];
  return Boolean(
    run &&
    run.status === "running" &&
    (run.attempt === undefined || run.attempt < attempt),
  );
}

function canFinishAttempt(
  state: TaskWorkflowState,
  jobRunId: string,
  attempt: number,
): boolean {
  const run = state.runs[jobRunId];
  return Boolean(
    run &&
    run.status === "running" &&
    (run.attempt === undefined || run.attempt === attempt),
  );
}

function canStartDelivery(
  state: TaskWorkflowState,
  jobRunId: string,
  deliveryKey: string,
): boolean {
  const run = state.runs[jobRunId];
  return Boolean(
    run &&
    run.status === "delivering" &&
    (run.deliveryKey === undefined || run.deliveryKey === deliveryKey),
  );
}

function canFinishDelivery(
  state: TaskWorkflowState,
  jobRunId: string,
  deliveryKey: string,
): boolean {
  const run = state.runs[jobRunId];
  return Boolean(
    run && run.status === "delivering" && run.deliveryKey === deliveryKey,
  );
}

function transitionTaskTriggered(
  state: TaskWorkflowState,
  event: Extract<TaskWorkflowEvent, { type: "task_triggered" }>,
): TaskWorkflowTransitionResult {
  if (state.triggerKeys[event.triggerKey]) {
    return withCommands(state, []);
  }

  return withCommands(applyTaskTriggered(state, event), [
    {
      type: "validate_task",
      taskId: event.taskId,
      jobRunId: event.jobRunId,
    },
  ]);
}

function transitionRunFailure(
  state: TaskWorkflowState,
  event: Extract<
    TaskWorkflowEvent,
    { type: "validation_failed" | "attempt_failed" }
  >,
  failure: Pick<
    TaskWorkflowRunState,
    "status" | "attempt" | "notificationPending"
  >,
): TaskWorkflowTransitionResult {
  const shouldPause =
    (state.failureCounts[`${event.taskId}:${event.failureClass}`] ?? 0) + 1 >=
    state.failurePauseThreshold;
  const nextState = applyRunFailure(state, event, failure);
  if (!runExists(state, event.jobRunId)) {
    return withCommands(nextState, []);
  }

  const commands: TaskWorkflowCommand[] = [
    {
      type: "notify_failure",
      taskId: event.taskId,
      jobRunId: event.jobRunId,
      failureClass: event.failureClass,
      reason: event.reason,
    },
  ];
  if (shouldPause) {
    commands.push({
      type: "pause_task",
      taskId: event.taskId,
      reason: `Repeated ${event.failureClass} failures`,
    });
  }
  return withCommands(nextState, commands);
}

function applyTaskTriggered(
  state: TaskWorkflowState,
  event: Extract<TaskWorkflowEvent, { type: "task_triggered" }>,
): TaskWorkflowState {
  if (state.triggerKeys[event.triggerKey]) {
    return state;
  }

  return {
    ...state,
    triggerKeys: {
      ...state.triggerKeys,
      [event.triggerKey]: event.jobRunId,
    },
    tasks: {
      ...state.tasks,
      [event.taskId]: state.tasks[event.taskId] ?? { status: "active" },
    },
    runs: {
      ...state.runs,
      [event.jobRunId]: {
        taskId: event.taskId,
        jobRunId: event.jobRunId,
        triggerKey: event.triggerKey,
        source: event.source,
        status: "created",
        createdAt: event.at,
        updatedAt: event.at,
      },
    },
  };
}

function runExists(state: TaskWorkflowState, jobRunId: string): boolean {
  return Boolean(state.runs[jobRunId]);
}

function applyRunFailure(
  state: TaskWorkflowState,
  event: Extract<
    TaskWorkflowEvent,
    { type: "validation_failed" | "attempt_failed" }
  >,
  failure: Pick<
    TaskWorkflowRunState,
    "status" | "attempt" | "notificationPending"
  >,
): TaskWorkflowState {
  const failureKey = `${event.taskId}:${event.failureClass}`;
  const failureCount = (state.failureCounts[failureKey] ?? 0) + 1;
  const shouldPause = failureCount >= state.failurePauseThreshold;
  const nextState = updateRun(state, event.jobRunId, event.at, (run) => ({
    ...run,
    ...failure,
    status: shouldPause ? "paused_after_failures" : failure.status,
    failureClass: event.failureClass,
    failureReason: event.reason,
  }));

  return {
    ...nextState,
    failureCounts: {
      ...nextState.failureCounts,
      [failureKey]: failureCount,
    },
    tasks: {
      ...nextState.tasks,
      [event.taskId]: shouldPause
        ? {
            status: "needs_repair",
            pausedReason: `Repeated ${event.failureClass} failures`,
          }
        : (nextState.tasks[event.taskId] ?? { status: "active" }),
    },
  };
}

function updateRun(
  state: TaskWorkflowState,
  jobRunId: string,
  at: string,
  update: (run: TaskWorkflowRunState) => TaskWorkflowRunState,
): TaskWorkflowState {
  const run = state.runs[jobRunId];
  if (!run) {
    return state;
  }
  return {
    ...state,
    runs: {
      ...state.runs,
      [jobRunId]: {
        ...update(run),
        updatedAt: at,
      },
    },
  };
}
