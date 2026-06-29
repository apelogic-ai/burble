export type TaskWorkflowTriggerSource = "schedule" | "manual";

// The workflow FSM is feature-flagged authority for scheduler runs. Default
// production execution still uses the legacy scheduler path until rollout
// explicitly flips this marker.
export const TASK_WORKFLOW_PRODUCTION_WIRED = false;

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

export const TASK_WORKFLOW_AGENT_ATTEMPT_MODE: TaskWorkflowAttemptMode =
  "agent";
export const TASK_WORKFLOW_RUNTIME_FAILURE_CLASS = "runtime_failed";
export const TASK_WORKFLOW_VALIDATION_FAILURE_CLASS = "validation_failed";
export const DEFAULT_TASK_WORKFLOW_MAX_ATTEMPTS = 2;

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
      retryable?: boolean;
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
      type: "run_heartbeat";
      taskId: string;
      jobRunId: string;
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
      deliveryKey?: string;
      failureClass?: string;
      reason: string;
      at: string;
    }
  | {
      type: "delivery_succeeded";
      taskId: string;
      jobRunId: string;
      deliveryKey: string;
      at: string;
    }
  | {
      type: "handler_failed";
      taskId: string;
      jobRunId: string;
      commandType: Exclude<
        TaskWorkflowCommand["type"],
        "notify_failure" | "pause_task"
      >;
      failureClass: "handler_failed";
      reason: string;
      at: string;
      attempt?: number;
      outputDigest?: string;
    }
  | {
      type: "side_effect_failed";
      taskId: string;
      commandType: Extract<
        TaskWorkflowCommand["type"],
        "notify_failure" | "pause_task"
      >;
      reason: string;
      at: string;
      jobRunId?: string;
      failureClass?: string;
    }
  | {
      type: "side_effect_failure_acknowledged";
      failureId: string;
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
  heartbeatAt?: string;
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

export type TaskWorkflowSideEffectFailure = {
  taskId: string;
  commandType: Extract<
    TaskWorkflowCommand["type"],
    "notify_failure" | "pause_task"
  >;
  reason: string;
  at: string;
  jobRunId?: string;
  failureClass?: string;
};

export type TaskWorkflowState = {
  failurePauseThreshold: number;
  maxAttempts: number;
  triggerKeys: Record<string, string>;
  failureCounts: Record<string, number>;
  sideEffectFailures?: Record<string, TaskWorkflowSideEffectFailure>;
  tasks: Record<string, TaskWorkflowTaskState>;
  runs: Record<string, TaskWorkflowRunState>;
};

type TaskWorkflowFailureInput = {
  taskId: string;
  jobRunId: string;
  failureClass: string;
  reason: string;
  at: string;
};

export function createInitialTaskWorkflowState(input?: {
  failurePauseThreshold?: number;
  maxAttempts?: number;
}): TaskWorkflowState {
  return {
    failurePauseThreshold: input?.failurePauseThreshold ?? 3,
    maxAttempts: input?.maxAttempts ?? DEFAULT_TASK_WORKFLOW_MAX_ATTEMPTS,
    triggerKeys: {},
    failureCounts: {},
    sideEffectFailures: {},
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
      return transitionAttemptFailure(state, event);
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
    case "run_heartbeat":
      if (!canHeartbeatRun(state, event.jobRunId)) {
        return withCommands(state, []);
      }
      return withCommands(
        updateRun(state, event.jobRunId, event.at, (run) => ({
          ...run,
          heartbeatAt: event.at,
        })),
        [],
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
      if (!canFailDelivery(state, event.jobRunId, event.deliveryKey)) {
        return withCommands(state, []);
      }
      return transitionRunFailure(
        state,
        {
          ...event,
          failureClass: event.failureClass ?? "delivery_failed",
        },
        {
          status: "failed",
          deliveryKey: event.deliveryKey,
          notificationPending: true,
        },
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
    case "handler_failed":
      if (!canApplyHandlerFailure(state, event)) {
        return withCommands(state, []);
      }
      return transitionRunFailure(state, event, {
        status: "failed",
        attempt: event.attempt,
        notificationPending: true,
      });
    case "side_effect_failed":
      return withCommands(recordSideEffectFailure(state, event), []);
    case "side_effect_failure_acknowledged":
      return withCommands(acknowledgeSideEffectFailure(state, event), []);
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
  return Boolean(run && run.status === "running" && run.attempt === attempt);
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

function canHeartbeatRun(state: TaskWorkflowState, jobRunId: string): boolean {
  const run = state.runs[jobRunId];
  return Boolean(
    run &&
    (run.status === "validating" ||
      run.status === "running" ||
      run.status === "delivering"),
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

function canFailDelivery(
  state: TaskWorkflowState,
  jobRunId: string,
  deliveryKey: string | undefined,
): boolean {
  const run = state.runs[jobRunId];
  return Boolean(
    run &&
    run.status === "delivering" &&
    (deliveryKey === undefined ||
      run.deliveryKey === undefined ||
      run.deliveryKey === deliveryKey),
  );
}

function canApplyHandlerFailure(
  state: TaskWorkflowState,
  event: Extract<TaskWorkflowEvent, { type: "handler_failed" }>,
): boolean {
  switch (event.commandType) {
    case "validate_task":
      return canValidateRun(state, event.jobRunId);
    case "start_attempt":
      return canFailStartAttempt(state, event.jobRunId, event.attempt ?? 1);
    case "deliver_output": {
      const run = state.runs[event.jobRunId];
      return Boolean(run && run.status === "delivering");
    }
  }
}

function canFailStartAttempt(
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
  event: TaskWorkflowFailureInput,
  failure: Pick<
    TaskWorkflowRunState,
    "status" | "attempt" | "deliveryKey" | "notificationPending"
  >,
): TaskWorkflowTransitionResult {
  const shouldPause =
    failureCountsTowardPause(event.failureClass) &&
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

function transitionAttemptFailure(
  state: TaskWorkflowState,
  event: Extract<TaskWorkflowEvent, { type: "attempt_failed" }>,
): TaskWorkflowTransitionResult {
  if (shouldRetryAttemptFailure(state, event)) {
    const run = state.runs[event.jobRunId];
    const nextAttempt = event.attempt + 1;
    return withCommands(
      updateRun(state, event.jobRunId, event.at, (currentRun) => ({
        ...currentRun,
        status: "running",
        attempt: event.attempt,
        failureClass: event.failureClass,
        failureReason: event.reason,
        notificationPending: false,
      })),
      run
        ? [
            {
              type: "start_attempt",
              taskId: event.taskId,
              jobRunId: event.jobRunId,
              attempt: nextAttempt,
              mode: run.attemptMode ?? TASK_WORKFLOW_AGENT_ATTEMPT_MODE,
            },
          ]
        : [],
    );
  }

  return transitionRunFailure(state, event, {
    status: "failed",
    attempt: event.attempt,
    notificationPending: true,
  });
}

function shouldRetryAttemptFailure(
  state: TaskWorkflowState,
  event: Extract<TaskWorkflowEvent, { type: "attempt_failed" }>,
): boolean {
  return event.retryable === true && event.attempt < maxWorkflowAttempts(state);
}

function maxWorkflowAttempts(state: TaskWorkflowState): number {
  return state.maxAttempts ?? DEFAULT_TASK_WORKFLOW_MAX_ATTEMPTS;
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
  event: TaskWorkflowFailureInput,
  failure: Pick<
    TaskWorkflowRunState,
    "status" | "attempt" | "deliveryKey" | "notificationPending"
  >,
): TaskWorkflowState {
  const failureKey = `${event.taskId}:${event.failureClass}`;
  const shouldCount = failureCountsTowardPause(event.failureClass);
  const failureCount = shouldCount
    ? (state.failureCounts[failureKey] ?? 0) + 1
    : (state.failureCounts[failureKey] ?? 0);
  const shouldPause =
    shouldCount && failureCount >= state.failurePauseThreshold;
  const nextState = updateRun(state, event.jobRunId, event.at, (run) => ({
    ...run,
    ...failure,
    status: shouldPause ? "paused_after_failures" : failure.status,
    failureClass: event.failureClass,
    failureReason: event.reason,
  }));

  return {
    ...nextState,
    failureCounts: shouldCount
      ? {
          ...nextState.failureCounts,
          [failureKey]: failureCount,
        }
      : nextState.failureCounts,
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

function failureCountsTowardPause(failureClass: string): boolean {
  return !failureClass.startsWith("stale_");
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

function recordSideEffectFailure(
  state: TaskWorkflowState,
  event: Extract<TaskWorkflowEvent, { type: "side_effect_failed" }>,
): TaskWorkflowState {
  const key = [
    event.commandType,
    event.taskId,
    event.jobRunId ?? "task",
    event.failureClass ?? "none",
    event.at,
  ].join(":");
  return {
    ...state,
    sideEffectFailures: {
      ...(state.sideEffectFailures ?? {}),
      [key]: {
        taskId: event.taskId,
        commandType: event.commandType,
        reason: event.reason,
        at: event.at,
        ...(event.jobRunId ? { jobRunId: event.jobRunId } : {}),
        ...(event.failureClass ? { failureClass: event.failureClass } : {}),
      },
    },
  };
}

function acknowledgeSideEffectFailure(
  state: TaskWorkflowState,
  event: Extract<
    TaskWorkflowEvent,
    { type: "side_effect_failure_acknowledged" }
  >,
): TaskWorkflowState {
  if (!state.sideEffectFailures?.[event.failureId]) {
    return state;
  }

  const nextFailures = { ...state.sideEffectFailures };
  delete nextFailures[event.failureId];
  return {
    ...state,
    sideEffectFailures: nextFailures,
  };
}
