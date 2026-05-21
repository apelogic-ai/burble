import { formatConnectGitHubMessage } from "../formatting";
import { formatGitHubIdentityMessage, formatIssuesMessage } from "../formatting";
import { collectAgentRun } from "../agent/types";
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

  if (intent === "connect_github") {
    return {
      visibility: "ephemeral",
      classification: "user_private",
      text: formatConnectGitHubMessage(
        deps.createGitHubOAuthUrl(request.user.slackUserId)
      )
    };
  }

  if (deps.agentMode === "llm" && deps.agentRunner) {
    const result = await collectAgentRun(
      deps.agentRunner,
      {
        principal: {
          workspaceId: request.workspaceId,
          slackUserId: request.user.slackUserId
        },
        text: request.text,
        connections: {
          github: deps.getConnection("github", request.user.email)
        }
      }
    );

    return enforceVisibility(
      {
        visibility: "public",
        classification: result.classification,
        text: result.text,
        ...(result.blocks ? { blocks: result.blocks } : {})
      },
      request
    );
  }

  if (
    intent === "github_identity" ||
    intent === "github_issues" ||
    intent === "github_issue_search" ||
    intent === "github_pull_requests"
  ) {
    const connection = deps.getConnection("github", request.user.email);
    if (!connection) {
      return {
        visibility: "ephemeral",
        classification: "user_private",
        text: "Connect GitHub first: `@Burble connect github`."
      };
    }

    if (intent === "github_identity") {
      const result = await deps.githubTools.getAuthenticatedUser.execute({
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
        ? await deps.githubTools.listMyPullRequests.execute({ connection })
        : intent === "github_issue_search"
          ? await deps.githubTools.searchIssues.execute({
              connection,
              input: { query: buildIssueSearchQuery(request.text) }
            })
          : await deps.githubTools.listAssignedIssues.execute({
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

type DeterministicIntent =
  | "connect_github"
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

function buildIssueSearchQuery(text: string): string {
  const normalized = text
    .replace(/\b(search|github|issue|issues|for|about)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  return normalized
    ? `is:issue ${normalized}`
    : "is:issue";
}
