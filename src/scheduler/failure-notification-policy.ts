import type { AgentJobRunRecord } from "../db";

export const SCHEDULED_RUN_FAILURE_NOTIFICATION_POLICY =
  "delivery_route_only";

export function shouldNotifyScheduledRunFailure(input: {
  run: Pick<AgentJobRunRecord, "triggerSource">;
  hasDestination: boolean;
}): boolean {
  if (!input.hasDestination) {
    return false;
  }

  switch (input.run.triggerSource) {
    case "manual":
    case "schedule":
      return true;
    default:
      return assertNever(input.run.triggerSource);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled scheduled run trigger source: ${value}`);
}
