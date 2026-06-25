import { formatConnectGitHubMessage } from "../formatting";
import { formatGitHubIdentityMessage, formatIssuesMessage } from "../formatting";
import { collectAgentRun, type AgentRunEvent } from "../agent/types";
import { selectRuntimeToolGroups } from "../agent/tool-groups";
import { parseGitHubPullRequestListInput } from "../github-query";
import { tryHandleLocalToolFastPath } from "./local-tool-fast-paths";
import { enforceVisibility } from "./visibility";
import type {
  SchedulerCreateJobResult,
  SchedulerJobDeleteResult,
  SchedulerJobMutationResult,
  SchedulerRunStatusResult,
  SchedulerTriggerResult
} from "../scheduler/control-plane";
import type {
  ConversationDeps,
  ConversationRequest,
  ConversationResponse
} from "./types";

export async function handleConversation(
  request: ConversationRequest,
  deps: ConversationDeps
): Promise<ConversationResponse> {
  const traceId = deps.traceId ?? crypto.randomUUID();
  const startedAt = Date.now();
  emitConversationStarted(traceId, request, deps);
  try {
    const response = await handleConversationInternal(request, {
      ...deps,
      traceId
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
  deps: ConversationDeps
): Promise<ConversationResponse> {
  const intent = classifyDeterministicIntent(request.text);
  const forceAgent = shouldForceAgentDelegation(request.text);
  const fastTrackEnabled = shouldUseFastTrack(deps);
  const schedulerControlIntent = classifySchedulerControlIntent(request.text);
  const schedulerCreateRequest = parseSchedulerCreateRequest(request.text);
  const toolGroups = selectRuntimeToolGroups({
    text: request.text,
    attachmentCount: request.attachments?.length ?? 0,
    contextTexts: recentConversationTexts(request)
  });

  if (intent === "connect_github") {
    return {
      visibility: "ephemeral",
      classification: "user_private",
      text: formatConnectGitHubMessage(
        deps.createGitHubOAuthUrl(request.user.slackUserId)
      )
    };
  }

  if (intent === "connect_jira") {
    if (!deps.createJiraOAuthUrl) {
      return {
        visibility: "ephemeral",
        classification: "user_private",
        text: "Jira OAuth is not configured."
      };
    }

    return {
      visibility: "ephemeral",
      classification: "user_private",
      text: `<${deps.createJiraOAuthUrl(request.user.slackUserId)}|Connect your Jira account>`
    };
  }

  if (intent === "connect_slack") {
    if (!deps.createSlackOAuthUrl) {
      return {
        visibility: "ephemeral",
        classification: "user_private",
        text: "Slack OAuth is not configured."
      };
    }

    return {
      visibility: "ephemeral",
      classification: "user_private",
      text: `<${deps.createSlackOAuthUrl(request.user.slackUserId)}|Connect Slack search>`
    };
  }

  if (intent === "connect_google") {
    if (!deps.createGoogleOAuthUrl) {
      return {
        visibility: "ephemeral",
        classification: "user_private",
        text: "Google OAuth is not configured."
      };
    }

    return {
      visibility: "ephemeral",
      classification: "user_private",
      text: `<${deps.createGoogleOAuthUrl(request.user.slackUserId)}|Connect your Google account>`
    };
  }

  if (intent === "connect_hubspot") {
    if (!deps.createHubSpotOAuthUrl) {
      return {
        visibility: "ephemeral",
        classification: "user_private",
        text: "HubSpot OAuth is not configured."
      };
    }

    return {
      visibility: "ephemeral",
      classification: "user_private",
      text: `<${deps.createHubSpotOAuthUrl(request.user.slackUserId)}|Connect your HubSpot account>`
    };
  }

  if (schedulerControlIntent === "list_jobs" && deps.schedulerControl) {
    const jobs = await deps.schedulerControl.listJobs({
      workspaceId: request.workspaceId,
      slackUserId: request.user.slackUserId
    });
    return {
      visibility: "ephemeral",
      classification: "user_private",
      text: formatScheduledJobList(jobs)
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
      runtimeType: deps.agentRuntimeEngine
    });
    return {
      visibility: "ephemeral",
      classification: "user_private",
      text: formatScheduledJobCreateResult(result)
    };
  }

  if (
    schedulerControlIntent === "trigger_job" &&
    deps.schedulerControl?.triggerJob
  ) {
    const result = await deps.schedulerControl.triggerJob({
      workspaceId: request.workspaceId,
      slackUserId: request.user.slackUserId,
      jobId: readSchedulerJobIdHint(request.text)
    });
    if (result.ok) {
      dispatchSchedulerRunQueued(deps, result.run);
    }
    return {
      visibility: "ephemeral",
      classification: "user_private",
      text: formatScheduledJobTriggerResult(result)
    };
  }

  if (
    schedulerControlIntent === "pause_job" &&
    deps.schedulerControl?.pauseJob
  ) {
    const result = await deps.schedulerControl.pauseJob({
      workspaceId: request.workspaceId,
      slackUserId: request.user.slackUserId,
      jobId: readSchedulerJobIdHint(request.text)
    });
    return {
      visibility: "ephemeral",
      classification: "user_private",
      text: formatScheduledJobMutationResult("Paused", result)
    };
  }

  if (
    schedulerControlIntent === "resume_job" &&
    deps.schedulerControl?.resumeJob
  ) {
    const result = await deps.schedulerControl.resumeJob({
      workspaceId: request.workspaceId,
      slackUserId: request.user.slackUserId,
      jobId: readSchedulerJobIdHint(request.text)
    });
    return {
      visibility: "ephemeral",
      classification: "user_private",
      text: formatScheduledJobMutationResult("Resumed", result)
    };
  }

  if (
    schedulerControlIntent === "delete_job" &&
    deps.schedulerControl?.deleteJob
  ) {
    const result = await deps.schedulerControl.deleteJob({
      workspaceId: request.workspaceId,
      slackUserId: request.user.slackUserId,
      jobId: readSchedulerJobIdHint(request.text)
    });
    return {
      visibility: "ephemeral",
      classification: "user_private",
      text: formatScheduledJobDeleteResult(result)
    };
  }

  if (
    schedulerControlIntent === "latest_run_status" &&
    deps.schedulerControl?.getLatestRunStatus
  ) {
    const result = await deps.schedulerControl.getLatestRunStatus({
      workspaceId: request.workspaceId,
      slackUserId: request.user.slackUserId,
      jobId: readSchedulerJobIdHint(request.text)
    });
    return {
      visibility: "ephemeral",
      classification: "user_private",
      text: formatScheduledRunStatusResult(result)
    };
  }

  if (!forceAgent && fastTrackEnabled) {
    const fastPathResponse = await tryHandleLocalToolFastPath(request, deps);
    if (fastPathResponse) {
      return fastPathResponse;
    }
  }

  if (!forceAgent && fastTrackEnabled && (
    intent === "github_identity" ||
    intent === "github_issues" ||
    intent === "github_issue_search" ||
    intent === "github_pull_requests"
  )) {
    const connection = deps.getConnection("github", request.user.email);
    if (!connection) {
      return {
        visibility: "ephemeral",
        classification: "user_private",
        text: "Connect GitHub first: `@Burble connect github`."
      };
    }

    if (intent === "github_identity") {
      const result = await deps.tools.github.getAuthenticatedUser.execute({
        connection
      });
      return enforceVisibility(
        {
          visibility: "public",
          classification: result.classification,
          text: formatGitHubIdentityMessage(
            result.content.login,
            request.user.email
          )
        },
        request
      );
    }

    const result =
      intent === "github_pull_requests"
        ? await deps.tools.github.listMyPullRequests.execute({
            connection,
            input: parseGitHubPullRequestListInput(request.text)
          })
        : intent === "github_issue_search"
          ? await deps.tools.github.searchIssues.execute({
              connection,
              input: { query: buildIssueSearchQuery(request.text) }
            })
          : await deps.tools.github.listAssignedIssues.execute({
              connection
            });

    return enforceVisibility(
      {
        visibility: "public",
        classification: result.classification,
        text: formatIssuesMessage(
          result.content.map((issue) => ({
            title: issue.title,
            html_url: issue.url
          }))
        )
      },
      request
    );
  }

  if (deps.agentMode === "llm" && deps.agentRunner) {
    const result = await collectAgentRun(
      deps.agentRunner,
      {
        principal: {
          workspaceId: request.workspaceId,
          slackUserId: request.user.slackUserId
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
          slack: deps.getConnection("slack", request.user.email)
        }
      },
      async (event) => {
        emitAgentEvent(deps.traceId ?? crypto.randomUUID(), request, deps, event);
        await deps.onAgentEvent?.(event);
      }
    );

    return enforceVisibility(
      {
        visibility: "public",
        classification: result.classification,
        text: result.text,
        ...(result.attachments ? { attachments: result.attachments } : {}),
        ...(result.blocks ? { blocks: result.blocks } : {}),
        ...(result.usage ? { usage: result.usage } : {})
      },
      request
    );
  }

  return {
    visibility: "public",
    classification: "public",
    text: [
      "Try one of these:",
      "`@Burble connect github`",
      "`@Burble who am I on GitHub?`",
      "`@Burble what issues are assigned to me?`"
    ].join("\n")
  };
}

type SchedulerControlIntent =
  | "list_jobs"
  | "trigger_job"
  | "pause_job"
  | "resume_job"
  | "delete_job"
  | "latest_run_status"
  | null;

function classifySchedulerControlIntent(text: string): SchedulerControlIntent {
  const tokens = tokenizeSchedulerControlText(text);

  if (isSchedulerListIntent(tokens) && hasSchedulerListReference(tokens)) {
    return "list_jobs";
  }
  if (!hasSchedulerActionReference(tokens)) {
    return null;
  }
  if (isSchedulerRunStatusIntent(tokens)) {
    return "latest_run_status";
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
  if (isSchedulerTriggerIntent(tokens)) {
    return "trigger_job";
  }
  return null;
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
      "the"
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
      "failed"
    ]) &&
    hasAnyToken(tokens, ["run", "execution", "manual", "manually"])
  );
}

