import { formatConnectGitHubMessage } from "../formatting";
import { formatGitHubIdentityMessage, formatIssuesMessage } from "../formatting";
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

  if (intent === "github_identity" || intent === "github_issues") {
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

    const result = await deps.githubTools.listAssignedIssues.execute({
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

  if (/\b(issue|issues)\b/.test(normalized)) {
    return "github_issues";
  }

  return "help";
}
