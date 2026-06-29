import { formatConnectGitHubMessage } from "../formatting";
import {
  formatGitHubIdentityMessage,
  formatIssuesMessage,
} from "../formatting";
import { collectAgentRun, type AgentRunEvent } from "../agent/types";
import { selectRuntimeToolGroups } from "../agent/tool-groups";
import { runtimeCompatibilityFamily } from "../agent/runtime-descriptors";
import { parseGitHubPullRequestListInput } from "../github-query";
import { tryHandleLocalToolFastPath } from "./local-tool-fast-paths";
import { enforceVisibility } from "./visibility";
import type {
  SchedulerCreateJobResult,
  SchedulerJobDeleteResult,
  SchedulerJobMutationResult,
  SchedulerRunStatusResult,
  SchedulerShowTaskResult,
  SchedulerTriggerResult,
  SchedulerUpdateJobDeliveryResult,
  SchedulerUpdateJobPromptResult,
  SchedulerUpdateJobScheduleResult,
  SchedulerValidateTaskResult,
} from "../scheduler/control-plane";
import type {
  ConversationDeps,
  ConversationRequest,
  ConversationResponse,
  SchedulerControlIntent,
  SchedulerIntentResolverResult,
  SchedulerResolvedCreateJob,
} from "./types";
import type { AgentRuntimeEngine } from "../db";
import { isAgentRuntimeEngine } from "@burble/runtime-sdk/runtime-engines";

export async function handleConversation(
  request: ConversationRequest,
  deps: ConversationDeps,
): Promise<ConversationResponse> {
  const traceId = deps.traceId ?? crypto.randomUUID();
  const startedAt = Date.now();
  emitConversationStarted(traceId, request, deps);
  try {
    const response = await handleConversationInternal(request, {
      ...deps,
      traceId,
    });
    emitConversationCompleted(traceId, request, response, deps, startedAt);
    return response;
  } catch (error) {
    emitConversationFailed(traceId, request, deps, startedAt, error);
    throw error;
  }
}