function isSchedulerTriggerIntent(tokens: string[]): boolean {
  if (!hasAnyToken(tokens, ["run", "trigger", "start"])) {
    return false;
  }
  if (looksLikeSchedulerCreationRequest(tokens)) {
    return false;
  }
  if (hasAnyToken(tokens, ["cron"]) || hasScheduledJobReference(tokens)) {
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
      "the"
    ]) ||
    hasAnyToken(tokens, ["trigger"])
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

function parseSchedulerCreateRequest(
  text: string
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
    scheduleLabel: schedule.label
  };
}

function parseExplicitIntervalSchedule(
  text: string
): { value: unknown; label: string } | null {
  const normalized = text.toLowerCase();
  if (
    /\bhourly\b|\bevery\s+(?:1\s+)?hours?\b|\bevery\s+60\s*(?:m|min|mins|minutes?)\b/.test(
      normalized
    )
  ) {
    return {
      value: { kind: "interval", every: { hours: 1 } },
      label: "every 60m"
    };
  }
  if (/\bdaily\b|\bevery\s+(?:1\s+)?days?\b/.test(normalized)) {
    return {
      value: { kind: "interval", every: { days: 1 } },
      label: "every 1d"
    };
  }
  if (/\bweekly\b|\bevery\s+(?:1\s+)?weeks?\b/.test(normalized)) {
    return {
      value: { kind: "interval", every: { weeks: 1 } },
      label: "every 1w"
    };
  }

  const everyMatch =
    /\bevery\s+(\d+)\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/i.exec(
      text
    );
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
      value: { kind: "interval", every: { minutes: amount } },
      label: `every ${amount}m`
    };
  }
  if (["hour", "hours", "hr", "hrs", "h"].includes(unit)) {
    return {
      value: { kind: "interval", every: { hours: amount } },
      label: `every ${amount}h`
    };
  }
  if (["day", "days", "d"].includes(unit)) {
    return {
      value: { kind: "interval", every: { days: amount } },
      label: `every ${amount}d`
    };
  }
  return null;
}

