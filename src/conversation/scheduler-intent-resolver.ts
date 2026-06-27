import { generateText } from "ai";
import { createDirectModelResolver } from "../agent/providers";
import type { DirectLanguageModel, ModelResolver } from "../agent/providers";
import type {
  SchedulerIntentResolver,
  SchedulerIntentResolverResult,
} from "./types";

type SchedulerIntentGenerateText = (request: {
  model: DirectLanguageModel;
  system: string;
  prompt: string;
  maxRetries?: number;
}) => Promise<{ text: string }>;

export type LlmSchedulerIntentResolverDeps = {
  model: string;
  resolveModel?: ModelResolver;
  generateText?: SchedulerIntentGenerateText;
  timeoutMs?: number;
  logWarn?: (message: string) => void;
};

export function createLlmSchedulerIntentResolver(
  deps: LlmSchedulerIntentResolverDeps,
): SchedulerIntentResolver {
  const resolveModel = deps.resolveModel ?? createDirectModelResolver();
  const model = resolveModel(deps.model);
  const generate = deps.generateText ?? generateText;
  const timeoutMs = deps.timeoutMs ?? 2500;

  return async (input) => {
    const response = await withTimeout(
      generate({
        model,
        system: schedulerIntentSystemPrompt,
        prompt: schedulerIntentPrompt(
          input.text,
          input.recentMessages,
          input.jobs,
        ),
        maxRetries: 0,
      }),
      timeoutMs,
    );
    if (!response) {
      deps.logWarn?.("Scheduler intent resolver timed out.");
      return { intent: "none", confidence: 0, jobId: null };
    }
    const parsed = parseSchedulerIntentResponse(response.text);
    if (!parsed) {
      deps.logWarn?.("Scheduler intent resolver returned invalid JSON.");
      return { intent: "none", confidence: 0, jobId: null };
    }
    return parsed;
  };
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | null> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => resolve(null), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

const schedulerIntentSystemPrompt = [
  "You classify Slack messages for Burble's scheduled-job control plane.",
  "Return only one JSON object. Do not include markdown.",
  "Valid intents: list_jobs, list_job_runs, show_task, validate_task, create_job, trigger_job, pause_job, resume_job, delete_job, update_job_delivery, latest_run_status, none.",
  "Classify only scheduler/cron/background-job control requests.",
  "Task specs are configured scheduled tasks. Job runs are executions of task specs.",
  "Examples of scheduler control: list cron jobs, list tasks, list job runs, validate task job_123, inspect a task's grants, create an hourly news job, run the existing scheduled job, test-run this job, did the manual job finish, pause the cron job, modify a task to post in a different channel.",
  "Examples of none: what is my job title, help me find a job, explain what cron jobs are, write code for a scheduler.",
  "For create_job, include create.title, create.prompt, and create.schedule.",
  "create.prompt is the executable task only. Remove schedule and delivery clauses such as every 30 min, hourly, report back here, to this channel.",
  'Use cron schedules with UTC timezone. Examples: every 30 min => {"kind":"cron","expression":"*/30 * * * *","timezone":"UTC"}; hourly => {"kind":"cron","expression":"0 * * * *","timezone":"UTC"}.',
  "For simple emoji posting tasks, normalize the prompt to: Post exactly this message: <emoji>",
  "Use confidence from 0 to 1.",
  "Only include jobId when the user gives a job id or clearly refers to exactly one current job by title/prompt.",
  "If multiple jobs could match, return the intent with jobId null.",
].join("\n");

function schedulerIntentPrompt(
  text: string,
  recentMessages: string[],
  jobs: Array<{
    jobId: string;
    title: string | null;
    prompt: string | null;
    state: string;
  }>,
): string {
  return [
    `Message: ${JSON.stringify(text)}`,
    "Current task/job specs:",
    ...(jobs.length === 0
      ? ["- none"]
      : jobs.map((job) =>
          [
            `- jobId=${JSON.stringify(job.jobId)}`,
            `title=${JSON.stringify(job.title ?? "")}`,
            `state=${JSON.stringify(job.state)}`,
            `task=${JSON.stringify(job.prompt ?? "")}`,
          ].join(" "),
        )),
    "Recent context:",
    ...recentMessages
      .slice(-6)
      .map((message) => `- ${JSON.stringify(message)}`),
    "Return JSON with shape:",
    '{"intent":"trigger_job","confidence":0.92,"jobId":null}',
    'For create_job use: {"intent":"create_job","confidence":0.94,"jobId":null,"create":{"title":"Heart emoji every 30 min","prompt":"Post exactly this message: ❤️","schedule":{"kind":"cron","expression":"*/30 * * * *","timezone":"UTC"}}}',
  ].join("\n");
}

export function parseSchedulerIntentResponse(
  text: string,
): SchedulerIntentResolverResult | null {
  const jsonText = extractJsonObject(text);
  if (!jsonText) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) {
    return null;
  }
  const intent = parsed.intent;
  if (
    intent !== "list_jobs" &&
    intent !== "list_job_runs" &&
    intent !== "show_task" &&
    intent !== "validate_task" &&
    intent !== "create_job" &&
    intent !== "trigger_job" &&
    intent !== "pause_job" &&
    intent !== "resume_job" &&
    intent !== "delete_job" &&
    intent !== "update_job_delivery" &&
    intent !== "latest_run_status" &&
    intent !== "none"
  ) {
    return null;
  }

  const rawConfidence = parsed.confidence;
  const confidence =
    typeof rawConfidence === "number" && Number.isFinite(rawConfidence)
      ? Math.max(0, Math.min(1, rawConfidence))
      : 0;
  const jobId = typeof parsed.jobId === "string" ? parsed.jobId : null;
  const create =
    intent === "create_job" ? parseSchedulerCreatePayload(parsed.create) : null;
  return { intent, confidence, jobId, ...(create ? { create } : {}) };
}

function parseSchedulerCreatePayload(
  value: unknown,
): SchedulerIntentResolverResult["create"] | null {
  if (!isRecord(value)) {
    return null;
  }
  const title = typeof value.title === "string" ? value.title.trim() : "";
  const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
  const schedule = value.schedule;
  if (!title || !prompt || !isRecord(schedule)) {
    return null;
  }
  if (schedule.kind !== "cron") {
    return null;
  }
  const expression =
    typeof schedule.expression === "string" ? schedule.expression.trim() : "";
  const timezone =
    typeof schedule.timezone === "string" && schedule.timezone.trim()
      ? schedule.timezone.trim()
      : "UTC";
  if (!expression) {
    return null;
  }
  return {
    title,
    prompt,
    schedule: {
      kind: "cron",
      expression,
      timezone,
    },
  };
}

function extractJsonObject(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(trimmed);
  if (fenced?.[1]?.trim().startsWith("{")) {
    return fenced[1].trim();
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