async function handleConversationInternal(
  request: ConversationRequest,
  deps: ConversationDeps,
): Promise<ConversationResponse> {
  const intent = classifyDeterministicIntent(request.text);
  const forceAgent = shouldForceAgentDelegation(request.text);
  const fastTrackEnabled = shouldUseFastTrack(deps);
  const schedulerResolution = await resolveSchedulerControlIntent(
    request,
    deps,
  );
  const schedulerControlIntent = schedulerResolution.intent;
  const schedulerJobIdHint =
    schedulerResolution.jobId ?? readSchedulerJobIdHint(request.text);
  const schedulerCreateRequest =
    schedulerControlIntent === "create_job"
      ? (schedulerResolution.create ??
        parseSchedulerCreateRequest(request.text))
      : null;
  const schedulerDeliveryUpdateRequest =
    schedulerControlIntent === "update_job_delivery"
      ? parseSchedulerDeliveryUpdateRequest(request)
      : null;
  const schedulerScheduleUpdateRequest =
    schedulerControlIntent === "update_job_schedule"
      ? (normalizeResolvedSchedule(schedulerResolution.schedule) ??
        parseExplicitIntervalSchedule(request.text)?.value ??
        null)
      : null;
  const schedulerPromptUpdateRequest =
    schedulerControlIntent === "update_job_prompt"
      ? normalizeResolvedPrompt(schedulerResolution.prompt)
      : null;
  const toolGroups = selectRuntimeToolGroups({
    text: request.text,
    attachmentCount: request.attachments?.length ?? 0,
    contextTexts: recentConversationTexts(request),
  });

  if (intent === "connect_github") {
    return {
      visibility: "ephemeral",
      classification: "user_private",
      text: formatConnectGitHubMessage(
        deps.createGitHubOAuthUrl(request.user.slackUserId),
      ),
    };
  }

  if (intent === "connect_jira") {
    if (!deps.createJiraOAuthUrl) {
      return {
        visibility: "ephemeral",
        classification: "user_private",
        text: "Jira OAuth is not configured.",
      };
    }

    return {
      visibility: "ephemeral",
      classification: "user_private",
      text: `<${deps.createJiraOAuthUrl(request.user.slackUserId)}|Connect your Jira account>`,
    };
  }

  if (intent === "connect_slack") {
    if (!deps.createSlackOAuthUrl) {
      return {
        visibility: "ephemeral",
        classification: "user_private",
        text: "Slack OAuth is not configured.",
      };
    }

    return {
      visibility: "ephemeral",
      classification: "user_private",
      text: `<${deps.createSlackOAuthUrl(request.user.slackUserId)}|Connect Slack search>`,
    };
  }

  if (intent === "connect_google") {
    if (!deps.createGoogleOAuthUrl) {
      return {
        visibility: "ephemeral",
        classification: "user_private",
        text: "Google OAuth is not configured.",
      };
    }

    return {
      visibility: "ephemeral",
      classification: "user_private",
      text: `<${deps.createGoogleOAuthUrl(request.user.slackUserId)}|Connect your Google account>`,
    };
  }

  if (intent === "connect_hubspot") {
    if (!deps.createHubSpotOAuthUrl) {
      return {
        visibility: "ephemeral",
        classification: "user_private",
        text: "HubSpot OAuth is not configured.",
      };
    }

    return {
      visibility: "ephemeral",
      classification: "user_private",
      text: `<${deps.createHubSpotOAuthUrl(request.user.slackUserId)}|Connect your HubSpot account>`,
    };
  }

  if (schedulerControlIntent === "list_jobs" && deps.schedulerControl) {
    const jobs = await deps.schedulerControl.listJobs({
      workspaceId: request.workspaceId,
      slackUserId: request.user.slackUserId,
    });
    return {
      visibility: "ephemeral",
      classification: "user_private",
      text: formatScheduledJobList(jobs),
    };
  }

  if (
    schedulerControlIntent === "list_job_runs" &&
    deps.schedulerControl?.listJobRuns
  ) {
    const result = await deps.schedulerControl.listJobRuns({
      workspaceId: request.workspaceId,
      slackUserId: request.user.slackUserId,
      jobId: schedulerJobIdHint,
      limit: 10,
    });
    return {
      visibility: "ephemeral",
      classification: "user_private",
      text: formatScheduledJobRunList(result.runs),
    };
  }

  if (
    schedulerControlIntent === "show_task" &&
    deps.schedulerControl?.showTask
  ) {
    const result = await deps.schedulerControl.showTask({
      workspaceId: request.workspaceId,
      slackUserId: request.user.slackUserId,
      taskId: schedulerJobIdHint,
    });
    return {
      visibility: "ephemeral",
      classification: "user_private",
      text: formatScheduledTaskDetailResult(result),
    };
  }

  if (
    schedulerControlIntent === "validate_task" &&
    deps.schedulerControl?.validateTask
  ) {
    const result = await deps.schedulerControl.validateTask({
      workspaceId: request.workspaceId,
      slackUserId: request.user.slackUserId,
      taskId: schedulerJobIdHint,
    });
    return {
      visibility: "ephemeral",
      classification: "user_private",
      text: formatScheduledTaskValidationResult(result),
    };
  }

  if (schedulerCreateRequest && deps.schedulerControl?.createJob) {
    const result = await deps.schedulerControl.createJob({
      workspaceId: request.workspaceId,
      slackUserId: request.user.slackUserId,
      title: schedulerCreateRequest.title,
      prompt: schedulerCreateRequest.prompt,
      schedule: schedulerCreateRequest.schedule,
      routeId: request.conversationRouteId,
      runtimeType: scheduledJobRuntimeType(
        deps.schedulerRuntimeEngine ?? deps.agentRuntimeEngine,
      ),
    });
    return {
      visibility: "ephemeral",
      classification: "user_private",
      text: formatScheduledJobCreateResult(result),
    };
  }

  if (schedulerControlIntent === "create_job") {
    return {
      visibility: "ephemeral",
      classification: "user_private",
      text: formatUnresolvedScheduledJobCreate(),
    };
  }

  if (
    schedulerControlIntent === "trigger_job" &&
    deps.schedulerControl?.triggerJob
  ) {
    const result = await deps.schedulerControl.triggerJob({
      workspaceId: request.workspaceId,
      slackUserId: request.user.slackUserId,
      jobId: schedulerJobIdHint,
    });
    if (result.ok) {
      dispatchSchedulerRunQueued(deps, result.run);
    }
    return {
      visibility: "ephemeral",
      classification: "user_private",
      text: formatScheduledJobTriggerResult(result),
    };
  }

  if (
    schedulerControlIntent === "pause_job" &&
    deps.schedulerControl?.pauseJob
  ) {
    const result = await deps.schedulerControl.pauseJob({
      workspaceId: request.workspaceId,
      slackUserId: request.user.slackUserId,
      jobId: schedulerJobIdHint,
    });
    return {
      visibility: "ephemeral",
      classification: "user_private",
      text: formatScheduledJobMutationResult("Paused", result),
    };
  }

  if (
    schedulerControlIntent === "resume_job" &&
    deps.schedulerControl?.resumeJob
  ) {
    const result = await deps.schedulerControl.resumeJob({
      workspaceId: request.workspaceId,
      slackUserId: request.user.slackUserId,
      jobId: schedulerJobIdHint,
    });
    return {
      visibility: "ephemeral",
      classification: "user_private",
      text: formatScheduledJobMutationResult("Resumed", result),
    };
  }

  if (
    schedulerControlIntent === "delete_job" &&
    deps.schedulerControl?.deleteJob
  ) {
    const result = await deps.schedulerControl.deleteJob({
      workspaceId: request.workspaceId,
      slackUserId: request.user.slackUserId,
      jobId: schedulerJobIdHint,
    });
    return {
      visibility: "ephemeral",
      classification: "user_private",
      text: formatScheduledJobDeleteResult(result),
    };
  }

  if (
    schedulerControlIntent === "update_job_delivery" &&
    deps.schedulerControl?.updateJobDelivery
  ) {
    const result = await deps.schedulerControl.updateJobDelivery({
      workspaceId: request.workspaceId,
      slackUserId: request.user.slackUserId,
      jobId: schedulerJobIdHint,
      routeId: schedulerDeliveryUpdateRequest?.routeId ?? null,
      channelId: schedulerDeliveryUpdateRequest?.channelId ?? null,
      channelName: schedulerDeliveryUpdateRequest?.channelName ?? null,
    });
    return {
      visibility: "ephemeral",
      classification: "user_private",
      text: formatScheduledJobDeliveryUpdateResult(result),
    };
  }

  if (
    schedulerControlIntent === "update_job_schedule" &&
    deps.schedulerControl?.updateJobSchedule
  ) {
    if (!schedulerScheduleUpdateRequest) {
      return {
        visibility: "ephemeral",
        classification: "user_private",
        text: "I can’t update that scheduled task yet because I could not resolve the new schedule.",
      };
    }
    const result = await deps.schedulerControl.updateJobSchedule({
      workspaceId: request.workspaceId,
      slackUserId: request.user.slackUserId,
      jobId: schedulerJobIdHint,
      schedule: schedulerScheduleUpdateRequest,
    });
    return {
      visibility: "ephemeral",
      classification: "user_private",
      text: formatScheduledJobScheduleUpdateResult(result),
    };
  }

  if (
    schedulerControlIntent === "update_job_prompt" &&
    deps.schedulerControl?.updateJobPrompt
  ) {
    if (!schedulerPromptUpdateRequest) {
      return {
        visibility: "ephemeral",
        classification: "user_private",
        text: "I can’t update that scheduled task yet because I could not resolve the new task prompt.",
      };
    }
    const result = await deps.schedulerControl.updateJobPrompt({
      workspaceId: request.workspaceId,
      slackUserId: request.user.slackUserId,
      jobId: schedulerJobIdHint,
      prompt: schedulerPromptUpdateRequest,
    });
    return {
      visibility: "ephemeral",
      classification: "user_private",
      text: formatScheduledJobPromptUpdateResult(result),
    };
  }

  if (
    schedulerControlIntent === "latest_run_status" &&
    deps.schedulerControl?.getLatestRunStatus
  ) {
    const result = await deps.schedulerControl.getLatestRunStatus({
      workspaceId: request.workspaceId,
      slackUserId: request.user.slackUserId,
      jobId: schedulerJobIdHint,
    });
    return {
      visibility: "ephemeral",
      classification: "user_private",
      text: formatScheduledRunStatusResult(result),
    };
  }

  if (!forceAgent && fastTrackEnabled) {
    const fastPathResponse = await tryHandleLocalToolFastPath(request, deps);
    if (fastPathResponse) {
      return fastPathResponse;
    }
  }

  if (
    !forceAgent &&
    fastTrackEnabled &&
    (intent === "github_identity" ||
      intent === "github_issues" ||
      intent === "github_issue_search" ||
      intent === "github_pull_requests")
  ) {
    const connection = deps.getConnection("github", request.user.email);
    if (!connection) {
      return {
        visibility: "ephemeral",
        classification: "user_private",
        text: "Connect GitHub first: `@Burble connect github`.",
      };
    }

    if (intent === "github_identity") {
      const result = await deps.tools.github.getAuthenticatedUser.execute({
        connection,
      });
      return enforceVisibility(
        {
          visibility: "public",
          classification: result.classification,
          text: formatGitHubIdentityMessage(
            result.content.login,
            request.user.email,
          ),
        },
        request,
      );
    }

    const result =
      intent === "github_pull_requests"
        ? await deps.tools.github.listMyPullRequests.execute({
            connection,
            input: parseGitHubPullRequestListInput(request.text),
          })
        : intent === "github_issue_search"
          ? await deps.tools.github.searchIssues.execute({
              connection,
              input: { query: buildIssueSearchQuery(request.text) },
            })
          : await deps.tools.github.listAssignedIssues.execute({
              connection,
            });

    return enforceVisibility(
      {
        visibility: "public",
        classification: result.classification,
        text: formatIssuesMessage(
          result.content.map((issue) => ({
            title: issue.title,
            html_url: issue.url,
          })),
        ),
      },
      request,
    );
  }

  if (deps.agentMode === "llm" && deps.agentRunner) {
    const result = await collectAgentRun(
      deps.agentRunner,
      {
        principal: {
          workspaceId: request.workspaceId,
          slackUserId: request.user.slackUserId,
        },
        ...(deps.agentExecutionMode
          ? { executionMode: deps.agentExecutionMode }
          : {}),
        conversation: buildAgentConversation(request),
        ...(request.context ? { context: request.context } : {}),
        text: request.text,
        toolGroups,
        ...(request.attachments ? { attachments: request.attachments } : {}),
        connections: {
          github: deps.getConnection("github", request.user.email),
          google: deps.getConnection("google", request.user.email),
          hubspot: deps.getConnection("hubspot", request.user.email),
          jira: deps.getConnection("jira", request.user.email),
          slack: deps.getConnection("slack", request.user.email),
        },
      },
      async (event) => {
        emitAgentEvent(
          deps.traceId ?? crypto.randomUUID(),
          request,
          deps,
          event,
        );
        await deps.onAgentEvent?.(event);
      },
    );

    return enforceVisibility(
      {
        visibility: "public",
        classification: result.classification,
        text: result.text,
        ...(result.attachments ? { attachments: result.attachments } : {}),
        ...(result.blocks ? { blocks: result.blocks } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
      },
      request,
    );
  }

  return {
    visibility: "public",
    classification: "public",
    text: [
      "Try one of these:",
      "`@Burble connect github`",
      "`@Burble who am I on GitHub?`",
      "`@Burble what issues are assigned to me?`",
    ].join("\n"),
  };
}

function scheduledJobRuntimeType(
  engine: AgentRuntimeEngine | undefined,
): AgentRuntimeEngine | null {
  if (!engine) {
    return null;
  }
  const family = runtimeCompatibilityFamily(engine);
  return isAgentRuntimeEngine(family) ? family : engine;
}

function classifySchedulerControlIntent(text: string): SchedulerControlIntent {
  const tokens = tokenizeSchedulerControlText(text);

  if (isSchedulerValidateTaskIntent(tokens)) {
    return "validate_task";
  }
  if (isSchedulerJobRunListIntent(tokens)) {
    return "list_job_runs";
  }
  if (isSchedulerListIntent(tokens) && hasSchedulerListReference(tokens)) {
    return "list_jobs";
  }
  if (
    isSchedulerScheduleUpdateIntent(tokens) &&
    hasAnyToken(tokens, ["job", "jobs", "task", "tasks", "cron"])
  ) {
    return "update_job_schedule";
  }
  if (!hasSchedulerActionReference(tokens)) {
    return null;
  }
  if (isSchedulerRunStatusIntent(tokens)) {
    return "latest_run_status";
  }
  if (isSchedulerShowTaskIntent(tokens)) {
    return "show_task";
  }
  if (hasAnyToken(tokens, ["validate", "inspect"])) {
    return "validate_task";
  }
  if (hasAnyToken(tokens, ["pause", "disable", "stop"])) {
    return "pause_job";
  }
  if (hasAnyToken(tokens, ["resume", "enable", "unpause"])) {
    return "resume_job";
  }
  if (hasAnyToken(tokens, ["delete", "remove", "cancel"])) {
    return "delete_job";
  }
  if (isSchedulerDeliveryUpdateIntent(tokens)) {
    return "update_job_delivery";
  }
  if (isSchedulerScheduleUpdateIntent(tokens)) {
    return "update_job_schedule";
  }
  if (isSchedulerTriggerIntent(tokens)) {
    return "trigger_job";
  }
  return null;
}

async function resolveSchedulerControlIntent(
  request: ConversationRequest,
  deps: ConversationDeps,
): Promise<{
  intent: SchedulerControlIntent;
  jobId: string | null;
  create: SchedulerResolvedCreateJob | null;
  schedule: unknown | null;
  prompt: string | null;
}> {
  const fallbackJobId = readSchedulerJobIdHint(request.text);
  const fallbackCreate = parseSchedulerCreateRequest(request.text);
  const deterministicIntent =
    classifyExplicitSchedulerJobIdIntent(request.text) ??
    classifySchedulerControlIntent(request.text) ??
    (fallbackCreate ? "create_job" : null);

  if (deps.schedulerIntentResolver) {
    try {
      const jobs = deps.schedulerControl
        ? await deps.schedulerControl.listJobs({
            workspaceId: request.workspaceId,
            slackUserId: request.user.slackUserId,
          })
        : [];
      const resolved = await deps.schedulerIntentResolver({
        text: request.text,
        recentMessages: recentConversationTexts(request),
        jobs,
      });
      const intent = normalizeResolvedSchedulerIntent(resolved);
      if (intent) {
        return {
          intent,
          jobId: resolveSchedulerResolverJobId(
            request.text,
            resolved.jobId,
            jobs,
            fallbackJobId,
          ),
          create:
            intent === "create_job"
              ? (normalizeResolverCreateJob(resolved.create) ?? fallbackCreate)
              : null,
          schedule:
            intent === "update_job_schedule"
              ? normalizeResolvedSchedule(resolved.schedule)
              : null,
          prompt:
            intent === "update_job_prompt"
              ? normalizeResolvedPrompt(resolved.prompt)
              : null,
        };
      }
    } catch {
      // Resolver failures should not make ordinary conversation turns fail.
    }

    return {
      intent: deterministicIntent,
      jobId: fallbackJobId,
      create: fallbackCreate,
      schedule: null,
      prompt: null,
    };
  }

  return {
    intent: deterministicIntent,
    jobId: null,
    create: fallbackCreate,
    schedule: null,
    prompt: null,
  };
}

function normalizeResolverCreateJob(
  create: SchedulerResolvedCreateJob | null | undefined,
): ParsedSchedulerCreateRequest | null {
  if (!create) {
    return null;
  }
  const title = create.title.trim();
  const prompt = normalizeScheduledTaskPrompt(create.prompt.trim());
  if (!title || !prompt || !isValidResolvedSchedule(create.schedule)) {
    return null;
  }
  return {
    title,
    prompt,
    schedule: create.schedule,
    scheduleLabel: formatSchedule(create.schedule),
  };
}

function isValidResolvedSchedule(schedule: unknown): boolean {
  return normalizeResolvedSchedule(schedule) !== null;
}

function normalizeResolvedSchedule(schedule: unknown): unknown | null {
  if (!isRecord(schedule)) {
    return null;
  }
  if (schedule.kind === "cron") {
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
      kind: "cron",
      expression,
      timezone,
    };
  }
  return null;
}

