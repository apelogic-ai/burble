import { generateText } from "ai";
import { createDirectModelResolver } from "../agent/providers";
import type { DirectLanguageModel, ModelResolver } from "../agent/providers";
import { providerToolCatalog } from "../providers/catalog";
import { validateScheduledTaskPlan } from "../scheduler/task-preparation";
import type {
  SchedulerIntentResolver,
  SchedulerIntentResolverResult,
  SchedulerTaskPlan,
  SchedulerTaskPlanStep,
  SchedulerTaskPreparationStep,
} from "./types";

import { isAgentRuntimeEngine } from "@burble/runtime-sdk/runtime-engines";

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

export const DEFAULT_SCHEDULER_INTENT_TIMEOUT_MS = 30_000;

export function createLlmSchedulerIntentResolver(
  deps: LlmSchedulerIntentResolverDeps,
): SchedulerIntentResolver {
  const resolveModel = deps.resolveModel ?? createDirectModelResolver();
  const model = resolveModel(deps.model);
  const generate = deps.generateText ?? generateText;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_SCHEDULER_INTENT_TIMEOUT_MS;

  return async (input) => {
    const response = await withTimeout(
      generate({
        model,
        system: schedulerIntentSystemPrompt,
        prompt: schedulerIntentPrompt(
          input.text,
          input.recentMessages,
          input.jobs,
          input.repair,
        ),
        maxRetries: 0,
      }),
      timeoutMs,
    );
    if (!response) {
      deps.logWarn?.("Scheduler intent resolver timed out.");
      return {
        intent: "none",
        confidence: 0,
        jobId: null,
        failure: "timeout",
      };
    }
    const parsed = parseSchedulerIntentResponse(response.text);
    if (!parsed) {
      deps.logWarn?.("Scheduler intent resolver returned invalid JSON.");
      return {
        intent: "none",
        confidence: 0,
        jobId: null,
        failure: "invalid_response",
      };
    }
    if (!parsed.taskPlan) {
      return parsed;
    }
    const validation = validateScheduledTaskPlan(parsed.taskPlan);
    if (validation.ok || !hasUnknownProviderToolErrors(validation.errors)) {
      return parsed;
    }
    try {
      const repairedResponse = await withTimeout(
        generate({
          model,
          system: schedulerIntentSystemPrompt,
          prompt: schedulerTaskPlanRepairPrompt(response.text, validation.errors),
          maxRetries: 0,
        }),
        timeoutMs,
      );
      if (!repairedResponse) {
        deps.logWarn?.("Scheduler task-plan repair timed out.");
        return parsed;
      }
      const repaired = parseSchedulerIntentResponse(repairedResponse.text);
      const repairedTaskPlan = repaired?.taskPlan
        ? mergeRepairedTaskPlan(parsed.taskPlan, repaired.taskPlan)
        : null;
      if (
        !repairedTaskPlan ||
        !validateScheduledTaskPlan(repairedTaskPlan).ok
      ) {
        deps.logWarn?.("Scheduler task-plan repair remained invalid.");
        return parsed;
      }
      return { ...parsed, taskPlan: repairedTaskPlan };
    } catch {
      deps.logWarn?.("Scheduler task-plan repair failed.");
      return parsed;
    }
  };
}

function mergeRepairedTaskPlan(
  original: SchedulerTaskPlan,
  repaired: SchedulerTaskPlan,
): SchedulerTaskPlan | null {
  if (
    original.steps.length !== repaired.steps.length ||
    original.preparation.length !== repaired.preparation.length ||
    original.steps.some((step, index) => step.id !== repaired.steps[index]?.id) ||
    original.preparation.some(
      (step, index) => step.id !== repaired.preparation[index]?.id,
    )
  ) {
    return null;
  }
  return {
    steps: original.steps.map((step, index) => ({
      ...step,
      tools: repaired.steps[index]!.tools,
    })),
    preparation: original.preparation.map((step, index) => ({
      ...step,
      tool: repaired.preparation[index]!.tool,
      input: repaired.preparation[index]!.input,
    })),
    ...(original.stateRefMode
      ? { stateRefMode: original.stateRefMode }
      : {}),
  };
}

