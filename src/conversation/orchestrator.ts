import { formatConnectGitHubMessage } from "../formatting";
import { formatGitHubIdentityMessage, formatIssuesMessage } from "../formatting";
import { collectAgentRun } from "../agent/types";
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
  const intent = classifyDeterministicIntent(request.text);
  const forceAgent = shouldForceAgentDelegation(request.text);

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

  if (!forceAgent) {
    const fastPathResponse = await tryHandleLocalToolFastPath(request, deps);
    if (fastPathResponse) {
      return fastPathResponse;
    }
  }

  if (!forceAgent && (
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
        ? await deps.tools.github.listMyPullRequests.execute({ connection })
        : intent === "github_issue_search"
          ? await deps.tools.github.searchIssues.execute({
              connection,
              input: { query: buildIssueSearchQuery(request.text) }
            })
          : await deps.tools.github.listAssignedIssues.execute({
              connection
            });

    const content =
      intent === "github_pull_requests"
        ? result.content.slice(0, parseRequestedItemLimit(request.text) ?? 10)
        : result.content;

    return enforceVisibility(
      {
        visibility: "public",
        classification: result.classification,
        text: formatIssuesMessage(
          content.map((issue) => ({
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
        ...(request.attachments ? { attachments: request.attachments } : {}),
        connections: {
          github: deps.getConnection("github", request.user.email),
          google: deps.getConnection("google", request.user.email),
          jira: deps.getConnection("jira", request.user.email),
          slack: deps.getConnection("slack", request.user.email)
        }
      },
      deps.onAgentEvent
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

function parseRequestedItemLimit(text: string): number | null {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  const match =
    /\b(?:top|latest|last|recent|most recent)\s+(\d{1,2})\b/.exec(normalized) ??
    /\b(\d{1,2})\s+(?:latest|last|recent|most recent|open)?\s*(?:github\s+)?(?:pull requests?|prs?)\b/.exec(
      normalized
    );
  if (!match?.[1]) {
    return null;
  }
  const value = Number.parseInt(match[1], 10);
  return Number.isInteger(value) && value > 0 ? Math.min(value, 20) : null;
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