function normalizeResolvedPrompt(
  prompt: string | null | undefined,
): string | null {
  const normalized = normalizeScheduledTaskPrompt(prompt?.trim() ?? "");
  return normalized || null;
}

function resolveSchedulerResolverJobId(
  text: string,
  resolvedJobId: string | null | undefined,
  jobs: Array<{ jobId: string; title: string | null }>,
  explicitJobId: string | null,
): string | null {
  if (explicitJobId) {
    return explicitJobId;
  }

  const jobId = sanitizeSchedulerJobId(resolvedJobId);
  if (!jobId) {
    return null;
  }

  if (text.includes(jobId)) {
    return jobId;
  }

  const selected = jobs.find((job) => job.jobId === jobId);
  const selectedTitle = normalizeSchedulerJobTitle(selected?.title ?? null);
  if (!selectedTitle) {
    return jobId;
  }

  const matchingTitleCount = jobs.filter(
    (job) => normalizeSchedulerJobTitle(job.title) === selectedTitle,
  ).length;
  return matchingTitleCount > 1 ? null : jobId;
}

function normalizeSchedulerJobTitle(title: string | null): string | null {
  const normalized = title?.toLowerCase().replace(/\s+/g, " ").trim();
  return normalized || null;
}

function classifyExplicitSchedulerJobIdIntent(
  text: string,
): SchedulerControlIntent {
  if (!readSchedulerJobIdHint(text)) {
    return null;
  }
  const tokens = tokenizeSchedulerControlText(text);
  if (isSchedulerRunStatusIntent(tokens)) {
    return "latest_run_status";
  }
  if (isSchedulerShowTaskIntent(tokens)) {
    return "show_task";
  }
  if (hasAnyToken(tokens, ["validate", "inspect"])) {
    return "validate_task";
  }
  if (hasAnyToken(tokens, ["pause", "disable", "stop"])) {
    return "pause_job";
  }
  if (hasAnyToken(tokens, ["resume", "enable", "unpause"])) {
    return "resume_job";
  }
  if (hasAnyToken(tokens, ["delete", "remove", "cancel"])) {
    return "delete_job";
  }
  if (isSchedulerDeliveryUpdateIntent(tokens)) {
    return "update_job_delivery";
  }
  if (isSchedulerScheduleUpdateIntent(tokens)) {
    return "update_job_schedule";
  }
  if (hasAnyToken(tokens, ["run", "running", "trigger", "start", "test"])) {
    return "trigger_job";
  }
  return null;
}