function hasUnknownProviderToolErrors(errors: string[]): boolean {
  return errors.some((error) =>
    error.includes("references unknown provider tool"),
  );
}

function schedulerTaskPlanRepairPrompt(
  originalResponse: string,
  errors: string[],
): string {
  return [
    "Repair only the taskPlan in this scheduler-intent JSON.",
    "Use exact canonical tool names from the system catalog.",
    "Preserve the intent, jobId, confidence, instructions, preparation semantics, and step ordering.",
    "Return one complete JSON object and no markdown.",
    "Validation errors:",
    ...errors.map((error) => `- ${error}`),
    "Original response:",
    originalResponse,
  ].join("\n");
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
  "Valid intents: list_jobs, list_job_runs, show_task, validate_task, create_job, trigger_job, pause_job, resume_job, delete_job, update_job_delivery, update_job, update_job_schedule, update_job_prompt, update_job_runtime, latest_run_status, none.",
  "Classify only scheduler/cron/background-job control requests.",
  "Never mutate a scheduled task from an ordinary conversational follow-up, even when a current task has a similar topic. The current message must explicitly refer to a job, task, schedule, cron, or other scheduler control action.",
  "Task specs are configured scheduled tasks. Job runs are executions of task specs.",
  "Examples of scheduler control: list cron jobs, list tasks, list job runs, validate task job_123, inspect a task's grants, create an hourly news job, run the existing scheduled job, test-run this job, did the manual job finish, pause the cron job, modify a task to post in a different channel.",
  "Examples of none: what is my job title, help me find a job, explain what cron jobs are, write code for a scheduler.",
  "For create_job, include create.title, create.prompt, and create.schedule.",
  "create.prompt is the executable task only. Remove schedule and delivery clauses such as every 30 min, hourly, report back here, to this channel.",
  "For update_job_schedule, include schedule with the new cron schedule and include jobId when one current task/job clearly matches the user reference.",
  "For update_job_prompt, include prompt with the new executable task prompt and include jobId when one current task/job clearly matches the user reference.",
  "When a task creation or update contains multiple requested steps, return taskPlan instead of copying the user's message into prompt.",
  "taskPlan.steps are recurring executable steps. Each step has id, instruction, and the exact recurring provider tool names it requires in tools.",
  "taskPlan.preparation contains one-time provider calls that must finish before the task is updated. Each preparation step has id, tool, input, saveAs, and optional purpose.",
  "Current task specs include opaque stateRefs. Preserve and reuse matching existing refs by default; do not rediscover or recreate them.",
  "Recurring tools marked stateRefRequired require a matching durable stateRef from the same provider. If no matching current stateRef exists, add a one-time preparation step that resolves or creates the resource and bind its returned id into recurring instructions with a {{resources.<saveAs>.<field>}} placeholder.",
  "Never claim that configured state exists unless the current task contains a matching stateRef or taskPlan.preparation creates or resolves it.",
  "taskPlan.stateRefMode controls state changes: omit it to preserve existing refs and merge newly prepared refs; use replace or clear only when the user explicitly requests replacement or removal.",
  "Use {{resources.<saveAs>.<field>}} placeholders in recurring instructions when they need values returned by preparation steps.",
  "Do not put one-time setup work such as create a document now into recurring steps.",
  "Do not include schedule cadence or delivery wording as recurring task steps; scheduled delivery is owned by Burble.",
  "For update_job_runtime, include runtimeType and jobId. Supported runtimeType values: deterministic, openclaw, openclaw-gateway, burble-native, hermes.",
  "For a request changing two or more of prompt, schedule, and runtime, use update_job and include every requested field plus jobId.",
  'Use cron schedules with UTC timezone. Examples: every 30 min => {"kind":"cron","expression":"*/30 * * * *","timezone":"UTC"}; hourly => {"kind":"cron","expression":"0 * * * *","timezone":"UTC"}; every weekday at 9 AM => {"kind":"cron","expression":"0 9 * * 1-5","timezone":"UTC"}.',
  "For simple emoji posting tasks, normalize the prompt to: Post exactly this message: <emoji>",
  "Use confidence from 0 to 1.",
  "Only include jobId when the user gives a job id or clearly refers to exactly one current job by title/prompt.",
  "If multiple jobs could match, return the intent with jobId null.",
  "Use only the exact canonical tool names listed below in taskPlan preparation and recurring steps. Provider names such as github or google are not tool names.",
  schedulerProviderToolCatalog(),
].join("\n");

