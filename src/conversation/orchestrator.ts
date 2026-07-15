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
  SchedulerUpdateJobResult,
  SchedulerUpdateJobPromptResult,
  SchedulerUpdateJobRuntimeResult,
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
  SchedulerTaskPlan,
} from "./types";
import type { AgentRuntimeEngine } from "../db";
import { isAgentRuntimeEngine } from "@burble/runtime-sdk/runtime-engines";
import {
  executeScheduledTaskPreparation,
  type ScheduledTaskPreparationResult,
} from "../scheduler/task-preparation";

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
  const schedulerJobIdHint = schedulerResolution.jobId;
  const schedulerCreateRequest =
    schedulerControlIntent === "create_job"
      ? schedulerResolution.create
      : null;
  const schedulerDeliveryUpdateRequest =
    schedulerControlIntent === "update_job_delivery"
      ? parseSchedulerDeliveryUpdateRequest(request)
      : null;
  const schedulerScheduleUpdateRequest =
    schedulerControlIntent === "update_job_schedule" ||
    schedulerControlIntent === "update_job"
      ? normalizeResolvedSchedule(schedulerResolution.schedule)
      : null;
  const schedulerPromptUpdateRequest =
    schedulerControlIntent === "update_job_prompt" ||
    schedulerControlIntent === "update_job"
      ? normalizeResolvedPrompt(schedulerResolution.prompt)
      : null;
  const schedulerRuntimeUpdateRequest =
    (schedulerControlIntent === "update_job_runtime" ||
      schedulerControlIntent === "update_job") &&
    isAgentRuntimeEngine(schedulerResolution.runtimeType)
      ? schedulerResolution.runtimeType
      : null;
  const schedulerTaskPlan = schedulerResolution.taskPlan;
  if (
    schedulerResolution.failure &&
    isExplicitSchedulerControlRequest(request.text)
  ) {
    return {
      visibility: "ephemeral",
      classification: "user_private",
      text: "I couldn’t resolve that scheduled-job request. No scheduled-job changes were made; please retry.",
    };
  }
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
      text: `<${await deps.createGoogleOAuthUrl(request.user.slackUserId)}|Connect your Google account>`,
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
    schedulerControlIntent === "update_job" &&
    deps.schedulerControl?.updateJob
  ) {
    const preparation = await prepareResolvedScheduledTask(
      request,
      deps,
      schedulerTaskPlan,
    );
    if (!preparation.ok) {
      return preparation.response;
    }
    const prompt = preparation.result?.prompt ?? schedulerPromptUpdateRequest;
    if (
      !prompt &&
      !schedulerScheduleUpdateRequest &&
      !schedulerRuntimeUpdateRequest
    ) {
      return {
        visibility: "ephemeral",
        classification: "user_private",
        text: "I can’t update that scheduled task yet because I could not resolve any requested changes.",
      };
    }
    const result = await deps.schedulerControl.updateJob({
      workspaceId: request.workspaceId,
      slackUserId: request.user.slackUserId,
      jobId: schedulerJobIdHint,
      ...(prompt
        ? { prompt }
        : {}),
      ...(schedulerScheduleUpdateRequest
        ? { schedule: schedulerScheduleUpdateRequest }
        : {}),
      ...(schedulerRuntimeUpdateRequest
        ? { runtimeType: schedulerRuntimeUpdateRequest }
        : {}),
      ...(preparation.result
        ? {
            capability: {
              requiredTools: preparation.result.requiredTools,
              stateRefs: preparation.result.stateRefs,
            },
          }
        : {}),
    });
    return {
      visibility: "ephemeral",
      classification: "user_private",
      text: appendPreparedResourceSummary(
        formatScheduledJobUpdateResult(result),
        result.ok ? preparation.result : null,
      ),
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
    const preparation = await prepareResolvedScheduledTask(
      request,
      deps,
      schedulerTaskPlan,
    );
    if (!preparation.ok) {
      return preparation.response;
    }
    const prompt = preparation.result?.prompt ?? schedulerPromptUpdateRequest;
    if (!prompt) {
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
      prompt,
      ...(preparation.result
        ? {
            capability: {
              requiredTools: preparation.result.requiredTools,
              stateRefs: preparation.result.stateRefs,
            },
          }
        : {}),
    });
    return {
      visibility: "ephemeral",
      classification: "user_private",
      text: appendPreparedResourceSummary(
        formatScheduledJobPromptUpdateResult(result),
        result.ok ? preparation.result : null,
      ),
    };
  }

  if (
    schedulerControlIntent === "update_job_runtime" &&
    deps.schedulerControl?.updateJobRuntime
  ) {
    if (!schedulerRuntimeUpdateRequest) {
      return {
        visibility: "ephemeral",
        classification: "user_private",
        text: "I can’t update that scheduled task yet because I could not resolve the new runtime.",
      };
    }
    const result = await deps.schedulerControl.updateJobRuntime({
      workspaceId: request.workspaceId,
      slackUserId: request.user.slackUserId,
      jobId: schedulerJobIdHint,
      runtimeType: schedulerRuntimeUpdateRequest,
    });
    return {
      visibility: "ephemeral",
      classification: "user_private",
      text: formatScheduledJobRuntimeUpdateResult(result),
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

async function resolveSchedulerControlIntent(
  request: ConversationRequest,
  deps: ConversationDeps,
): Promise<{
  intent: SchedulerControlIntent;
  jobId: string | null;
  create: SchedulerResolvedCreateJob | null;
  schedule: unknown | null;
  prompt: string | null;
  runtimeType: AgentRuntimeEngine | null;
  taskPlan: SchedulerTaskPlan | null;
  failure: SchedulerIntentResolverResult["failure"] | null;
}> {
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
      if (resolved.failure) {
        return {
          intent: null,
          jobId: null,
          create: null,
          schedule: null,
          prompt: null,
          runtimeType: null,
          taskPlan: null,
          failure: resolved.failure,
        };
      }
      const intent = normalizeResolvedSchedulerIntent(resolved);
      if (intent) {
        if (
          isSchedulerMutationIntent(intent) &&
          !isExplicitSchedulerControlRequest(request.text)
        ) {
          return emptySchedulerResolution();
        }
        const create =
          intent === "create_job"
            ? normalizeResolverCreateJob(resolved.create)
            : null;
        if (
          intent === "create_job" &&
          !create &&
          !hasExplicitSchedulerCreateLanguage(request.text)
        ) {
          return {
            intent: null,
            jobId: null,
            create: null,
            schedule: null,
            prompt: null,
            runtimeType: null,
            taskPlan: null,
            failure: null,
          };
        }
        return {
          intent,
          jobId: resolveSchedulerResolverJobId(
            request.text,
            resolved.jobId,
            jobs,
          ),
          create,
          schedule:
            intent === "update_job_schedule" || intent === "update_job"
              ? normalizeResolvedSchedule(resolved.schedule)
              : null,
          prompt:
            intent === "update_job_prompt" || intent === "update_job"
              ? normalizeResolvedPrompt(resolved.prompt)
              : null,
          runtimeType:
            (intent === "update_job_runtime" || intent === "update_job") &&
            isAgentRuntimeEngine(resolved.runtimeType)
              ? resolved.runtimeType
              : null,
          taskPlan:
            intent === "update_job_prompt" || intent === "update_job"
              ? resolved.taskPlan ?? null
              : null,
          failure: null,
        };
      }
    } catch {
      // Resolver failures should not make ordinary conversation turns fail.
    }
  }

  return {
    intent: null,
    jobId: null,
    create: null,
    schedule: null,
    prompt: null,
    runtimeType: null,
    taskPlan: null,
    failure: null,
  };
}