function extractScheduledTaskPrompt(text: string): string {
  return text
    .trim()
    .replace(
      /^\s*(?:please\s+)?(?:create|add|make|schedule|set\s+up)\s+(?:an?\s+)?(?:(?:hourly|daily|weekly)\s+|every\s+\d+\s*(?:minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w)\s+)?(?:cron\s+job|cronjob|scheduled\s+job|job)\s+(?:to|that|which|for)?\s*/i,
      ""
    )
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
  second: string
): boolean {
  return tokens.some(
    (token, index) => token === first && tokens[index + 1] === second
  );
}

function hasSequence(tokens: string[], sequence: string[]): boolean {
  return tokens.some((token, index) => {
    if (token !== sequence[0]) {
      return false;
    }
    return sequence.every(
      (sequenceToken, offset) => tokens[index + offset] === sequenceToken
    );
  });
}

function formatScheduledJobList(
  jobs: Array<{
    jobId: string;
    title: string | null;
    state: string;
    runtimeType: string | null;
    requiredTools: string[];
    routeId: string | null;
    updatedAt: string;
  }>
): string {
  if (jobs.length === 0) {
    return "No scheduled jobs are configured.";
  }

  const lines = ["Scheduled jobs"];
  for (const job of jobs) {
    const details = [
      job.title ? job.title : null,
      `state: ${job.state}`,
      job.runtimeType ? `runtime: ${job.runtimeType}` : null,
      job.requiredTools.length ? `tools: ${job.requiredTools.join(", ")}` : null,
      job.routeId ? `route: ${job.routeId}` : null,
      `updated: ${job.updatedAt}`
    ].filter((value): value is string => Boolean(value));
    lines.push(`- ${job.jobId} - ${details.join("; ")}`);
  }
  return lines.join("\n");
}

