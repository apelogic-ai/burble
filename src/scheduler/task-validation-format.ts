import type { SchedulerTaskValidation } from "./task-validation";

const MAX_SCHEDULED_TASK_FAILURE_REASON_CHARS = 500;

export function formatScheduledTaskValidationFailureReason(
  validation: SchedulerTaskValidation,
): string {
  if (validation.ok) {
    return "Scheduled task validation failed.";
  }
  return truncateScheduledTaskFailureReason(
    [
      "Scheduled task validation failed:",
      validation.errors
        .map((issue) => `${issue.code}: ${issue.message}`)
        .join("; "),
    ].join(" "),
  );
}

export function truncateScheduledTaskFailureReason(reason: string): string {
  const chars = Array.from(reason);
  if (chars.length <= MAX_SCHEDULED_TASK_FAILURE_REASON_CHARS) {
    return reason;
  }
  return `${chars.slice(0, MAX_SCHEDULED_TASK_FAILURE_REASON_CHARS - 1).join("")}…`;
}
