import type { Config } from "../config";
import type { ScheduledJobRecord, TokenStore } from "../db";
import { validateManagedRuntimeAgentInput } from "../agent/runners/managed-runtime";
import type {
  SchedulerTaskGrant,
  SchedulerTaskRuntimeAdmission,
} from "./task-validation";
import { buildScheduledRunAdmissionAgentInput } from "./run-executor";

type ScheduledRuntimeAdmissionStore = Pick<
  TokenStore,
  | "getAgentJobCapability"
  | "getConversationRoute"
  | "getConnectionForSlackUser"
  | "getScheduledJob"
>;

export type ScheduledRuntimeAdmissionValidator = (input: {
  workspaceId: string;
  slackUserId: string;
  job: ScheduledJobRecord;
  capability: SchedulerTaskGrant | null;
}) => Promise<SchedulerTaskRuntimeAdmission>;

export function createScheduledRuntimeAdmissionValidator(input: {
  config: Config;
  store: ScheduledRuntimeAdmissionStore;
  logWarn?: (message: string) => void;
}): ScheduledRuntimeAdmissionValidator | undefined {
  if (
    input.config.agentMode !== "llm" ||
    input.config.agentRuntime !== "burble-runtime"
  ) {
    return undefined;
  }

  return async (validationInput) => {
    try {
      const result = await validateManagedRuntimeAgentInput(
        {
          config: input.config,
          ...(input.config.managedRuntimeUrl
            ? { baseUrl: input.config.managedRuntimeUrl }
            : {}),
        },
        buildScheduledRunAdmissionAgentInput({
          store: input.store,
          job: validationInput.job,
          workspaceId: validationInput.workspaceId,
          slackUserId: validationInput.slackUserId,
        }),
      );
      return result;
    } catch (error) {
      const reason =
        error instanceof Error
          ? error.message
          : "Runtime admission validation failed";
      input.logWarn?.(`Scheduled task runtime admission skipped: ${reason}`);
      return {
        checked: false,
        ok: true,
        reason,
      };
    }
  };
}
