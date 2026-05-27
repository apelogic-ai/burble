import type { Provider, ProviderConnection } from "../db";
import { enforceVisibility } from "./visibility";
import type {
  ConversationDeps,
  ConversationRequest,
  ConversationResponse,
  ToolClassification
} from "./types";

type FastPathRunInput = {
  request: ConversationRequest;
  deps: ConversationDeps;
  connection: ProviderConnection;
};

type FastPathRunResult = {
  classification: ToolClassification;
  text: string;
};

type LocalToolFastPath = {
  id: string;
  provider: Provider;
  isAvailable: (deps: ConversationDeps) => boolean;
  matches: (normalizedText: string, request: ConversationRequest) => boolean;
  missingConnectionText: string;
  run: (input: FastPathRunInput) => Promise<FastPathRunResult>;
};

const localToolFastPaths: LocalToolFastPath[] = [
  {
    id: "google.gmail.latestMessage",
    provider: "google",
    isAvailable: (deps) => Boolean(deps.tools.google),
    matches: (text) =>
      /\b(last|latest|most recent|recent)\b/.test(text) &&
      /\b(email|mail|gmail|message)\b/.test(text) &&
      /\b(gmail|google mail|mail)\b/.test(text),
    missingConnectionText: "Connect Google first: `@Burble connect google`.",
    async run({ deps, connection }) {
      const result = await deps.tools.google!.searchMailMessages.execute({
        connection,
        input: { query: "newer_than:30d", limit: 1 }
      });

      if (!Array.isArray(result.content)) {
        return {
          classification: result.classification,
          text: result.content.message
        };
      }

      const [message] = result.content;
      if (!message) {
        return {
          classification: result.classification,
          text: "No recent Gmail messages found."
        };
      }

      return {
        classification: result.classification,
        text: [
          "*Latest Gmail message:*",
          `- *Subject:* ${message.subject ?? "(no subject)"}`,
          ...(message.snippet ? [`- *Snippet:* ${message.snippet}`] : [])
        ].join("\n")
      };
    }
  },
  {
    id: "jira.issue.lastCreated",
    provider: "jira",
    isAvailable: (deps) => Boolean(deps.tools.jira),
    matches: (text) =>
      /\b(last|latest|most recent|recent)\b/.test(text) &&
      /\b(created|opened|reported|filed)\b/.test(text) &&
      /\b(jira|ticket|issue)\b/.test(text),
    missingConnectionText: "Connect Jira first: `@Burble connect jira`.",
    async run({ deps, connection }) {
      const result = await deps.tools.jira!.searchIssues.execute({
        connection,
        input: { jql: "creator = currentUser() ORDER BY created DESC" }
      });

      if (!Array.isArray(result.content)) {
        return {
          classification: result.classification,
          text: result.content.message
        };
      }

      const [issue] = result.content;
      if (!issue) {
        return {
          classification: result.classification,
          text: "No Jira tickets created by you were found."
        };
      }

      return {
        classification: result.classification,
        text: `Your last created Jira ticket: <${issue.url}|${issue.key} - ${issue.title}>`
      };
    }
  },
  {
    id: "jira.issue.latestAssigned",
    provider: "jira",
    isAvailable: (deps) => Boolean(deps.tools.jira),
    matches: (text) =>
      /\b(last|latest|most recent|recent)\b/.test(text) &&
      /\b(jira|ticket|issue)\b/.test(text) &&
      /\b(assigned|assigned to me|my)\b/.test(text),
    missingConnectionText: "Connect Jira first: `@Burble connect jira`.",
    async run({ deps, connection }) {
      const result = await deps.tools.jira!.listAssignedIssues.execute({
        connection
      });

      if (!Array.isArray(result.content)) {
        return {
          classification: result.classification,
          text: result.content.message
        };
      }

      const [issue] = result.content;
      if (!issue) {
        return {
          classification: result.classification,
          text: "No open Jira tickets assigned to you were found."
        };
      }

      return {
        classification: result.classification,
        text: `Your latest assigned Jira ticket: <${issue.url}|${issue.key} - ${issue.title}>`
      };
    }
  }
];

export async function tryHandleLocalToolFastPath(
  request: ConversationRequest,
  deps: ConversationDeps
): Promise<ConversationResponse | null> {
  const normalizedText = request.text.toLowerCase();
  const fastPath = localToolFastPaths.find(
    (candidate) =>
      candidate.isAvailable(deps) && candidate.matches(normalizedText, request)
  );

  if (!fastPath) {
    return null;
  }

  const connection = deps.getConnection(fastPath.provider, request.user.email);
  if (!connection) {
    return enforceVisibility(
      {
        visibility: "public",
        classification: "user_private",
        text: fastPath.missingConnectionText
      },
      request
    );
  }

  const result = await fastPath.run({ request, deps, connection });
  return enforceVisibility(
    {
      visibility: "public",
      classification: result.classification,
      text: result.text
    },
    request
  );
}