function schedulerProviderToolCatalog(): string {
  return [
    "Canonical provider tools:",
    ...providerToolCatalog
      .toSorted((left, right) => left.name.localeCompare(right.name))
      .map((tool) => {
        const inputs = Object.entries(tool.input)
          .map(([name, spec]) => `${name}${spec.optional ? "?" : ""}`)
          .join(",");
        const stateRefInputs = tool.stateRefInputs?.length
          ? ` stateRefInputs=${tool.stateRefInputs.join(",")}`
          : "";
        const stateRefRequired = tool.stateRefRequired
          ? " stateRefRequired=true"
          : "";
        return `- ${tool.name} [${tool.risk ?? "read"}] inputs=${inputs || "none"}${stateRefInputs}${stateRefRequired}: ${tool.description}`;
      }),
  ].join("\n");
}

function schedulerIntentPrompt(
  text: string,
  recentMessages: string[],
  jobs: Array<{
    jobId: string;
    title: string | null;
    prompt: string | null;
    state: string;
    requiredTools: string[];
    expectedTools?: string[];
    stateRefs?: unknown[];
  }>,
  repair?: { jobId: string | null; errors: string[] },
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
            `requiredTools=${JSON.stringify(job.requiredTools)}`,
            `expectedTools=${JSON.stringify(job.expectedTools ?? [])}`,
            `stateRefs=${JSON.stringify(job.stateRefs ?? [])}`,
          ].join(" "),
        )),
    "Recent context:",
    ...recentMessages
      .slice(-6)
      .map((message) => `- ${JSON.stringify(message)}`),
    ...(repair
      ? [
          "Pre-flight repair request:",
          `- jobId=${JSON.stringify(repair.jobId)}`,
          ...repair.errors.map((error) => `- ${error}`),
          "Return one corrected candidate for the same job and requested mutation. Do not add preparation side effects.",
        ]
      : []),
    "Return JSON with shape:",
    '{"intent":"trigger_job","confidence":0.92,"jobId":null}',
    'For create_job use: {"intent":"create_job","confidence":0.94,"jobId":null,"create":{"title":"Heart emoji every 30 min","prompt":"Post exactly this message: ❤️","schedule":{"kind":"cron","expression":"*/30 * * * *","timezone":"UTC"}}}',
    'For update_job_schedule use: {"intent":"update_job_schedule","confidence":0.94,"jobId":"job_123","schedule":{"kind":"cron","expression":"*/45 * * * *","timezone":"UTC"}}',
    'For update_job_prompt use: {"intent":"update_job_prompt","confidence":0.94,"jobId":"job_123","prompt":"Post exactly this message: ❤️❤️"}',
    'For a planned update use: {"intent":"update_job_prompt","confidence":0.98,"jobId":"job_123","taskPlan":{"preparation":[],"steps":[{"id":"collect","instruction":"Find the latest news and select the top five.","tools":["web_search"]},{"id":"report","instruction":"Return the results.","tools":[]}]}}',
    'For update_job_runtime use: {"intent":"update_job_runtime","confidence":0.94,"jobId":"job_123","runtimeType":"burble-native"}',
    'For a composite update use: {"intent":"update_job","confidence":0.97,"jobId":"job_123","prompt":"Post exactly this message: ❤️","schedule":{"kind":"cron","expression":"*/15 * * * *","timezone":"UTC"},"runtimeType":"burble-native"}',
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
    intent !== "update_job" &&
    intent !== "update_job_schedule" &&
    intent !== "update_job_prompt" &&
    intent !== "update_job_runtime" &&
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
  const schedule =
    intent === "update_job_schedule" || intent === "update_job"
      ? parseSchedulerSchedulePayload(parsed.schedule)
      : null;
  const prompt =
    intent === "update_job_prompt" || intent === "update_job"
      ? parseSchedulerPromptPayload(parsed.prompt)
      : null;
  const runtimeType =
    (intent === "update_job_runtime" || intent === "update_job") &&
    isAgentRuntimeEngine(parsed.runtimeType)
      ? parsed.runtimeType
      : null;
  const taskPlan =
    intent === "create_job" ||
    intent === "update_job_prompt" ||
    intent === "update_job"
      ? parseSchedulerTaskPlan(parsed.taskPlan)
      : null;
  return {
    intent,
    confidence,
    jobId,
    ...(create ? { create } : {}),
    ...(schedule ? { schedule } : {}),
    ...(prompt ? { prompt } : {}),
    ...(runtimeType ? { runtimeType } : {}),
    ...(taskPlan ? { taskPlan } : {}),
  };
}