function formatScheduledJobTriggerResult(
  result: SchedulerTriggerResult
): string {
  if (result.ok) {
    return [
      `Triggered scheduled job ${result.jobId}.`,
      `Run ID: ${result.run.runId}`,
      `Status: ${result.run.status}`
    ].join("\n");
  }

  if (result.reason === "no_jobs") {
    return "No scheduled jobs are configured.";
  }
  if (result.reason === "not_found") {
    return "I could not find that scheduled job.";
  }
  return [
    "Multiple scheduled jobs are configured. Please specify the job id.",
    ...result.jobs.map((job) => `- ${job.jobId}`)
  ].join("\n");
}

function formatScheduledJobCreateResult(
  result: SchedulerCreateJobResult
): string {
  return [
    `Created scheduled job ${result.job.jobId}.`,
    `- name: ${result.job.title}`,
    `- state: ${result.job.state}`,
    result.job.runtimeType ? `- runtime: ${result.job.runtimeType}` : null,
    result.job.routeId ? `- delivery: this conversation` : null
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function formatScheduledJobMutationResult(
  verb: "Paused" | "Resumed",
  result: SchedulerJobMutationResult
): string {
  if (result.ok) {
    return `${verb} scheduled job ${result.job.jobId}.`;
  }
  return formatScheduledJobSelectionFailure(result);
}

function formatScheduledJobDeleteResult(
  result: SchedulerJobDeleteResult
): string {
  if (result.ok) {
    return `Deleted scheduled job ${result.jobId}.`;
  }
  return formatScheduledJobSelectionFailure(result);
}

function formatScheduledJobSelectionFailure(
  result:
    | Extract<SchedulerJobMutationResult, { ok: false }>
    | Extract<SchedulerJobDeleteResult, { ok: false }>
): string {
  if (result.reason === "no_jobs") {
    return "No scheduled jobs are configured.";
  }
  if (result.reason === "not_found") {
    return "I could not find that scheduled job.";
  }
  return [
    "Multiple scheduled jobs are configured. Please specify the job id.",
    ...result.jobs.map((job) => `- ${job.jobId}`)
  ].join("\n");
}

function formatScheduledRunStatusResult(
  result: SchedulerRunStatusResult
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
      : [])
  ].join("\n");
}

