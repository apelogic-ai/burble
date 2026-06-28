import type { AgentOutput } from "../agent/types";
import { isRuntimeProgressOnlyResponseText } from "../agent/runtime-control-notices";
import { containsRuntimeToolCallProtocolFragments } from "@burble/runtime-sdk/runtime-text-protocol";
import type { AgentJobRunRecord, ScheduledJobRecord } from "../db";

export type ScheduledJobOutputContractResult =
  | {
      ok: true;
      text: string;
      classification: AgentOutput["classification"];
    }
  | {
      ok: false;
      reason: string;
    };

export const SCHEDULED_JOB_OUTPUT_CONTRACT_PROMPT = [
  "You are executing a Burble task run.",
  "Return only the final user-visible result for this task.",
  "Do not describe setup, job creation, job modification, delivery, or next-run timing unless the task explicitly asks for job metadata.",
  "Do not call tools for delivery; Burble will deliver your final answer.",
  "Do not include internal progress text, tool-call markers, raw tool JSON, or protocol/debug transcripts in the final answer.",
].join("\n");

export function scheduledTaskRuntimePrompt(prompt: string): string {
  const literalMessage = readLiteralScheduledMessage(prompt);
  if (literalMessage) {
    return [
      SCHEDULED_JOB_OUTPUT_CONTRACT_PROMPT,
      "",
      "The task is literal delivery. Return exactly this message as your entire final answer, with no extra text.",
      "",
      literalMessage,
    ].join("\n");
  }

  return [
    SCHEDULED_JOB_OUTPUT_CONTRACT_PROMPT,
    "",
    "Task:",
    prompt.trim(),
  ].join("\n");
}

export function validateScheduledJobOutput(
  output: AgentOutput,
): ScheduledJobOutputContractResult {
  const text = output.text.trim();
  if (!text) {
    return {
      ok: false,
      reason: "Managed runtime final response was empty",
    };
  }
  if (isRuntimeProgressOnlyResponseText(text)) {
    return {
      ok: false,
      reason:
        "Managed runtime final response contained only runtime-control/progress text",
    };
  }
  if (containsRuntimeToolCallProtocolFragments(text)) {
    return {
      ok: false,
      reason: "Managed runtime final response leaked tool-call protocol text",
    };
  }

  return {
    ok: true,
    text,
    classification: output.classification,
  };
}

export function formatScheduledJobFailureMessage(
  job: ScheduledJobRecord,
  run: AgentJobRunRecord,
  message: string,
): string {
  const title = job.title?.trim() || job.jobId;
  return [
    `Scheduled job failed: ${title}`,
    `Job ID: ${job.jobId}`,
    `Run ID: ${run.runId}`,
    `Reason: ${message.slice(0, 500)}`,
  ].join("\n");
}

function readLiteralScheduledMessage(prompt: string): string | null {
  const match = /^Post exactly this message:\s*(?<message>.+)$/isu.exec(
    prompt.trim(),
  );
  const message = match?.groups?.message?.trim();
  return message ? message : null;
}