function parseSchedulerTaskPlan(value: unknown): SchedulerTaskPlan | null {
  if (!isRecord(value) || !Array.isArray(value.steps)) {
    return null;
  }
  const steps = value.steps.map(parseSchedulerTaskPlanStep);
  if (steps.some((step) => step === null) || steps.length === 0) {
    return null;
  }
  const preparationValue = value.preparation ?? [];
  if (!Array.isArray(preparationValue)) {
    return null;
  }
  const preparation = preparationValue.map(parseSchedulerPreparationStep);
  if (preparation.some((step) => step === null)) {
    return null;
  }
  const ids = [...steps, ...preparation].map((step) => step!.id);
  const bindings = preparation.map((step) => step!.saveAs);
  if (new Set(ids).size !== ids.length || new Set(bindings).size !== bindings.length) {
    return null;
  }
  const stateRefMode =
    value.stateRefMode === "merge" ||
    value.stateRefMode === "replace" ||
    value.stateRefMode === "clear"
      ? value.stateRefMode
      : null;
  return {
    steps: steps as SchedulerTaskPlanStep[],
    preparation: preparation as SchedulerTaskPreparationStep[],
    ...(stateRefMode ? { stateRefMode } : {}),
  };
}

function parseSchedulerTaskPlanStep(value: unknown): SchedulerTaskPlanStep | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = parsePlanIdentifier(value.id);
  const instruction =
    typeof value.instruction === "string" ? value.instruction.trim() : "";
  const tools = parseToolNames(value.tools);
  if (!id || !instruction || !tools) {
    return null;
  }
  return { id, instruction, tools };
}

function parseSchedulerPreparationStep(
  value: unknown,
): SchedulerTaskPreparationStep | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = parsePlanIdentifier(value.id);
  const tool = typeof value.tool === "string" ? value.tool.trim() : "";
  const saveAs = parsePlanIdentifier(value.saveAs);
  const input = value.input;
  const purpose =
    typeof value.purpose === "string" ? value.purpose.trim() : "";
  if (!id || !tool || !saveAs || !isRecord(input)) {
    return null;
  }
  return {
    id,
    tool,
    input,
    saveAs,
    ...(purpose ? { purpose } : {}),
  };
}

function parsePlanIdentifier(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(normalized) ? normalized : null;
}

function parseToolNames(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const tools = value.map((tool) =>
    typeof tool === "string" ? tool.trim() : "",
  );
  return tools.every(Boolean) ? [...new Set(tools)] : null;
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

function parseSchedulerSchedulePayload(value: unknown): unknown | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.kind !== "cron") {
    return null;
  }
  const expression =
    typeof value.expression === "string" ? value.expression.trim() : "";
  const timezone =
    typeof value.timezone === "string" && value.timezone.trim()
      ? value.timezone.trim()
      : "UTC";
  if (!expression) {
    return null;
  }
  return {
    kind: "cron",
    expression,
    timezone,
  };
}

function parseSchedulerPromptPayload(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const prompt = value.trim();
  return prompt || null;
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