function emptySchedulerResolution(): {
  intent: null;
  jobId: null;
  create: null;
  schedule: null;
  prompt: null;
  runtimeType: null;
  taskPlan: null;
  failure: null;
} {
  return {
    intent: null,
    jobId: null,
    create: null,
    schedule: null,
    prompt: null,
    runtimeType: null,
    taskPlan: null,
    failure: null,
  };
}

async function prepareResolvedScheduledTask(
  request: ConversationRequest,
  deps: ConversationDeps,
  plan: SchedulerTaskPlan | null,
): Promise<
  | { ok: true; result: ScheduledTaskPreparationResult | null }
  | { ok: false; response: ConversationResponse }
> {
  if (!plan) {
    return { ok: true, result: null };
  }
  if (plan.preparation.length > 0 && !deps.scheduledTaskPreparationExecutor) {
    return {
      ok: false,
      response: {
        visibility: "ephemeral",
        classification: "user_private",
        text: "I couldn’t prepare the resources required by that task. No scheduled-job changes were made because provider preparation is unavailable.",
      },
    };
  }
  try {
    return {
      ok: true,
      result: await executeScheduledTaskPreparation({
        workspaceId: request.workspaceId,
        slackUserId: request.user.slackUserId,
        plan,
        executeTool:
          deps.scheduledTaskPreparationExecutor ??
          (async () => {
            throw new Error("Provider preparation is unavailable");
          }),
      }),
    };
  } catch (error) {
    return {
      ok: false,
      response: {
        visibility: "ephemeral",
        classification: "user_private",
        text: `I couldn’t prepare the resources required by that task. No scheduled-job changes were made. ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}

function appendPreparedResourceSummary(
  text: string,
  preparation: ScheduledTaskPreparationResult | null,
): string {
  if (!preparation || Object.keys(preparation.resources).length === 0) {
    return text;
  }
  return [
    text,
    "Prepared resources:",
    ...Object.entries(preparation.resources).map(([binding, value]) =>
      formatPreparedResource(binding, value),
    ),
  ].join("\n");
}

function formatPreparedResource(binding: string, value: unknown): string {
  if (!isRecord(value)) {
    return `- ${binding}`;
  }
  const name =
    typeof value.name === "string" && value.name.trim()
      ? value.name.trim()
      : binding;
  const link =
    typeof value.webViewLink === "string" && value.webViewLink.trim()
      ? value.webViewLink.trim()
      : null;
  const id =
    typeof value.id === "string" && value.id.trim() ? value.id.trim() : null;
  return link
    ? `- <${link}|${name}>${id ? ` (id: \`${id}\`)` : ""}`
    : `- ${name}${id ? ` (id: \`${id}\`)` : ""}`;
}

function isExplicitSchedulerControlRequest(text: string): boolean {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  return (
    /\b(cron|cronjob|scheduled job|scheduled task)\b/.test(normalized) ||
    /\b(create|add|make|set|modify|update|change|move|switch|pause|resume|delete|remove|run|trigger|show|list)\b.*\b(job|task|schedule)\b/.test(
      normalized,
    )
  );
}

function isSchedulerMutationIntent(
  intent: Exclude<SchedulerControlIntent, null>,
): boolean {
  return (
    intent === "pause_job" ||
    intent === "resume_job" ||
    intent === "delete_job" ||
    intent === "update_job_delivery" ||
    intent === "update_job" ||
    intent === "update_job_schedule" ||
    intent === "update_job_prompt" ||
    intent === "update_job_runtime"
  );
}

function hasExplicitSchedulerCreateLanguage(text: string): boolean {
  const normalized = text.toLowerCase();
  return /\b(create|add|set up|setup|schedule|scheduled|cron|recurring|repeat|automate|remind|task|job)\b/.test(
    normalized,
  );
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
): string | null {
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
    result.intent === "update_job" ||
    result.intent === "update_job_schedule" ||
    result.intent === "update_job_prompt" ||
    result.intent === "update_job_runtime" ||
    result.intent === "show_task" ||
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
  if (validation.runtimeAdmission) {
    lines.push(
      validation.runtimeAdmission.checked
        ? validation.runtimeAdmission.ok
          ? `- runtime admission: passed (${validation.runtimeAdmission.runtimeType})`
          : `- runtime admission: failed (${validation.runtimeAdmission.reason})`
        : `- runtime admission: skipped (${validation.runtimeAdmission.reason})`,
    );
  }

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
      `Scheduled job ${result.jobId} already has an active run.`,
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

export function formatScheduledJobUpdateResult(
  result: SchedulerUpdateJobResult,
): string {
  if (result.ok) {
    return [
      `Updated scheduled job ${result.job.jobId}.`,
      `- prompt: ${result.job.prompt}`,
      `- schedule: ${formatScheduleForSlack(result.job.schedule)}`,
      `- runtime: ${result.job.runtimeType}`,
    ].join("\n");
  }
  if (result.reason === "invalid_schedule") {
    return `I can’t update that scheduled task because its new schedule is unsupported: ${result.message}`;
  }
  if (result.reason === "runtime_not_allowed") {
    return [
      `I can’t move that scheduled task to ${result.runtimeType} because it is not enabled.`,
      result.allowedRuntimeTypes.length
        ? `- enabled runtimes: ${result.allowedRuntimeTypes.join(", ")}`
        : "- enabled runtimes: none",
    ].join("\n");
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

export function formatScheduledJobRuntimeUpdateResult(
  result: SchedulerUpdateJobRuntimeResult,
): string {
  if (result.ok) {
    return [
      `Updated scheduled job ${result.job.jobId} runtime.`,
      `- runtime: ${result.job.runtimeType}`,
    ].join("\n");
  }
  if (result.reason === "runtime_not_allowed") {
    return [
      `I can’t move that scheduled task to ${result.runtimeType} because it is not enabled.`,
      result.allowedRuntimeTypes.length
        ? `- enabled runtimes: ${result.allowedRuntimeTypes.join(", ")}`
        : "- enabled runtimes: none",
    ].join("\n");
  }
  return formatScheduledJobSelectionFailure(result);
}

function formatScheduledJobSelectionFailure(
  result:
    | Extract<SchedulerJobMutationResult, { ok: false }>
    | Extract<SchedulerJobDeleteResult, { ok: false }>
    | Extract<SchedulerUpdateJobDeliveryResult, { ok: false }>
    | Extract<
        SchedulerUpdateJobResult,
        { ok: false; reason: "no_jobs" | "not_found" | "ambiguous" }
      >
    | Extract<SchedulerUpdateJobScheduleResult, { ok: false }>
    | Extract<
        SchedulerUpdateJobRuntimeResult,
        { ok: false; reason: "no_jobs" | "not_found" | "ambiguous" }
      >,
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
  const audit = result.audit;
  const usage =
    audit?.usage && typeof audit.usage === "object"
      ? (audit.usage as Record<string, unknown>)
      : null;
  const workflow = result.workflow;

  return [
    "Latest scheduled job run",
    `- job: ${result.run.jobId}`,
    `- run: ${result.run.runId}`,
    `- status: ${result.run.status}`,
    `- triggered: ${result.run.triggerSource}`,
    `- updated: ${result.run.updatedAt}`,
    ...(audit
      ? [
          audit.runtimeType ? `- runtime: ${audit.runtimeType}` : null,
          audit.runnerName ? `- runner: ${audit.runnerName}` : null,
          audit.routeId ? `- route: ${audit.routeId}` : null,
          audit.outputDigest ? `- output: ${audit.outputDigest}` : null,
          typeof usage?.totalTokens === "number"
            ? `- tokens: ${usage.totalTokens}`
            : null,
        ].filter((line): line is string => Boolean(line))
      : []),
    ...(result.run.failureReason
      ? [`- failure: ${result.run.failureReason}`]
      : []),
    ...(workflow?.run
      ? [
          `- workflow: ${workflow.run.status}`,
          workflow.run.failureClass
            ? `- workflow failure: ${workflow.run.failureClass}`
            : null,
        ].filter((line): line is string => Boolean(line))
      : []),
    ...(workflow?.task?.status === "needs_repair"
      ? [
          `- task repair: needs_repair`,
          workflow.task.pausedReason
            ? `- repair reason: ${workflow.task.pausedReason}`
            : null,
        ].filter((line): line is string => Boolean(line))
      : []),
    ...(workflow?.sideEffectFailures.length
      ? [`- workflow side-effect failures: ${workflow.sideEffectFailures.length}`]
      : []),
  ].join("\n");
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
