import { formatConnectGitHubMessage } from "../formatting";
import { formatGitHubIdentityMessage, formatIssuesMessage } from "../formatting";
import { collectAgentRun, type AgentRunEvent } from "../agent/types";
import { selectRuntimeToolGroups } from "../agent/tool-groups";
import { parseGitHubPullRequestListInput } from "../github-query";
import { tryHandleLocalToolFastPath } from "./local-tool-fast-paths";
import { enforceVisibility } from "./visibility";
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
  const toolGroups = selectRuntimeToolGroups({
    text: request.text,
    attachmentCount: request.attachments?.length ?? 0
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
    attachmentCount: request.attachments?.length ?? 0
  });
  return {
    toolGroups: selection.groups,
    toolGroupReasons: selection.reasons
  };
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

  if (event.type === "message_delta") {
    deps.observability?.emit({
      ...common,
      name: "agent.message.delta",
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
