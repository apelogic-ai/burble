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
  switch (event.type) {
    case "task_triggered":
      return applyTaskTriggered(state, event);
    case "validation_passed":
      return updateRun(state, event.jobRunId, event.at, (run) => ({
        ...run,
        status: "running",
      }));
    case "validation_failed":
      return applyRunFailure(state, event, {
        status: "failed",
        notificationPending: true,
      });
    case "attempt_started":
      return updateRun(state, event.jobRunId, event.at, (run) => ({
        ...run,
        status: "running",
        attempt: event.attempt,
        attemptMode: event.mode,
      }));
    case "attempt_failed":
      return applyRunFailure(state, event, {
        status: "failed",
        attempt: event.attempt,
        notificationPending: true,
      });
    case "attempt_succeeded":
      return updateRun(state, event.jobRunId, event.at, (run) => ({
        ...run,
        status: "delivering",
        attempt: event.attempt,
        outputDigest: event.outputDigest,
      }));
    case "delivery_started":
      return updateRun(state, event.jobRunId, event.at, (run) => ({
        ...run,
        status: "delivering",
        deliveryKey: event.deliveryKey,
      }));
    case "delivery_failed":
      return updateRun(state, event.jobRunId, event.at, (run) => ({
        ...run,
        status: "failed",
        deliveryKey: event.deliveryKey,
        failureClass: "delivery_failed",
        failureReason: event.reason,
        notificationPending: true,
      }));
    case "delivery_succeeded":
      return updateRun(state, event.jobRunId, event.at, (run) => ({
        ...run,
        status: "succeeded",
        deliveryKey: event.deliveryKey,
        notificationPending: false,
      }));
  }
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