function normalizeResolvedSchedulerIntent(
  result: SchedulerIntentResolverResult,
): Exclude<SchedulerControlIntent, null> | null {
  if (result.confidence < 0.7 || result.intent === "none") {
    return null;
  }
  if (
    result.intent === "list_jobs" ||
    result.intent === "list_job_runs" ||
    result.intent === "create_job" ||
    result.intent === "trigger_job" ||
    result.intent === "pause_job" ||
    result.intent === "resume_job" ||
    result.intent === "delete_job" ||
    result.intent === "update_job_delivery" ||
    result.intent === "update_job_schedule" ||
    result.intent === "update_job_prompt" ||
    result.intent === "validate_task" ||
    result.intent === "latest_run_status"
  ) {
    return result.intent;
  }
  return null;
}

function sanitizeSchedulerJobId(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();
  if (!trimmed || !/^[a-z0-9][a-z0-9_.-]{2,}$/i.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function tokenizeSchedulerControlText(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/cronjobs?/g, "cron jobs")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function hasSchedulerListReference(tokens: string[]): boolean {
  if (hasAnyToken(tokens, ["cron"])) {
    return true;
  }
  if (hasAnyToken(tokens, ["task", "tasks"])) {
    return true;
  }
  if (hasScheduledJobReference(tokens)) {
    return true;
  }
  return (
    tokens.includes("jobs") &&
    hasAnyToken(tokens, ["current", "configured", "existing"])
  );
}

function hasSchedulerActionReference(tokens: string[]): boolean {
  if (hasSchedulerListReference(tokens)) {
    return true;
  }
  return (
    tokens.includes("job") &&
    hasAnyToken(tokens, [
      "this",
      "that",
      "existing",
      "current",
      "manual",
      "manually",
      "our",
      "my",
      "the",
    ])
  );
}

function hasScheduledJobReference(tokens: string[]): boolean {
  return (
    hasAdjacentTokens(tokens, "scheduled", "job") ||
    hasAdjacentTokens(tokens, "scheduled", "jobs")
  );
}

function isSchedulerListIntent(tokens: string[]): boolean {
  if (
    tokens.length <= 2 &&
    (hasAdjacentTokens(tokens, "cron", "job") ||
      hasAdjacentTokens(tokens, "cron", "jobs") ||
      hasScheduledJobReference(tokens))
  ) {
    return true;
  }
  if (hasAnyToken(tokens, ["list", "show", "display", "view"])) {
    return true;
  }
  if (
    hasAnyToken(tokens, ["configured", "existing", "current"]) &&
    hasAnyToken(tokens, ["what", "which", "any", "have", "there"])
  ) {
    return true;
  }
  return (
    hasSequence(tokens, ["set", "up"]) && hasAnyToken(tokens, ["what", "which"])
  );
}

function isSchedulerRunStatusIntent(tokens: string[]): boolean {
  if (hasAnyToken(tokens, ["status", "state"])) {
    return true;
  }
  return (
    hasAnyToken(tokens, [
      "finish",
      "finished",
      "complete",
      "completed",
      "succeed",
      "succeeded",
      "fail",
      "failed",
    ]) && hasAnyToken(tokens, ["run", "execution", "manual", "manually"])
  );
}

function isSchedulerJobRunListIntent(tokens: string[]): boolean {
  if (!hasAnyToken(tokens, ["list", "show", "display", "view", "recent"])) {
    return false;
  }
  if (hasAnyToken(tokens, ["cron", "task", "tasks", "scheduled"])) {
    return false;
  }
  return (
    hasAnyToken(tokens, ["run", "runs", "execution", "executions"]) ||
    hasAdjacentTokens(tokens, "job", "history") ||
    hasAdjacentTokens(tokens, "job", "runs") ||
    hasAdjacentTokens(tokens, "jobs", "history") ||
    hasAnyToken(tokens, ["jobs"])
  );
}

function isSchedulerValidateTaskIntent(tokens: string[]): boolean {
  if (!hasAnyToken(tokens, ["validate", "inspect"])) {
    return false;
  }
  return hasAnyToken(tokens, ["task", "tasks", "job", "jobs", "cron"]);
}

function isSchedulerShowTaskIntent(tokens: string[]): boolean {
  if (
    !hasAnyToken(tokens, ["show", "describe", "detail", "details", "inspect"])
  ) {
    return false;
  }
  if (
    hasAnyToken(tokens, ["list", "all", "current"]) &&
    !hasAnyToken(tokens, ["detail", "details"])
  ) {
    return false;
  }
  return hasAnyToken(tokens, ["task", "job", "cron"]);
}

function isSchedulerTriggerIntent(tokens: string[]): boolean {
  if (!hasAnyToken(tokens, ["run", "running", "trigger", "start"])) {
    return false;
  }
  if (looksLikeSchedulerCreationRequest(tokens)) {
    return false;
  }
  if (
    hasAnyToken(tokens, ["cron"]) ||
    hasScheduledJobReference(tokens) ||
    tokens.some((token) => /^job[_-][a-z0-9_.-]{2,}$/i.test(token))
  ) {
    return true;
  }
  return (
    hasAnyToken(tokens, [
      "manual",
      "manually",
      "now",
      "this",
      "that",
      "existing",
      "current",
      "our",
      "my",
      "the",
    ]) || hasAnyToken(tokens, ["trigger"])
  );
}

function isSchedulerDeliveryUpdateIntent(tokens: string[]): boolean {
  if (looksLikeSchedulerCreationRequest(tokens)) {
    return false;
  }
  if (!hasAnyToken(tokens, ["change", "modify", "move", "switch", "update"])) {
    return false;
  }
  if (
    !hasAnyToken(tokens, ["channel", "delivery", "deliver", "post", "send"])
  ) {
    return false;
  }
  return (
    hasAnyToken(tokens, ["cron", "task", "tasks"]) ||
    hasScheduledJobReference(tokens) ||
    hasSchedulerActionReference(tokens) ||
    tokens.some((token) => /^job[_-][a-z0-9_.-]{2,}$/i.test(token))
  );
}

function isSchedulerScheduleUpdateIntent(tokens: string[]): boolean {
  if (!hasAnyToken(tokens, ["change", "modify", "reschedule", "update"])) {
    return false;
  }
  if (!(
    hasAnyToken(tokens, ["hourly", "daily", "weekly"]) ||
    hasAdjacentTokens(tokens, "every", "minute") ||
    hasAdjacentTokens(tokens, "every", "minutes") ||
    tokens.includes("every")
  )) {
    return false;
  }
  return (
    hasAnyToken(tokens, ["cron", "job", "jobs", "task", "tasks"]) ||
    hasScheduledJobReference(tokens) ||
    tokens.some((token) => /^job[_-][a-z0-9_.-]{2,}$/i.test(token))
  );
}

function looksLikeSchedulerCreationRequest(tokens: string[]): boolean {
  return (
    hasAnyToken(tokens, ["create", "make", "schedule", "add"]) ||
    hasAnyToken(tokens, ["every", "hourly", "daily", "weekly"]) ||
    hasSequence(tokens, ["set", "up"])
  );
}

type ParsedSchedulerCreateRequest = {
  title: string;
  prompt: string;
  schedule: unknown;
  scheduleLabel: string;
};

type ParsedSchedulerDeliveryUpdateRequest = {
  routeId: string | null;
  channelId: string | null;
  channelName: string | null;
};

function parseSchedulerDeliveryUpdateRequest(
  request: ConversationRequest,
): ParsedSchedulerDeliveryUpdateRequest {
  const mention = /<#([A-Z0-9]+)(?:\|([^>]+))?>/.exec(request.text);
  if (mention) {
    return {
      routeId: null,
      channelId: mention[1],
      channelName: normalizeSlackChannelName(mention[2] ?? null),
    };
  }

  if (
    /\b(?:this|current|here)\s+(?:channel|conversation|thread)\b/i.test(
      request.text,
    )
  ) {
    return {
      routeId: request.conversationRouteId ?? null,
      channelId: null,
      channelName: null,
    };
  }

  const channelName = /(^|\s)#([a-z0-9][a-z0-9_-]*)\b/i.exec(request.text);
  return {
    routeId: null,
    channelId: null,
    channelName: channelName ? normalizeSlackChannelName(channelName[2]) : null,
  };
}

function normalizeSlackChannelName(value: string | null): string | null {
  const normalized = value?.trim().replace(/^#/, "").toLowerCase();
  return normalized || null;
}

function parseSchedulerCreateRequest(
  text: string,
): ParsedSchedulerCreateRequest | null {
  const tokens = tokenizeSchedulerControlText(text);
  if (!looksLikeSchedulerCreationRequest(tokens)) {
    return null;
  }
  if (
    !hasAnyToken(tokens, ["cron", "job"]) &&
    !hasScheduledJobReference(tokens)
  ) {
    return null;
  }

  const schedule = parseExplicitIntervalSchedule(text);
  if (!schedule) {
    return null;
  }

  const prompt = extractScheduledTaskPrompt(text);
  if (!prompt) {
    return null;
  }

  return {
    title: inferScheduledJobTitle(prompt, schedule.label),
    prompt,
    schedule: schedule.value,
    scheduleLabel: schedule.label,
  };
}

function parseExplicitIntervalSchedule(
  text: string,
): { value: unknown; label: string } | null {
  const normalized = text.toLowerCase();
  if (
    /\bhourly\b|\bevery\s+(?:1\s+)?hours?\b|\bevery\s+60\s*(?:m|min|mins|minutes?)\b/.test(
      normalized,
    )
  ) {
    return {
      value: { kind: "cron", expression: "0 * * * *", timezone: "UTC" },
      label: "every 60m",
    };
  }
  if (/\bdaily\b|\bevery\s+(?:1\s+)?days?\b/.test(normalized)) {
    return {
      value: { kind: "cron", expression: "0 0 * * *", timezone: "UTC" },
      label: "every 1d",
    };
  }
  if (/\bweekly\b|\bevery\s+(?:1\s+)?weeks?\b/.test(normalized)) {
    return {
      value: { kind: "cron", expression: "0 0 * * 1", timezone: "UTC" },
      label: "every 1w",
    };
  }

  const everyMatch =
    /\bevery\s+(\d+)\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/i.exec(text);
  if (!everyMatch) {
    return null;
  }

  const amount = Number(everyMatch[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return null;
  }
  const unit = everyMatch[2].toLowerCase();
  if (["minute", "minutes", "min", "mins", "m"].includes(unit)) {
    return {
      value: {
        kind: "cron",
        expression: amount === 1 ? "* * * * *" : `*/${amount} * * * *`,
        timezone: "UTC",
      },
      label: `every ${amount}m`,
    };
  }
  if (["hour", "hours", "hr", "hrs", "h"].includes(unit)) {
    return {
      value: {
        kind: "cron",
        expression: amount === 1 ? "0 * * * *" : `0 */${amount} * * *`,
        timezone: "UTC",
      },
      label: `every ${amount}h`,
    };
  }
  if (["day", "days", "d"].includes(unit)) {
    return {
      value: {
        kind: "cron",
        expression: amount === 1 ? "0 0 * * *" : `0 0 */${amount} * *`,
        timezone: "UTC",
      },
      label: `every ${amount}d`,
    };
  }
  return null;
}

function extractScheduledTaskPrompt(text: string): string {
  const prompt = text
    .trim()
    .replace(
      /^\s*(?:please\s+)?(?:create|add|make|schedule|set\s+up)\s+(?:an?\s+|new\s+)?(?:(?:hourly|daily|weekly)\s+|every\s+\d+\s*(?:minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w)\s+)?(?:(?:scheduled\s+)?(?:cron\s+job|cronjob|job|task))\s*[,;:-]?\s*(?:to|that|which|for)?\s*/i,
      "",
    )
    .trim()
    .replace(
      /^(?:to\s+)?(?:be\s+)?run\s+(?:hourly|daily|weekly|every\s+(?:\d+\s*)?(?:minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w))\s*[,;:-]?\s*(?:to\s+)?/i,
      "",
    )
    .trim()
    .replace(
      /\s*(?:,|;|-)?\s*(?:to\s+be\s+)?run\s+(?:hourly|daily|weekly|every\s+(?:\d+\s*)?(?:minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w))\b\s*,?\s*/gi,
      " ",
    )
    .replace(
      /\s*\b(?:hourly|daily|weekly|every\s+\d+\s*(?:minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w))\b\s*,?\s*/gi,
      " ",
    )
    .replace(
      /\s*(?:,|;|-)?\s*(?:and\s+)?(?:post|send|report)\s+(?:the\s+)?(?:result|results|output|report)?\s*(?:back\s+)?(?:in|to)\s+(?:this|the\s+current)\s+(?:channel|chat|conversation|thread)\b/gi,
      " ",
    )
    .replace(
      /\s*(?:,|;|-)?\s*(?:and\s+)?(?:post|send|report)\s+(?:back\s+)?(?:in|to)\s+(?:this|the\s+current)\s+(?:channel|chat|conversation|thread)\b/gi,
      " ",
    )
    .replace(
      /\s*(?:,|;|-)?\s*(?:in|to)\s+(?:this|the\s+current)\s+(?:channel|chat|conversation|thread)\b/gi,
      " ",
    )
    .replace(/\s+,/g, ",")
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/[.。]\s*$/, "")
    .trim();
  return normalizeScheduledTaskPrompt(prompt);
}

function normalizeScheduledTaskPrompt(prompt: string): string {
  const stripped = stripScheduledTaskControlClauses(prompt);
  const normalized = stripped.toLowerCase();
  if (/\b(?:output|post|send)\s+(?:a\s+)?heart\s+emoji\b/.test(normalized)) {
    return "Post exactly this message: ❤️";
  }
  return stripped;
}

function stripScheduledTaskControlClauses(prompt: string): string {
  return prompt
    .replace(
      /\s*(?:,|;|-)?\s*(?:and\s+)?(?:post|send|report)\s+(?:the\s+)?(?:result|results|output|report)?\s*(?:back\s+)?(?:in|to)\s+(?:this|the\s+current)\s+(?:channel|chat|conversation|thread)\b/gi,
      " ",
    )
    .replace(
      /\s*(?:,|;|-)?\s*(?:and\s+)?(?:post|send|report)\s+(?:back\s+)?(?:in|to)\s+(?:this|the\s+current)\s+(?:channel|chat|conversation|thread)\b/gi,
      " ",
    )
    .replace(
      /\s*(?:,|;|-)?\s*(?:in|to)\s+(?:this|the\s+current)\s+(?:channel|chat|conversation|thread)\b/gi,
      " ",
    )
    .replace(
      /\s*(?:,|;|-)?\s*(?:and\s+)?(?:post|send|report)\s+(?:the\s+)?(?:result|results|output|report)\b\s*$/gi,
      " ",
    )
    .replace(
      /\s*(?:,|;|-)?\s*(?:to\s+be\s+)?run\s+(?:hourly|daily|weekly|every\s+(?:\d+\s*)?(?:minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w))\b\s*,?\s*/gi,
      " ",
    )
    .replace(
      /\s*\b(?:hourly|daily|weekly|every\s+\d+\s*(?:minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w))\b\s*,?\s*/gi,
      " ",
    )
    .replace(/\s+,/g, ",")
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/[.。]\s*$/, "")
    .trim();
}

function inferScheduledJobTitle(prompt: string, scheduleLabel: string): string {
  const normalized = prompt.toLowerCase();
  const prefix =
    scheduleLabel === "every 60m"
      ? "Hourly"
      : scheduleLabel === "every 1d"
        ? "Daily"
        : scheduleLabel === "every 1w"
          ? "Weekly"
          : "Scheduled";
  if (normalized.includes("ai") && normalized.includes("news")) {
    return `${prefix} AI news summary`;
  }
  if (
    normalized.includes("github") &&
    /\b(?:open\s+prs?|pull\s+requests?)\b/.test(normalized)
  ) {
    const org = /github\.com\/([a-z0-9_.-]+)/i.exec(prompt)?.[1];
    return org ? `${prefix} open PRs for ${org}` : `${prefix} open PRs`;
  }
  if (normalized.includes("❤️") || /\bheart\s+emoji\b/.test(normalized)) {
    return `${prefix} heart emoji`;
  }
  const words = prompt
    .replace(/[^a-z0-9 ]+/gi, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);
  if (words.length === 0) {
    return `${prefix} scheduled job`;
  }
  return `${prefix} ${words.join(" ")}`;
}

function hasAnyToken(tokens: string[], candidates: string[]): boolean {
  return candidates.some((candidate) => tokens.includes(candidate));
}

function hasAdjacentTokens(
  tokens: string[],
  first: string,
  second: string,
): boolean {
  return tokens.some(
    (token, index) => token === first && tokens[index + 1] === second,
  );
}

function hasSequence(tokens: string[], sequence: string[]): boolean {
  return tokens.some((token, index) => {
    if (token !== sequence[0]) {
      return false;
    }
    return sequence.every(
      (sequenceToken, offset) => tokens[index + offset] === sequenceToken,
    );
  });
}

export function formatScheduledJobList(
  jobs: Array<{
    jobId: string;
    title: string | null;
    state: string;
    runtimeType: string | null;
    requiredTools: string[];
    routeId: string | null;
    updatedAt: string;
  }>,
): string {
  if (jobs.length === 0) {
    return "No scheduled tasks are configured.";
  }

  const lines = ["Scheduled tasks"];
  for (const job of jobs) {
    const details = [
      job.title ? job.title : null,
      `state: ${job.state}`,
      job.runtimeType ? `runtime: ${job.runtimeType}` : null,
      job.requiredTools.length
        ? `tools: ${job.requiredTools.join(", ")}`
        : null,
      job.routeId ? `route: ${job.routeId}` : null,
      `updated: ${job.updatedAt}`,
    ].filter((value): value is string => Boolean(value));
    lines.push(`- ${job.jobId} - ${details.join("; ")}`);
  }
  return lines.join("\n");
}

export function formatScheduledJobRunList(
  runs: Array<{
    runId: string;
    jobId: string;
    status: string;
    triggerSource: string;
    updatedAt: string;
    failureReason: string | null;
  }>,
): string {
  if (runs.length === 0) {
    return "No job runs have been recorded yet.";
  }

  const lines = ["Job runs"];
  for (const run of runs) {
    const details = [
      `task: ${run.jobId}`,
      `status: ${run.status}`,
      `triggered: ${run.triggerSource}`,
      `updated: ${run.updatedAt}`,
      run.failureReason ? `failure: ${run.failureReason}` : null,
    ].filter((value): value is string => Boolean(value));
    lines.push(`- ${run.runId} - ${details.join("; ")}`);
  }
  return lines.join("\n");
}

export function formatScheduledTaskDetailResult(
  result: SchedulerShowTaskResult,
): string {
  if (!result.ok) {
    if (result.reason === "no_jobs") {
      return "No scheduled tasks are configured.";
    }
    if (result.reason === "not_found") {
      return "I could not find that scheduled task.";
    }
    return [
      "Multiple scheduled tasks are configured. Please specify the task id.",
      ...result.tasks.map((task) => `- ${task.taskId}`),
    ].join("\n");
  }

  const task = result.task;
  const validation = result.validation;
  const lines = [
    "Scheduled task",
    `- task: ${task.taskId}`,
    task.title ? `- name: ${task.title}` : null,
    task.prompt ? `- prompt: ${task.prompt}` : null,
    task.schedule
      ? `- schedule: ${formatScheduleForSlack(task.schedule)}`
      : null,
    `- state: ${task.state}`,
    task.runtimeType ? `- runtime: ${task.runtimeType}` : null,
    task.routeId ? `- route: ${task.routeId}` : null,
    task.requiredTools.length
      ? `- granted tools: ${task.requiredTools.join(", ")}`
      : "- granted tools: none",
    validation.expectedTools.length
      ? `- expected tools: ${validation.expectedTools.join(", ")}`
      : "- expected tools: none",
    `- validation: ${validation.ok ? "passed" : "failed"}`,
    `- updated: ${task.updatedAt}`,
  ].filter((line): line is string => Boolean(line));

  if (validation.errors.length) {
    lines.push("Errors");
    for (const issue of validation.errors) {
      lines.push(`- ${issue.code}: ${issue.message}`);
    }
  }

  if (validation.warnings.length) {
    lines.push("Warnings");
    for (const issue of validation.warnings) {
      lines.push(`- ${issue.code}: ${issue.message}`);
    }
  }

  return lines.join("\n");
}

export function formatScheduledTaskValidationResult(
  result: SchedulerValidateTaskResult,
): string {
  if (!result.ok) {
    if (result.reason === "no_jobs") {
      return "No scheduled tasks are configured.";
    }
    if (result.reason === "not_found") {
      return "I could not find that scheduled task.";
    }
    return [
      "Multiple scheduled tasks are configured. Please specify the task id.",
      ...result.tasks.map((task) => `- ${task.taskId}`),
    ].join("\n");
  }

  const validation = result.validation;
  const lines = [
    validation.ok ? "Task validation passed" : "Task validation failed",
    `- task: ${result.taskId}`,
    validation.expectedTools.length
      ? `- expected tools: ${validation.expectedTools.join(", ")}`
      : "- expected tools: none",
    validation.grantedTools.length
      ? `- granted tools: ${validation.grantedTools.join(", ")}`
      : "- granted tools: none",
  ];

  if (validation.errors.length) {
    lines.push("Errors");
    for (const issue of validation.errors) {
      lines.push(`- ${issue.code}: ${issue.message}`);
    }
  }

  if (validation.warnings.length) {
    lines.push("Warnings");
    for (const issue of validation.warnings) {
      lines.push(`- ${issue.code}: ${issue.message}`);
    }
  }

  return lines.join("\n");
}

export function formatScheduledJobTriggerResult(
  result: SchedulerTriggerResult,
): string {
  if (result.ok) {
    return [
      `Triggered scheduled job ${result.jobId}.`,
      `Run ID: ${result.run.runId}`,
      `Status: ${result.run.status}`,
    ].join("\n");
  }

  if (result.reason === "no_jobs") {
    return "No scheduled tasks are configured.";
  }
  if (result.reason === "not_found") {
    return "I could not find that scheduled job.";
  }
  if (result.reason === "validation_failed") {
    return [
      "Scheduled task validation failed; not triggering a run.",
      `- task: ${result.task.taskId}`,
      result.validation.expectedTools.length
        ? `- expected tools: ${result.validation.expectedTools.join(", ")}`
        : "- expected tools: none",
      result.validation.grantedTools.length
        ? `- granted tools: ${result.validation.grantedTools.join(", ")}`
        : "- granted tools: none",
      ...result.validation.errors.map(
        (issue) => `- ${issue.code}: ${issue.message}`,
      ),
    ].join("\n");
  }
  if (result.reason === "already_running") {
    return [
      result.run.status === "failed"
        ? `Scheduled job ${result.jobId} already has a recent failed run.`
        : `Scheduled job ${result.jobId} already has an active run.`,
      `Run ID: ${result.run.runId}`,
      `Status: ${result.run.status}`,
    ].join("\n");
  }
  return [
    "Multiple scheduled jobs are configured. Please specify the job id.",
    ...result.jobs.map((job) => `- ${job.jobId}`),
  ].join("\n");
}

export function formatScheduledJobCreateResult(
  result: SchedulerCreateJobResult,
): string {
  if (!result.ok) {
    return `I can’t create that scheduled task because the schedule is unsupported: ${result.message}`;
  }
  return [
    `Created scheduled job ${result.job.jobId}.`,
    `- name: ${result.job.title}`,
    `- schedule: ${formatScheduleForSlack(result.job.schedule)}`,
    `- state: ${result.job.state}`,
    result.job.runtimeType ? `- runtime: ${result.job.runtimeType}` : null,
    result.job.routeId ? `- delivery: this conversation` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function formatUnresolvedScheduledJobCreate(): string {
  return [
    "I can’t create that scheduled task yet because I could not resolve a complete task spec.",
    "Please include what to run, how often to run it, and where to deliver the result.",
  ].join("\n");
}

function formatSchedule(schedule: unknown): string {
  if (!isRecord(schedule)) {
    return "unknown";
  }
  if (schedule.kind === "cron") {
    const expression =
      typeof schedule.expression === "string" && schedule.expression.trim()
        ? schedule.expression.trim()
        : "unknown";
    const timezone =
      typeof schedule.timezone === "string" && schedule.timezone.trim()
        ? schedule.timezone.trim()
        : "UTC";
    return `cron ${expression} (${timezone})`;
  }
  if (schedule.kind === "interval") {
    const every = schedule.every;
    if (!isRecord(every)) {
      return "interval unknown";
    }
    const parts = [
      formatIntervalPart(every.weeks, "w"),
      formatIntervalPart(every.days, "d"),
      formatIntervalPart(every.hours, "h"),
      formatIntervalPart(every.minutes, "m"),
    ].filter((value): value is string => Boolean(value));
    const anchor =
      typeof schedule.anchor === "string" && schedule.anchor.trim()
        ? schedule.anchor.trim()
        : "last run or updated time";
    return `interval every ${parts.join(" ") || "unknown"} (anchor: ${anchor})`;
  }
  return String(schedule.kind ?? "unknown");
}

function formatScheduleForSlack(schedule: unknown): string {
  return `\`${formatSchedule(schedule)}\``;
}

function formatIntervalPart(value: unknown, suffix: string): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return `${Math.floor(value)}${suffix}`;
}

export function formatScheduledJobMutationResult(
  verb: "Paused" | "Resumed",
  result: SchedulerJobMutationResult,
): string {
  if (result.ok) {
    return `${verb} scheduled job ${result.job.jobId}.`;
  }
  return formatScheduledJobSelectionFailure(result);
}

export function formatScheduledJobDeleteResult(
  result: SchedulerJobDeleteResult,
): string {
  if (result.ok) {
    return `Deleted scheduled job ${result.jobId}.`;
  }
  return formatScheduledJobSelectionFailure(result);
}

function formatScheduledJobDeliveryUpdateResult(
  result: SchedulerUpdateJobDeliveryResult,
): string {
  if (result.ok) {
    return [
      `Updated scheduled job ${result.job.jobId} delivery.`,
      `- route: ${result.routeId}`,
    ].join("\n");
  }
  if (
    result.reason === "no_jobs" ||
    result.reason === "not_found" ||
    result.reason === "ambiguous"
  ) {
    return formatScheduledJobSelectionFailure(result);
  }
  if (result.reason === "no_destination") {
    return "I could not find a delivery destination in that request.";
  }
  if (result.reason === "unresolved_channel") {
    const channel = result.channelName
      ? `#${result.channelName}`
      : "that channel";
    return `I can’t resolve \`${channel}\` from this message. Mention the Slack channel directly, or grant Burble access from that channel and retry.`;
  }
  const channel = result.channelId ? `<#${result.channelId}>` : "that channel";
  return `No scheduled-job delivery grant exists for ${channel}. Grant Burble access from that channel, then retry.`;
}

export function formatScheduledJobScheduleUpdateResult(
  result: SchedulerUpdateJobScheduleResult,
): string {
  if (result.ok) {
    return [
      `Updated scheduled job ${result.job.jobId} schedule.`,
      `- schedule: ${formatScheduleForSlack(result.job.schedule)}`,
    ].join("\n");
  }
  if (result.reason === "invalid_schedule") {
    return `I can’t update that scheduled task schedule because it is unsupported: ${result.message}`;
  }
  return formatScheduledJobSelectionFailure(result);
}

export function formatScheduledJobPromptUpdateResult(
  result: SchedulerUpdateJobPromptResult,
): string {
  if (result.ok) {
    return [
      `Updated scheduled job ${result.job.jobId} task.`,
      `- prompt: ${result.job.prompt}`,
    ].join("\n");
  }
  return formatScheduledJobSelectionFailure(result);
}

function formatScheduledJobSelectionFailure(
  result:
    | Extract<SchedulerJobMutationResult, { ok: false }>
    | Extract<SchedulerJobDeleteResult, { ok: false }>
    | Extract<SchedulerUpdateJobDeliveryResult, { ok: false }>
    | Extract<SchedulerUpdateJobScheduleResult, { ok: false }>,
): string {
  if (result.reason === "no_jobs") {
    return "No scheduled tasks are configured.";
  }
  if (result.reason === "not_found") {
    return "I could not find that scheduled job.";
  }
  return [
    "Multiple scheduled jobs are configured. Please specify the job id.",
    ...result.jobs.map((job) => `- ${job.jobId}`),
  ].join("\n");
}

export function formatScheduledRunStatusResult(
  result: SchedulerRunStatusResult,
): string {
  if (!result.ok) {
    return "No scheduled job runs have been recorded yet.";
  }

  return [
    "Latest scheduled job run",
    `- job: ${result.run.jobId}`,
    `- run: ${result.run.runId}`,
    `- status: ${result.run.status}`,
    `- triggered: ${result.run.triggerSource}`,
    `- updated: ${result.run.updatedAt}`,
    ...(result.run.failureReason
      ? [`- failure: ${result.run.failureReason}`]
      : []),
  ].join("\n");
}

function readSchedulerJobIdHint(text: string): string | null {
  const match =
    /\b(?:task|job|cron\s+job|scheduled\s+job)\s+(job_[a-z0-9_.-]{3,})\b/i.exec(
      text,
    ) ??
    /\b(?:task|job|cron\s+job|scheduled\s+job)\s+(?:id\s*)?(?:[:#]\s*|\bis\s+)([a-z0-9][a-z0-9_.-]{2,})\b/i.exec(
      text,
    ) ??
    /\b(?:task|job|cron\s+job|scheduled\s+job)\s+id\s+([a-z0-9][a-z0-9_.-]{2,})\b/i.exec(
      text,
    );
  return match?.[1] ?? null;
}

function emitConversationStarted(
  traceId: string,
  request: ConversationRequest,
  deps: ConversationDeps,
): void {
  deps.observability?.emit({
    name: "conversation.request.started",
    traceId,
    workspaceId: request.workspaceId,
    principalId: principalId(request),
    routeId: request.conversationRouteId,
    sessionId: request.threadTs ?? request.messageTs,
    attributes: {
      source: request.source,
      channelId: request.channelId,
      isDirectMessage: request.isDirectMessage,
      textLength: request.text.length,
      attachmentCount: request.attachments?.length ?? 0,
      agentMode: deps.agentMode ?? "deterministic",
      fastTrackEnabled: shouldUseFastTrack(deps),
      hasAgentRunner: Boolean(deps.agentRunner),
      ...toolGroupAttributes(request),
    },
    content: {
      text: request.text,
    },
  });
}

function toolGroupAttributes(request: ConversationRequest): {
  toolGroups: string[];
  toolGroupReasons: string[];
} {
  const selection = selectRuntimeToolGroups({
    text: request.text,
    attachmentCount: request.attachments?.length ?? 0,
    contextTexts: recentConversationTexts(request),
  });
  return {
    toolGroups: selection.groups,
    toolGroupReasons: selection.reasons,
  };
}

function recentConversationTexts(request: ConversationRequest): string[] {
  return (request.context?.recentMessages ?? [])
    .map((message) => message.text)
    .filter((text) => text.trim().length > 0);
}

function emitConversationCompleted(
  traceId: string,
  request: ConversationRequest,
  response: ConversationResponse,
  deps: ConversationDeps,
  startedAt: number,
): void {
  deps.observability?.emit({
    name: "conversation.response.completed",
    traceId,
    workspaceId: request.workspaceId,
    principalId: principalId(request),
    routeId: request.conversationRouteId,
    sessionId: request.threadTs ?? request.messageTs,
    classification: response.classification,
    durationMs: Date.now() - startedAt,
    status: "ok",
    usage: response.usage,
    attributes: {
      visibility: response.visibility,
      textLength: response.text.length,
      attachmentCount: response.attachments?.length ?? 0,
      blockCount: response.blocks?.length ?? 0,
    },
    content: {
      text: response.text,
    },
  });
}

function emitConversationFailed(
  traceId: string,
  request: ConversationRequest,
  deps: ConversationDeps,
  startedAt: number,
  error: unknown,
): void {
  deps.observability?.emit({
    name: "conversation.request.failed",
    traceId,
    workspaceId: request.workspaceId,
    principalId: principalId(request),
    routeId: request.conversationRouteId,
    sessionId: request.threadTs ?? request.messageTs,
    durationMs: Date.now() - startedAt,
    status: "error",
    error: errorToObservabilityError(error),
  });
}

function emitAgentEvent(
  traceId: string,
  request: ConversationRequest,
  deps: ConversationDeps,
  event: AgentRunEvent,
): void {
  const common = {
    traceId,
    workspaceId: request.workspaceId,
    principalId: principalId(request),
    routeId: request.conversationRouteId,
    sessionId: request.threadTs ?? request.messageTs,
  };

  if (event.type === "tool_call") {
    deps.observability?.emit({
      ...common,
      name: "tool.call.started",
      toolName: event.toolName,
      callId: event.callId,
    });
    return;
  }

  if (event.type === "tool_result") {
    deps.observability?.emit({
      ...common,
      name: "tool.call.completed",
      toolName: event.toolName,
      callId: event.callId,
      classification: event.classification,
      status: "ok",
    });
    return;
  }

  if (event.type === "status") {
    deps.observability?.emit({
      ...common,
      name: "agent.status",
      attributes: {
        text: event.text,
      },
    });
    return;
  }

  if (event.type === "message_delta" || event.type === "message_replace") {
    deps.observability?.emit({
      ...common,
      name:
        event.type === "message_replace"
          ? "agent.message.replace"
          : "agent.message.delta",
      attributes: {
        textLength: event.text.length,
      },
      content: {
        text: event.text,
      },
    });
  }
}

function principalId(request: ConversationRequest): string {
  return `${request.workspaceId}:${request.user.slackUserId}`;
}

function errorToObservabilityError(error: unknown): {
  name?: string;
  message: string;
} {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }

  return { message: String(error) };
}

function shouldUseFastTrack(deps: ConversationDeps): boolean {
  if (deps.agentFastTrack) {
    return true;
  }

  return deps.agentMode !== "llm" || !deps.agentRunner;
}

function dispatchSchedulerRunQueued(
  deps: ConversationDeps,
  run: Parameters<NonNullable<ConversationDeps["onSchedulerRunQueued"]>>[0],
): void {
  try {
    const result = deps.onSchedulerRunQueued?.(run);
    if (result) {
      void Promise.resolve(result).catch(() => undefined);
    }
  } catch {
    // The durable run is already queued; dispatch failures can be retried later.
  }
}

function buildAgentConversation(request: ConversationRequest) {
  return {
    ...(request.conversationRouteId
      ? { routeId: request.conversationRouteId }
      : {}),
    source: request.source,
    workspaceId: request.workspaceId,
    channelId: request.channelId,
    rootId: buildConversationRootId(request),
    isDirectMessage: request.isDirectMessage,
  };
}

function buildConversationRootId(request: ConversationRequest): string {
  if (request.isDirectMessage) {
    return request.threadTs
      ? `dm:${request.channelId}:thread:${request.threadTs}`
      : `dm:${request.channelId}`;
  }

  return `channel:${request.channelId}:thread:${request.threadTs ?? request.messageTs}`;
}

type DeterministicIntent =
  | "connect_github"
  | "connect_google"
  | "connect_hubspot"
  | "connect_jira"
  | "connect_slack"
  | "github_identity"
  | "github_issues"
  | "github_issue_search"
  | "github_pull_requests"
  | "help";

export function classifyDeterministicIntent(text: string): DeterministicIntent {
  const normalized = text.toLowerCase();

  if (/\bconnect\s+github\b/.test(normalized)) {
    return "connect_github";
  }

  if (/\bconnect\s+google\b/.test(normalized)) {
    return "connect_google";
  }

  if (/\bconnect\s+hub\s?spot\b/.test(normalized)) {
    return "connect_hubspot";
  }

  if (/\bconnect\s+(jira|atlassian)\b/.test(normalized)) {
    return "connect_jira";
  }

  if (/\bconnect\s+slack\b/.test(normalized)) {
    return "connect_slack";
  }

  if (
    /\bwho\s+am\s+i\b/.test(normalized) ||
    /\bgithub\s+(me|identity|login)\b/.test(normalized)
  ) {
    return "github_identity";
  }

  if (/\b(pull request|pull requests|prs?|reviews?)\b/.test(normalized)) {
    return "github_pull_requests";
  }

  if (/\bsearch\b/.test(normalized) && /\b(issue|issues)\b/.test(normalized)) {
    return "github_issue_search";
  }

  if (/\b(issue|issues)\b/.test(normalized)) {
    return "github_issues";
  }

  return "help";
}

export function shouldForceAgentDelegation(text: string): boolean {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  return (
    /\b(cron|cronjob|cronjobs|job|jobs)\b/.test(normalized) ||
    isProviderMutationRequest(normalized) ||
    /\bask\s+(the\s+)?(agent|subagent)\b/.test(normalized) ||
    /\b(agent|subagent)\s+(please\s+)?(create|make|schedule|run|list|show|tell|answer|post|send)\b/.test(
      normalized,
    ) ||
    /\b(create|make|set|schedule|modify|update|delete|remove|list|run|start|add)\b.*\b(cron|job|task|subagent|scheduled job|schedule|reminder|background task)\b/.test(
      normalized,
    ) ||
    /\b(one[-\s]?shot|every\s+\d+|in\s+\d+\s+(second|seconds|minute|minutes|hour|hours))\b.*\b(cron|job|task|scheduled|schedule|post|send|report)\b/.test(
      normalized,
    )
  );
}

function isProviderMutationRequest(normalizedText: string): boolean {
  const mutationVerb =
    "add|request|remove|delete|assign|unassign|comment|reply|create|update|edit|close|merge|label|unlabel";
  const providerObject =
    "github|pull request|pr|issue|review|reviewer|label|comment|description|body";
  return (
    /\bopen\s+(?:a|an|new)\b.*\b(github|pull request|pr)\b/.test(
      normalizedText,
    ) ||
    new RegExp(`\\b(${mutationVerb})\\b.*\\b(${providerObject})\\b`).test(
      normalizedText,
    ) ||
    new RegExp(`\\b(${providerObject})\\b.*\\b(${mutationVerb})\\b`).test(
      normalizedText,
    )
  );
}

function buildIssueSearchQuery(text: string): string {
  const normalized = text
    .replace(/\b(search|github|issue|issues|for|about)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  return normalized ? `is:issue ${normalized}` : "is:issue";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