function readSchedulerJobIdHint(text: string): string | null {
  const match =
    /\b(?:job|cron\s+job|scheduled\s+job)\s+(?:id\s*)?(?:[:#]\s*|\bis\s+)([a-z0-9][a-z0-9_.-]{2,})\b/i.exec(
      text
    ) ??
    /\b(?:job|cron\s+job|scheduled\s+job)\s+id\s+([a-z0-9][a-z0-9_.-]{2,})\b/i.exec(
      text
    );
  return match?.[1] ?? null;
}

function emitConversationStarted(
  traceId: string,
  request: ConversationRequest,
  deps: ConversationDeps
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
      ...toolGroupAttributes(request)
    },
    content: {
      text: request.text
    }
  });
}

function toolGroupAttributes(
  request: ConversationRequest
): { toolGroups: string[]; toolGroupReasons: string[] } {
  const selection = selectRuntimeToolGroups({
    text: request.text,
    attachmentCount: request.attachments?.length ?? 0,
    contextTexts: recentConversationTexts(request)
  });
  return {
    toolGroups: selection.groups,
    toolGroupReasons: selection.reasons
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
  startedAt: number
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
      blockCount: response.blocks?.length ?? 0
    },
    content: {
      text: response.text
    }
  });
}

function emitConversationFailed(
  traceId: string,
  request: ConversationRequest,
  deps: ConversationDeps,
  startedAt: number,
  error: unknown
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
    error: errorToObservabilityError(error)
  });
}

function emitAgentEvent(
  traceId: string,
  request: ConversationRequest,
  deps: ConversationDeps,
  event: AgentRunEvent
): void {
  const common = {
    traceId,
    workspaceId: request.workspaceId,
    principalId: principalId(request),
    routeId: request.conversationRouteId,
    sessionId: request.threadTs ?? request.messageTs
  };

  if (event.type === "tool_call") {
    deps.observability?.emit({
      ...common,
      name: "tool.call.started",
      toolName: event.toolName,
      callId: event.callId
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
      status: "ok"
    });
    return;
  }

  if (event.type === "status") {
    deps.observability?.emit({
      ...common,
      name: "agent.status",
      attributes: {
        text: event.text
      }
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
        textLength: event.text.length
      },
      content: {
        text: event.text
      }
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
      message: error.message
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
  run: Parameters<NonNullable<ConversationDeps["onSchedulerRunQueued"]>>[0]
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
    ...(request.conversationRouteId ? { routeId: request.conversationRouteId } : {}),
    source: request.source,
    workspaceId: request.workspaceId,
    channelId: request.channelId,
    rootId: buildConversationRootId(request),
    isDirectMessage: request.isDirectMessage
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
      normalized
    ) ||
    /\b(create|make|set|schedule|modify|update|delete|remove|list|run|start|add)\b.*\b(cron|job|task|subagent|scheduled job|schedule|reminder|background task)\b/.test(
      normalized
    ) ||
    /\b(one[-\s]?shot|every\s+\d+|in\s+\d+\s+(second|seconds|minute|minutes|hour|hours))\b.*\b(cron|job|task|scheduled|schedule|post|send|report)\b/.test(
      normalized
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
      normalizedText
    ) ||
    new RegExp(`\\b(${mutationVerb})\\b.*\\b(${providerObject})\\b`).test(
      normalizedText
    ) ||
    new RegExp(`\\b(${providerObject})\\b.*\\b(${mutationVerb})\\b`).test(
      normalizedText
    )
  );
}

function buildIssueSearchQuery(text: string): string {
  const normalized = text
    .replace(/\b(search|github|issue|issues|for|about)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  return normalized
    ? `is:issue ${normalized}`
    : "is:issue";
}
