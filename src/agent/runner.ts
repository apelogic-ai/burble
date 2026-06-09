import { generateText, stepCountIs, tool } from "ai";
import type {
  LanguageModelUsage,
  StopCondition,
  TelemetrySettings,
  ToolSet
} from "ai";
import { z } from "zod";
import type { createGitHubTools } from "../tools/github";
import type { createGoogleTools } from "../tools/google";
import type { createHubSpotTools } from "../tools/hubspot";
import type { createJiraTools } from "../tools/jira";
import type { createSlackTools } from "../tools/slack";
import type { ToolClassification } from "../conversation/types";
import { hubSpotReadableCrmObjectTypes } from "../providers/hubspot/client";
import { createDirectModelResolver } from "./providers";
import type { DirectLanguageModel, ModelResolver } from "./providers";
import type {
  AgentInput,
  AgentOutput,
  AgentRunEvent,
  AgentRunner,
  AgentUsage
} from "./types";
import type { ObservabilitySink } from "../observability";

type AgentToolResult<TContent> = {
  classification: ToolClassification;
  content: TContent;
};

export type AgentGenerateRequest = {
  model: DirectLanguageModel;
  system: string;
  prompt: string;
  tools: ToolSet;
  stopWhen: StopCondition<ToolSet> | Array<StopCondition<ToolSet>>;
  maxRetries: number;
  experimental_telemetry: TelemetrySettings;
};

export type AgentGenerateResult = {
  text: string;
  usage?: LanguageModelUsage;
};

export type AgentGenerateText = (
  request: AgentGenerateRequest
) => Promise<AgentGenerateResult>;

export type AiSdkAgentRunnerDeps = {
  model: string;
  githubTools: ReturnType<typeof createGitHubTools>;
  googleTools?: ReturnType<typeof createGoogleTools>;
  hubspotTools?: ReturnType<typeof createHubSpotTools>;
  jiraTools?: ReturnType<typeof createJiraTools>;
  slackTools?: ReturnType<typeof createSlackTools>;
  resolveModel?: ModelResolver;
  generateText?: AgentGenerateText;
  logInfo?: (message: string) => void;
  observability?: ObservabilitySink;
};

const systemPrompt = [
  "You are Burble, a Slack-native work assistant.",
  "Answer in concise Slack mrkdwn.",
  "Use provider tools for GitHub, Jira, Slack, and Google facts. Do not invent provider data.",
  "Use Google tools for Drive, Calendar, and Gmail facts when Google is connected.",
  "Use HubSpot tools for CRM users, owners, contacts, companies, deals, and other scoped CRM objects when HubSpot is connected.",
  "Never ask for, print, or expose access tokens.",
  "When a provider tool returns an error object with a message, explain that message in normal Slack text; do not print raw JSON.",
  "When a tool says GitHub is not connected, tell the user to run `@Burble connect github`.",
  "When a tool says Jira is not connected, tell the user Jira needs to be connected.",
  "When a tool says Slack is not connected, tell the user to run `/auth slack`.",
  "Use recent Slack context to resolve pronouns and short follow-ups.",
  "For requests about the current Slack channel or chat, answer from the recent Slack context when available. If channel history is unavailable, explain that Burble needs Slack bot history scopes and channel membership.",
  "For Jira questions involving a named person, search Jira users first instead of asking who they are.",
  "For Slack questions like 'what did I say about X', search Slack messages with the requesting Slack user's ID as fromUserId.",
  "Prefer short lists with links when showing issues or pull requests."
].join("\n");
const MAX_RECENT_SLACK_CONTEXT_MESSAGES = 12;
const MAX_RECENT_SLACK_CONTEXT_MESSAGE_CHARS = 300;

export function createAiSdkAgentRunner(
  deps: AiSdkAgentRunnerDeps
): AgentRunner {
  const generate = deps.generateText ?? defaultGenerateText;
  const resolveModel = deps.resolveModel ?? createDirectModelResolver();
  const model = resolveModel(deps.model);
  const logInfo = deps.logInfo ?? (() => undefined);

  return {
    name: "ai-sdk",
    capabilities: {
      streaming: false,
      toolEvents: true,
      remote: false
    },
    async *run(input: AgentInput): AsyncIterable<AgentRunEvent> {
      yield { type: "status", text: "Agent is thinking..." };

      const toolEvents: AgentRunEvent[] = [];
      const response = await runAiSdkAgent(input, {
        ...deps,
        generateTextFn: generate,
        resolvedModel: model,
        logInfo,
        recordToolEvent: (event) => toolEvents.push(event)
      });

      yield* toolEvents;
      yield { type: "final", response };
    }
  };
}

type RunAiSdkAgentDeps = AiSdkAgentRunnerDeps & {
  generateTextFn: AgentGenerateText;
  resolvedModel: DirectLanguageModel;
  logInfo: (message: string) => void;
  recordToolEvent: (event: AgentRunEvent) => void;
};

async function runAiSdkAgent(
  input: AgentInput,
  deps: RunAiSdkAgentDeps
): Promise<AgentOutput> {
    let classification: ToolClassification = "public";

    const record = <TContent>(
      result: AgentToolResult<TContent>
    ): AgentToolResult<TContent> => {
      classification = mergeClassification(classification, result.classification);
      return result;
    };

    const missingGitHubConnection = () =>
      record({
        classification: "user_private",
        content: {
          error: "github_not_connected",
          message: "Connect GitHub first: `@Burble connect github`."
        }
      });
    const missingJiraConnection = () =>
      record({
        classification: "user_private",
        content: {
          error: "jira_not_connected",
          message: "Connect Jira first."
        }
      });
    const missingSlackConnection = () =>
      record({
        classification: "user_private",
        content: {
          error: "slack_not_connected",
          message: "Connect Slack search first: `/auth slack`."
        }
      });
    const missingGoogleConnection = () =>
      record({
        classification: "user_private",
        content: {
          error: "google_not_connected",
          message: "Connect Google first: `/auth google`."
        }
      });
    const missingHubSpotConnection = () =>
      record({
        classification: "user_private",
        content: {
          error: "hubspot_not_connected",
          message: "Connect HubSpot first: `/auth hubspot`."
        }
      });

    const logToolResult = (
      name: string,
      result: AgentToolResult<unknown>
    ): AgentToolResult<unknown> => {
      deps.logInfo(
        [
          `LLM tool finish name=${name}`,
          `classification=${result.classification}`,
          `itemCount=${Array.isArray(result.content) ? result.content.length : "n/a"}`
        ].join(" ")
      );
      return result;
    };

    const executeTool = async (
      name: string,
      fn: () => Promise<AgentToolResult<unknown>> | AgentToolResult<unknown>
    ): Promise<AgentToolResult<unknown>> => {
      const callId = crypto.randomUUID();
      deps.logInfo(`LLM tool start name=${name}`);
      deps.recordToolEvent({ type: "tool_call", toolName: name, callId });
      const result = logToolResult(name, await fn());
      deps.recordToolEvent({
        type: "tool_result",
        toolName: name,
        callId,
        classification: result.classification
      });
      return result;
    };

    const tools: ToolSet = {
      github_get_authenticated_user: tool({
        description: "Return the authenticated GitHub login for the Slack user.",
        inputSchema: z.object({}),
        execute: async () => executeTool("github_get_authenticated_user", async () => {
          const connection = input.connections.github;
          if (!connection) {
            return missingGitHubConnection();
          }

          return record(
            await deps.githubTools.getAuthenticatedUser.execute({
              connection
            })
          );
        })
      }),
      github_list_assigned_issues: tool({
        description: "List open GitHub issues assigned to the Slack user.",
        inputSchema: z.object({}),
        execute: async () => executeTool("github_list_assigned_issues", async () => {
          const connection = input.connections.github;
          if (!connection) {
            return missingGitHubConnection();
          }

          return record(
            await deps.githubTools.listAssignedIssues.execute({
              connection
            })
          );
        })
      }),
      github_search_issues: tool({
        description:
          "Search GitHub issues visible to the authenticated Slack user.",
        inputSchema: z.object({
          query: z
            .string()
            .min(1)
            .describe("A GitHub issue search query, for example: is:issue billing")
        }),
        execute: async ({ query }) => executeTool("github_search_issues", async () => {
          const connection = input.connections.github;
          if (!connection) {
            return missingGitHubConnection();
          }

          return record(
            await deps.githubTools.searchIssues.execute({
              connection,
              input: { query }
            })
          );
        })
      }),
      github_list_my_pull_requests: tool({
        description:
          "List GitHub pull requests authored by the Slack user. Defaults to open PRs sorted by most recently updated.",
        inputSchema: z.object({
          limit: z.number().int().min(1).max(20).optional(),
          state: z.enum(["open", "closed", "all"]).optional(),
          sort: z.enum(["updated", "created", "comments"]).optional(),
          order: z.enum(["desc", "asc"]).optional(),
          owner: z
            .string()
            .min(1)
            .optional()
            .describe("GitHub owner or organization login to filter by."),
          repo: z
            .string()
            .min(1)
            .optional()
            .describe("Repository in owner/name format. Takes precedence over owner.")
        }),
        execute: async (toolInput) => executeTool("github_list_my_pull_requests", async () => {
          const connection = input.connections.github;
          if (!connection) {
            return missingGitHubConnection();
          }

          return record(
            await deps.githubTools.listMyPullRequests.execute({
              connection,
              input: toolInput
            })
          );
        })
      }),
      github_get_issue: tool({
        description:
          "Get one GitHub issue by repository and issue number, including body and metadata.",
        inputSchema: z.object({
          repo: z.string().min(1).describe("Repository in owner/name format"),
          number: z.number().int().positive()
        }),
        execute: async (toolInput) => executeTool("github_get_issue", async () => {
          const connection = input.connections.github;
          if (!connection) {
            return missingGitHubConnection();
          }

          return record(
            await deps.githubTools.getIssue.execute({
              connection,
              input: toolInput
            })
          );
        })
      }),
      github_get_pr: tool({
        description:
          "Get one GitHub pull request by repository and PR number, including body, branches, and metadata.",
        inputSchema: z.object({
          repo: z.string().min(1).describe("Repository in owner/name format"),
          number: z.number().int().positive()
        }),
        execute: async (toolInput) => executeTool("github_get_pr", async () => {
          const connection = input.connections.github;
          if (!connection) {
            return missingGitHubConnection();
          }

          return record(
            await deps.githubTools.getPullRequest.execute({
              connection,
              input: toolInput
            })
          );
        })
      }),
      github_create_issue: tool({
        description:
          "Create a GitHub issue. Use only when the user clearly asks to create an issue.",
        inputSchema: z.object({
          repo: z.string().min(1),
          title: z.string().min(1),
          body: z.string().optional(),
          labels: z.array(z.string().min(1)).optional(),
          assignees: z.array(z.string().min(1)).optional()
        }),
        execute: async (toolInput) => executeTool("github_create_issue", async () => {
          const connection = input.connections.github;
          if (!connection) {
            return missingGitHubConnection();
          }

          return record(
            await deps.githubTools.createIssue.execute({
              connection,
              input: toolInput
            })
          );
        })
      }),
      github_update_issue: tool({
        description:
          "Update GitHub issue metadata: title, body, state, labels, or assignees. Use only when clearly requested.",
        inputSchema: z.object({
          repo: z.string().min(1).describe("Repository in owner/name format"),
          number: z.number().int().positive(),
          title: z.string().min(1).optional(),
          body: z.string().optional(),
          state: z.enum(["open", "closed"]).optional(),
          labels: z.array(z.string().min(1)).optional(),
          assignees: z.array(z.string().min(1)).optional()
        }),
        execute: async (toolInput) => executeTool("github_update_issue", async () => {
          const connection = input.connections.github;
          if (!connection) {
            return missingGitHubConnection();
          }

          return record(
            await deps.githubTools.updateIssue.execute({
              connection,
              input: toolInput
            })
          );
        })
      }),
      github_close_issue: tool({
        description: "Close a GitHub issue. Use only when clearly requested.",
        inputSchema: z.object({
          repo: z.string().min(1).describe("Repository in owner/name format"),
          number: z.number().int().positive()
        }),
        execute: async (toolInput) => executeTool("github_close_issue", async () => {
          const connection = input.connections.github;
          if (!connection) {
            return missingGitHubConnection();
          }

          return record(
            await deps.githubTools.closeIssue.execute({
              connection,
              input: toolInput
            })
          );
        })
      }),
      github_reopen_issue: tool({
        description: "Reopen a GitHub issue. Use only when clearly requested.",
        inputSchema: z.object({
          repo: z.string().min(1).describe("Repository in owner/name format"),
          number: z.number().int().positive()
        }),
        execute: async (toolInput) => executeTool("github_reopen_issue", async () => {
          const connection = input.connections.github;
          if (!connection) {
            return missingGitHubConnection();
          }

          return record(
            await deps.githubTools.reopenIssue.execute({
              connection,
              input: toolInput
            })
          );
        })
      }),
      github_comment_on_issue_or_pr: tool({
        description:
          "Comment on a GitHub issue or pull request. Use only when the user clearly asks to comment.",
        inputSchema: z.object({
          repo: z.string().min(1),
          number: z.number().int().positive(),
          body: z.string().min(1)
        }),
        execute: async (toolInput) => executeTool("github_comment_on_issue_or_pr", async () => {
          const connection = input.connections.github;
          if (!connection) {
            return missingGitHubConnection();
          }

          return record(
            await deps.githubTools.commentOnIssueOrPullRequest.execute({
              connection,
              input: toolInput
            })
          );
        })
      }),
      github_get_file: tool({
        description:
          "Read a text file from a GitHub repository by path and optional branch/ref.",
        inputSchema: z.object({
          repo: z.string().min(1).describe("Repository in owner/name format"),
          path: z.string().min(1),
          ref: z.string().min(1).optional()
        }),
        execute: async (toolInput) => executeTool("github_get_file", async () => {
          const connection = input.connections.github;
          if (!connection) {
            return missingGitHubConnection();
          }

          return record(
            await deps.githubTools.getFile.execute({
              connection,
              input: toolInput
            })
          );
        })
      }),
      github_create_or_update_file: tool({
        description:
          "Create or update a single text file in a GitHub repository. Use only when explicitly requested.",
        inputSchema: z.object({
          repo: z.string().min(1).describe("Repository in owner/name format"),
          path: z.string().min(1),
          content: z.string(),
          message: z.string().min(1),
          branch: z.string().min(1).optional(),
          sha: z.string().min(1).optional()
        }),
        execute: async (toolInput) =>
          executeTool("github_create_or_update_file", async () => {
            const connection = input.connections.github;
            if (!connection) {
              return missingGitHubConnection();
            }

            return record(
              await deps.githubTools.createOrUpdateFile.execute({
                connection,
                input: toolInput
              })
            );
          })
      }),
      github_create_branch: tool({
        description:
          "Create a GitHub branch from the default branch or from a provided ref/SHA. Use only when explicitly requested.",
        inputSchema: z.object({
          repo: z.string().min(1).describe("Repository in owner/name format"),
          branch: z.string().min(1),
          fromRef: z.string().min(1).optional()
        }),
        execute: async (toolInput) => executeTool("github_create_branch", async () => {
          const connection = input.connections.github;
          if (!connection) {
            return missingGitHubConnection();
          }

          return record(
            await deps.githubTools.createBranch.execute({
              connection,
              input: toolInput
            })
          );
        })
      }),
      github_create_pr: tool({
        description:
          "Open a GitHub pull request from an existing branch. Use only when explicitly requested.",
        inputSchema: z.object({
          repo: z.string().min(1),
          title: z.string().min(1),
          head: z.string().min(1),
          base: z.string().min(1),
          body: z.string().optional(),
          draft: z.boolean().optional()
        }),
        execute: async (toolInput) => executeTool("github_create_pr", async () => {
          const connection = input.connections.github;
          if (!connection) {
            return missingGitHubConnection();
          }

          return record(
            await deps.githubTools.createPullRequest.execute({
              connection,
              input: toolInput
            })
          );
        })
      }),
      github_update_pr: tool({
        description:
          "Update GitHub pull request metadata: title, body, base branch, or draft state. Does not edit code.",
        inputSchema: z.object({
          repo: z.string().min(1),
          number: z.number().int().positive(),
          title: z.string().min(1).optional(),
          body: z.string().optional(),
          base: z.string().min(1).optional(),
          draft: z.boolean().optional()
        }),
        execute: async (toolInput) => executeTool("github_update_pr", async () => {
          const connection = input.connections.github;
          if (!connection) {
            return missingGitHubConnection();
          }

          return record(
            await deps.githubTools.updatePullRequest.execute({
              connection,
              input: toolInput
            })
          );
        })
      }),
      github_add_labels: tool({
        description: "Add labels to a GitHub issue or pull request.",
        inputSchema: z.object({
          repo: z.string().min(1),
          number: z.number().int().positive(),
          labels: z.array(z.string().min(1)).min(1)
        }),
        execute: async (toolInput) => executeTool("github_add_labels", async () => {
          const connection = input.connections.github;
          if (!connection) {
            return missingGitHubConnection();
          }

          return record(
            await deps.githubTools.addLabels.execute({
              connection,
              input: toolInput
            })
          );
        })
      }),
      github_remove_labels: tool({
        description: "Remove labels from a GitHub issue or pull request.",
        inputSchema: z.object({
          repo: z.string().min(1),
          number: z.number().int().positive(),
          labels: z.array(z.string().min(1)).min(1)
        }),
        execute: async (toolInput) => executeTool("github_remove_labels", async () => {
          const connection = input.connections.github;
          if (!connection) {
            return missingGitHubConnection();
          }

          return record(
            await deps.githubTools.removeLabels.execute({
              connection,
              input: toolInput
            })
          );
        })
      }),
      github_request_review: tool({
        description: "Request user or team reviewers for a GitHub pull request.",
        inputSchema: z.object({
          repo: z.string().min(1),
          number: z.number().int().positive(),
          reviewers: z.array(z.string().min(1)).optional(),
          teamReviewers: z.array(z.string().min(1)).optional()
        }),
        execute: async (toolInput) => executeTool("github_request_review", async () => {
          const connection = input.connections.github;
          if (!connection) {
            return missingGitHubConnection();
          }

          return record(
            await deps.githubTools.requestReview.execute({
              connection,
              input: toolInput
            })
          );
        })
      })
    };

    if (deps.jiraTools) {
      tools.jira_get_authenticated_user = tool({
        description: "Return the authenticated Jira user for the Slack user.",
        inputSchema: z.object({}),
        execute: async () => executeTool("jira_get_authenticated_user", async () => {
          const connection = input.connections.jira;
          if (!connection) {
            return missingJiraConnection();
          }

          return record(
            await deps.jiraTools!.getAuthenticatedUser.execute({
              connection
            })
          );
        })
      });
      tools.jira_search_users = tool({
        description:
          "Search Jira users visible to the authenticated Slack user. Use this to resolve a person's name or email to a Jira accountId before assignee queries or assignment edits.",
        inputSchema: z.object({
          query: z
            .string()
            .min(1)
            .describe("Jira user email, display name, or search query")
        }),
        execute: async ({ query }) => executeTool("jira_search_users", async () => {
          const connection = input.connections.jira;
          if (!connection) {
            return missingJiraConnection();
          }

          return record(
            await deps.jiraTools!.searchUsers.execute({
              connection,
              input: { query }
            })
          );
        })
      });
      tools.jira_list_assigned_issues = tool({
        description: "List Jira issues assigned to the Slack user.",
        inputSchema: z.object({}),
        execute: async () => executeTool("jira_list_assigned_issues", async () => {
          const connection = input.connections.jira;
          if (!connection) {
            return missingJiraConnection();
          }

          return record(
            await deps.jiraTools!.listAssignedIssues.execute({
              connection
            })
          );
        })
      });
      tools.jira_search_issues = tool({
        description: "Search Jira issues visible to the authenticated Slack user.",
        inputSchema: z.object({
          jql: z
            .string()
            .min(1)
            .describe("A Jira JQL query, for example: project = ENG AND status != Done")
        }),
        execute: async ({ jql }) => executeTool("jira_search_issues", async () => {
          const connection = input.connections.jira;
          if (!connection) {
            return missingJiraConnection();
          }

          return record(
            await deps.jiraTools!.searchIssues.execute({
              connection,
              input: { jql }
            })
          );
        })
      });
      tools.jira_get_issue = tool({
        description:
          "Get a Jira issue by key, including summary, description, status, type, parent, and labels when available.",
        inputSchema: z.object({
          issueKey: z.string().min(1)
        }),
        execute: async (toolInput) => executeTool("jira_get_issue", async () => {
          const connection = input.connections.jira;
          if (!connection) {
            return missingJiraConnection();
          }

          return record(
            await deps.jiraTools!.getIssue.execute({
              connection,
              input: toolInput
            })
          );
        })
      });
      tools.jira_update_issue = tool({
        description:
          "Update Jira issue summary, description, assignee, or labels. Use only when clearly requested.",
        inputSchema: z.object({
          issueKey: z.string().min(1),
          summary: z.string().min(1).optional(),
          description: z.string().optional(),
          assigneeAccountId: z.string().nullable().optional(),
          labels: z.array(z.string().min(1)).optional()
        }),
        execute: async (toolInput) => executeTool("jira_update_issue", async () => {
          const connection = input.connections.jira;
          if (!connection) {
            return missingJiraConnection();
          }

          return record(
            await deps.jiraTools!.updateIssue.execute({
              connection,
              input: toolInput
            })
          );
        })
      });
      tools.jira_add_comment = tool({
        description: "Add a comment to a Jira issue. Use only when clearly requested.",
        inputSchema: z.object({
          issueKey: z.string().min(1),
          body: z.string().min(1)
        }),
        execute: async (toolInput) => executeTool("jira_add_comment", async () => {
          const connection = input.connections.jira;
          if (!connection) {
            return missingJiraConnection();
          }

          return record(
            await deps.jiraTools!.addComment.execute({
              connection,
              input: toolInput
            })
          );
        })
      });
      tools.jira_transition_issue = tool({
        description:
          "Transition a Jira issue by transition ID or transition name. Use only when clearly requested.",
        inputSchema: z.object({
          issueKey: z.string().min(1),
          transitionId: z.string().min(1).optional(),
          transitionName: z.string().min(1).optional()
        }),
        execute: async (toolInput) =>
          executeTool("jira_transition_issue", async () => {
            const connection = input.connections.jira;
            if (!connection) {
              return missingJiraConnection();
            }

            return record(
              await deps.jiraTools!.transitionIssue.execute({
                connection,
                input: toolInput
              })
            );
          })
      });
      tools.jira_add_labels = tool({
        description: "Add labels to a Jira issue.",
        inputSchema: z.object({
          issueKey: z.string().min(1),
          labels: z.array(z.string().min(1)).min(1)
        }),
        execute: async (toolInput) => executeTool("jira_add_labels", async () => {
          const connection = input.connections.jira;
          if (!connection) {
            return missingJiraConnection();
          }

          return record(
            await deps.jiraTools!.addLabels.execute({
              connection,
              input: toolInput
            })
          );
        })
      });
      tools.jira_remove_labels = tool({
        description: "Remove labels from a Jira issue.",
        inputSchema: z.object({
          issueKey: z.string().min(1),
          labels: z.array(z.string().min(1)).min(1)
        }),
        execute: async (toolInput) => executeTool("jira_remove_labels", async () => {
          const connection = input.connections.jira;
          if (!connection) {
            return missingJiraConnection();
          }

          return record(
            await deps.jiraTools!.removeLabels.execute({
              connection,
              input: toolInput
            })
          );
        })
      });
      tools.jira_link_issues = tool({
        description: "Link two Jira issues. Use only when clearly requested.",
        inputSchema: z.object({
          inwardIssueKey: z.string().min(1),
          outwardIssueKey: z.string().min(1),
          typeName: z.string().min(1).optional(),
          comment: z.string().optional()
        }),
        execute: async (toolInput) => executeTool("jira_link_issues", async () => {
          const connection = input.connections.jira;
          if (!connection) {
            return missingJiraConnection();
          }

          return record(
            await deps.jiraTools!.linkIssues.execute({
              connection,
              input: toolInput
            })
          );
        })
      });
      tools.jira_create_subtask = tool({
        description:
          "Create a Jira subtask under an existing parent issue. Use only when clearly requested.",
        inputSchema: z.object({
          parentIssueKey: z.string().min(1),
          summary: z.string().min(1),
          projectKey: z.string().min(1).optional(),
          issueTypeName: z.string().min(1).optional(),
          issueTypeId: z.string().min(1).optional(),
          description: z.string().optional(),
          assigneeAccountId: z.string().min(1).optional()
        }),
        execute: async (toolInput) => executeTool("jira_create_subtask", async () => {
          const connection = input.connections.jira;
          if (!connection) {
            return missingJiraConnection();
          }

          return record(
            await deps.jiraTools!.createSubtask.execute({
              connection,
              input: toolInput
            })
          );
        })
      });
    }

    if (deps.googleTools) {
      tools.google_get_authenticated_user = tool({
        description: "Return the authenticated Google user for the Slack user.",
        inputSchema: z.object({}),
        execute: async () =>
          executeTool("google_get_authenticated_user", async () => {
            const connection = input.connections.google;
            if (!connection) {
              return missingGoogleConnection();
            }

            return record(
              await deps.googleTools!.getAuthenticatedUser.execute({
                connection
              })
            );
          })
      });
      tools.google_search_drive_files = tool({
        description:
          "Search Google Drive files visible to the authenticated Slack user's connected Google account.",
        inputSchema: z.object({
          query: z.string().optional().describe("Optional Drive search terms"),
          limit: z.number().int().positive().max(20).optional()
        }),
        execute: async ({ query, limit }) =>
          executeTool("google_search_drive_files", async () => {
            const connection = input.connections.google;
            if (!connection) {
              return missingGoogleConnection();
            }

            return record(
              await deps.googleTools!.searchDriveFiles.execute({
                connection,
                input: {
                  ...(query ? { query } : {}),
                  ...(limit ? { limit } : {})
                }
              })
            );
          })
      });
      tools.google_create_drive_text_file = tool({
        description:
          "Create a new app-owned text file in Google Drive using the authenticated Slack user's connected Google account. If no text is supplied, create an empty text file.",
        inputSchema: z.object({
          name: z.string().min(1).max(200).describe("Drive file name"),
          text: z
            .string()
            .max(200_000)
            .optional()
            .describe("Optional text body to write into the file"),
          mimeType: z.string().optional().describe("Optional MIME type")
        }),
        execute: async ({ name, text, mimeType }) =>
          executeTool("google_create_drive_text_file", async () => {
            const connection = input.connections.google;
            if (!connection) {
              return missingGoogleConnection();
            }

            return record(
              await deps.googleTools!.createDriveTextFile.execute({
                connection,
                input: {
                  name,
                  text: text ?? "",
                  ...(mimeType ? { mimeType } : {})
                }
              })
            );
          })
      });
      tools.google_get_drive_file = tool({
        description:
          "Get Google Drive file metadata and optionally text content for an app-accessible file. With the current drive.file permission, app-accessible means files Burble created or files explicitly opened for this app.",
        inputSchema: z.object({
          fileId: z.string().min(1),
          includeContent: z.boolean().optional()
        }),
        execute: async (toolInput) =>
          executeTool("google_get_drive_file", async () => {
            const connection = input.connections.google;
            if (!connection) {
              return missingGoogleConnection();
            }

            return record(
              await deps.googleTools!.getDriveFile.execute({
                connection,
                input: toolInput
              })
            );
          })
      });
      tools.google_update_drive_text_file = tool({
        description:
          "Replace the text contents of an app-accessible Google Drive text file. With the current drive.file permission, app-accessible means files Burble created or files explicitly opened for this app. Use only when clearly requested.",
        inputSchema: z.object({
          fileId: z.string().min(1),
          text: z.string().max(200_000),
          mimeType: z.string().optional()
        }),
        execute: async (toolInput) =>
          executeTool("google_update_drive_text_file", async () => {
            const connection = input.connections.google;
            if (!connection) {
              return missingGoogleConnection();
            }

            return record(
              await deps.googleTools!.updateDriveTextFile.execute({
                connection,
                input: toolInput
              })
            );
          })
      });
      tools.google_append_to_drive_text_file = tool({
        description:
          "Append text to an app-accessible Google Drive text file. With the current drive.file permission, app-accessible means files Burble created or files explicitly opened for this app; reconnecting Google does not grant access to arbitrary existing Drive files. Use only when clearly requested.",
        inputSchema: z.object({
          fileId: z.string().min(1),
          text: z.string().max(200_000),
          separator: z.string().optional(),
          mimeType: z.string().optional()
        }),
        execute: async (toolInput) =>
          executeTool("google_append_to_drive_text_file", async () => {
            const connection = input.connections.google;
            if (!connection) {
              return missingGoogleConnection();
            }

            return record(
              await deps.googleTools!.appendDriveTextFile.execute({
                connection,
                input: toolInput
              })
            );
          })
      });
      tools.google_create_drive_folder = tool({
        description:
          "Create an app-owned folder in Google Drive. Use only when clearly requested.",
        inputSchema: z.object({
          name: z.string().min(1).max(200),
          parentId: z.string().min(1).optional()
        }),
        execute: async (toolInput) =>
          executeTool("google_create_drive_folder", async () => {
            const connection = input.connections.google;
            if (!connection) {
              return missingGoogleConnection();
            }

            return record(
              await deps.googleTools!.createDriveFolder.execute({
                connection,
                input: toolInput
              })
            );
          })
      });
      tools.google_move_drive_file = tool({
        description:
          "Move an app-accessible Google Drive file into a folder. Use only when clearly requested.",
        inputSchema: z.object({
          fileId: z.string().min(1),
          parentId: z.string().min(1),
          removeParentIds: z.array(z.string().min(1)).optional()
        }),
        execute: async (toolInput) =>
          executeTool("google_move_drive_file", async () => {
            const connection = input.connections.google;
            if (!connection) {
              return missingGoogleConnection();
            }

            return record(
              await deps.googleTools!.moveDriveFile.execute({
                connection,
                input: toolInput
              })
            );
          })
      });
      tools.google_search_calendar_events = tool({
        description:
          "Search upcoming Google Calendar events visible to the authenticated Slack user's connected Google account.",
        inputSchema: z.object({
          query: z.string().optional().describe("Optional calendar search terms"),
          timeMin: z
            .string()
            .optional()
            .describe("Optional RFC3339 lower bound; defaults to now"),
          timeMax: z.string().optional().describe("Optional RFC3339 upper bound"),
          limit: z.number().int().positive().max(20).optional()
        }),
        execute: async ({ query, timeMin, timeMax, limit }) =>
          executeTool("google_search_calendar_events", async () => {
            const connection = input.connections.google;
            if (!connection) {
              return missingGoogleConnection();
            }

            return record(
              await deps.googleTools!.searchCalendarEvents.execute({
                connection,
                input: {
                  ...(query ? { query } : {}),
                  ...(timeMin ? { timeMin } : {}),
                  ...(timeMax ? { timeMax } : {}),
                  ...(limit ? { limit } : {})
                }
              })
            );
          })
      });
      tools.google_create_calendar_event = tool({
        description:
          "Create a Google Calendar event. Use only when the user clearly asks to create or schedule a calendar event.",
        inputSchema: z.object({
          calendarId: z.string().min(1).optional(),
          summary: z.string().min(1),
          description: z.string().optional(),
          location: z.string().optional(),
          start: z.string().min(1).describe("RFC3339 date-time"),
          end: z.string().min(1).describe("RFC3339 date-time"),
          timeZone: z.string().min(1).optional(),
          attendees: z.array(z.string().min(1)).optional()
        }),
        execute: async (toolInput) =>
          executeTool("google_create_calendar_event", async () => {
            const connection = input.connections.google;
            if (!connection) {
              return missingGoogleConnection();
            }

            return record(
              await deps.googleTools!.createCalendarEvent.execute({
                connection,
                input: toolInput
              })
            );
          })
      });
      tools.google_update_calendar_event = tool({
        description:
          "Update a Google Calendar event. Use only when the user clearly asks to edit an event.",
        inputSchema: z.object({
          calendarId: z.string().min(1).optional(),
          eventId: z.string().min(1),
          summary: z.string().min(1).optional(),
          description: z.string().optional(),
          location: z.string().optional(),
          start: z.string().min(1).optional(),
          end: z.string().min(1).optional(),
          timeZone: z.string().min(1).optional(),
          attendees: z.array(z.string().min(1)).optional()
        }),
        execute: async (toolInput) =>
          executeTool("google_update_calendar_event", async () => {
            const connection = input.connections.google;
            if (!connection) {
              return missingGoogleConnection();
            }

            return record(
              await deps.googleTools!.updateCalendarEvent.execute({
                connection,
                input: toolInput
              })
            );
          })
      });
      tools.google_search_mail_messages = tool({
        description:
          "Search Gmail messages visible to the authenticated Slack user's connected Google account.",
        inputSchema: z.object({
          query: z.string().min(1).describe("Gmail search query"),
          limit: z.number().int().positive().max(10).optional()
        }),
        execute: async ({ query, limit }) =>
          executeTool("google_search_mail_messages", async () => {
            const connection = input.connections.google;
            if (!connection) {
              return missingGoogleConnection();
            }

            return record(
              await deps.googleTools!.searchMailMessages.execute({
                connection,
                input: {
                  query,
                  ...(limit ? { limit } : {})
                }
            })
          );
        })
      });
      tools.google_analytics_list_properties = tool({
        description:
          "List Google Analytics accounts/properties visible to the authenticated Slack user's connected Google account.",
        inputSchema: z.object({
          limit: z.number().int().positive().max(50).optional()
        }),
        execute: async ({ limit }) =>
          executeTool("google_analytics_list_properties", async () => {
            const connection = input.connections.google;
            if (!connection) {
              return missingGoogleConnection();
            }

            return record(
              await deps.googleTools!.listAnalyticsProperties.execute({
                connection,
                input: {
                  ...(limit ? { limit } : {})
                }
              })
            );
          })
      });
      tools.google_slides_search_presentations = tool({
        description:
          "Search Google Slides presentations visible to the authenticated Slack user's connected Google account.",
        inputSchema: z.object({
          query: z.string().optional(),
          limit: z.number().int().positive().max(20).optional()
        }),
        execute: async ({ query, limit }) =>
          executeTool("google_slides_search_presentations", async () => {
            const connection = input.connections.google;
            if (!connection) {
              return missingGoogleConnection();
            }

            return record(
              await deps.googleTools!.searchSlidesPresentations.execute({
                connection,
                input: {
                  ...(query ? { query } : {}),
                  ...(limit ? { limit } : {})
                }
              })
            );
          })
      });
      tools.google_slides_get_presentation = tool({
        description:
          "Read sanitized Google Slides presentation structure, slide text, layout IDs, and placeholder metadata.",
        inputSchema: z.object({
          presentationId: z.string().min(1),
          includeSlides: z.boolean().optional()
        }),
        execute: async (toolInput) =>
          executeTool("google_slides_get_presentation", async () => {
            const connection = input.connections.google;
            if (!connection) {
              return missingGoogleConnection();
            }

            return record(
              await deps.googleTools!.getSlidesPresentation.execute({
                connection,
                input: toolInput
              })
            );
          })
      });
      tools.google_slides_probe_template = tool({
        description:
          "Probe a Google Slides presentation's layouts and placeholders into a reusable template manifest.",
        inputSchema: z.object({
          presentationId: z.string().min(1)
        }),
        execute: async (toolInput) =>
          executeTool("google_slides_probe_template", async () => {
            const connection = input.connections.google;
            if (!connection) {
              return missingGoogleConnection();
            }

            return record(
              await deps.googleTools!.probeSlidesTemplate.execute({
                connection,
                input: toolInput
              })
            );
          })
      });
      tools.google_slides_copy_presentation = tool({
        description:
          "Copy an existing Google Slides presentation into a new presentation. Use only for explicit user requests to create a new deck from a template; this does not edit slide contents.",
        inputSchema: z.object({
          presentationId: z.string().min(1),
          name: z.string().min(1).max(200)
        }),
        execute: async (toolInput) =>
          executeTool("google_slides_copy_presentation", async () => {
            const connection = input.connections.google;
            if (!connection) {
              return missingGoogleConnection();
            }

            return record(
              await deps.googleTools!.copySlidesPresentation.execute({
                connection,
                input: toolInput
              })
            );
          })
      });
      tools.google_analytics_get_metadata = tool({
        description:
          "List available Google Analytics dimensions and metrics for a GA4 property.",
        inputSchema: z.object({
          propertyId: z.string().min(1),
          dimensionQuery: z.string().optional(),
          metricQuery: z.string().optional(),
          limit: z.number().int().positive().max(100).optional()
        }),
        execute: async (toolInput) =>
          executeTool("google_analytics_get_metadata", async () => {
            const connection = input.connections.google;
            if (!connection) {
              return missingGoogleConnection();
            }

            return record(
              await deps.googleTools!.getAnalyticsMetadata.execute({
                connection,
                input: toolInput
              })
            );
          })
      });
      tools.google_analytics_run_report = tool({
        description:
          "Run a read-only Google Analytics GA4 report for a property using selected dimensions and metrics.",
        inputSchema: z.object({
          propertyId: z.string().min(1),
          startDate: z.string().min(1),
          endDate: z.string().min(1),
          metrics: z.array(z.string().min(1)).min(1).max(10),
          dimensions: z.array(z.string().min(1)).max(10).optional(),
          limit: z.number().int().positive().max(100).optional()
        }),
        execute: async (toolInput) =>
          executeTool("google_analytics_run_report", async () => {
            const connection = input.connections.google;
            if (!connection) {
              return missingGoogleConnection();
            }

            return record(
              await deps.googleTools!.runAnalyticsReport.execute({
                connection,
                input: toolInput
              })
            );
          })
      });
      tools.gmail_create_draft = tool({
        description:
          "Create a Gmail draft only. Do not send email. Use only when the user clearly asks to draft an email.",
        inputSchema: z.object({
          to: z.array(z.string().min(1)).min(1),
          subject: z.string().min(1),
          body: z.string(),
          cc: z.array(z.string().min(1)).optional(),
          bcc: z.array(z.string().min(1)).optional()
        }),
        execute: async (toolInput) => executeTool("gmail_create_draft", async () => {
          const connection = input.connections.google;
          if (!connection) {
            return missingGoogleConnection();
          }

          return record(
            await deps.googleTools!.createMailDraft.execute({
              connection,
              input: toolInput
            })
          );
        })
      });
    }

    if (deps.hubspotTools) {
      tools.hubspot_get_authenticated_user = tool({
        description: "Return the authenticated HubSpot account for the Slack user.",
        inputSchema: z.object({}),
        execute: async () =>
          executeTool("hubspot_get_authenticated_user", async () => {
            const connection = input.connections.hubspot;
            if (!connection) {
              return missingHubSpotConnection();
            }

            return record(
              await deps.hubspotTools!.getAuthenticatedUser.execute({
                connection
              })
            );
          })
      });
      tools.hubspot_search_contacts = tool({
        description:
          "Search HubSpot CRM contacts visible to the authenticated Slack user's connected HubSpot account.",
        inputSchema: z.object({
          query: z.string().min(1).max(200).describe("Contact search terms"),
          limit: z.number().int().positive().max(20).optional()
        }),
        execute: async (toolInput) =>
          executeTool("hubspot_search_contacts", async () => {
            const connection = input.connections.hubspot;
            if (!connection) {
              return missingHubSpotConnection();
            }

            return record(
              await deps.hubspotTools!.searchContacts.execute({
                connection,
                input: toolInput
              })
            );
          })
      });
      tools.hubspot_search_companies = tool({
        description:
          "Search HubSpot CRM companies visible to the authenticated Slack user's connected HubSpot account.",
        inputSchema: z.object({
          query: z.string().min(1).max(200).describe("Company search terms"),
          limit: z.number().int().positive().max(20).optional()
        }),
        execute: async (toolInput) =>
          executeTool("hubspot_search_companies", async () => {
            const connection = input.connections.hubspot;
            if (!connection) {
              return missingHubSpotConnection();
            }

            return record(
              await deps.hubspotTools!.searchCompanies.execute({
                connection,
                input: toolInput
              })
            );
          })
      });
      tools.hubspot_search_deals = tool({
        description:
          "Search HubSpot CRM deals visible to the authenticated Slack user's connected HubSpot account.",
        inputSchema: z.object({
          query: z.string().min(1).max(200).describe("Deal search terms"),
          limit: z.number().int().positive().max(20).optional()
        }),
        execute: async (toolInput) =>
          executeTool("hubspot_search_deals", async () => {
            const connection = input.connections.hubspot;
            if (!connection) {
              return missingHubSpotConnection();
            }

            return record(
              await deps.hubspotTools!.searchDeals.execute({
                connection,
                input: toolInput
              })
            );
          })
      });
      tools.hubspot_search_crm_objects = tool({
        description:
          "Search or list HubSpot CRM objects covered by the connected account's read scopes. Use objectType users for HubSpot CRM user objects, and omit query for most-recent records.",
        inputSchema: z.object({
          objectType: z.enum(hubSpotReadableCrmObjectTypes),
          query: z.string().min(1).max(200).optional(),
          limit: z.number().int().positive().max(20).optional(),
          properties: z.array(z.string().min(1).max(100)).max(20).optional()
        }),
        execute: async (toolInput) =>
          executeTool("hubspot_search_crm_objects", async () => {
            const connection = input.connections.hubspot;
            if (!connection) {
              return missingHubSpotConnection();
            }

            return record(
              await deps.hubspotTools!.searchCrmObjects.execute({
                connection,
                input: toolInput
              })
            );
          })
      });
      tools.hubspot_list_owners = tool({
        description: "List HubSpot CRM owners/users assignable to CRM records.",
        inputSchema: z.object({
          limit: z.number().int().positive().max(100).optional(),
          after: z.string().min(1).max(500).optional()
        }),
        execute: async (toolInput) =>
          executeTool("hubspot_list_owners", async () => {
            const connection = input.connections.hubspot;
            if (!connection) {
              return missingHubSpotConnection();
            }

            return record(
              await deps.hubspotTools!.listOwners.execute({
                connection,
                input: toolInput
              })
            );
          })
      });
      tools.hubspot_list_users = tool({
        description:
          "List users in the connected HubSpot account when settings.users.read was granted.",
        inputSchema: z.object({
          limit: z.number().int().positive().max(100).optional(),
          after: z.string().min(1).max(500).optional()
        }),
        execute: async (toolInput) =>
          executeTool("hubspot_list_users", async () => {
            const connection = input.connections.hubspot;
            if (!connection) {
              return missingHubSpotConnection();
            }

            return record(
              await deps.hubspotTools!.listUsers.execute({
                connection,
                input: toolInput
              })
            );
          })
      });
      tools.hubspot_read_api_resource = tool({
        description:
          "Read a HubSpot API resource with GET for less common read-only HubSpot scopes when no first-class HubSpot tool exists. Use HubSpot API paths such as /crm/v3/schemas/deals or /marketing/v3/campaigns; never include secrets in the path or query.",
        inputSchema: z.object({
          path: z.string().min(1).max(300).startsWith("/"),
          query: z
            .record(
              z.string(),
              z.union([
                z.string(),
                z.number(),
                z.boolean(),
                z.array(z.union([z.string(), z.number(), z.boolean()]))
              ])
            )
            .optional()
        }),
        execute: async (toolInput) =>
          executeTool("hubspot_read_api_resource", async () => {
            const connection = input.connections.hubspot;
            if (!connection) {
              return missingHubSpotConnection();
            }

            return record(
              await deps.hubspotTools!.readApiResource.execute({
                connection,
                input: toolInput
              })
            );
          })
      });
    }

    if (deps.slackTools) {
      tools.slack_search_users = tool({
        description:
          "Search Slack users by display name, real name, username, or Slack user ID.",
        inputSchema: z.object({
          query: z.string().min(1).describe("Slack user name, display name, or ID")
        }),
        execute: async ({ query }) => executeTool("slack_search_users", async () => {
          const connection = input.connections.slack;
          if (!connection) {
            return missingSlackConnection();
          }

          return record(
            await deps.slackTools!.searchUsers.execute({
              connection,
              input: { query }
            })
          );
        })
      });
      tools.slack_search_messages = tool({
        description:
          `Search Slack messages visible to the connected Slack user. The requesting Slack user ID is ${input.principal.slackUserId}; use it as fromUserId for questions like "what did I say about X".`,
        inputSchema: z.object({
          query: z.string().min(1).describe("Slack search terms"),
          fromUserId: z
            .string()
            .optional()
            .describe("Optional Slack user ID to filter by author"),
          inChannel: z
            .string()
            .optional()
            .describe("Optional channel name without #, or channel ID"),
          limit: z.number().int().positive().max(20).optional()
        }),
        execute: async ({ query, fromUserId, inChannel, limit }) =>
          executeTool("slack_search_messages", async () => {
            const connection = input.connections.slack;
            if (!connection) {
              return missingSlackConnection();
            }

            return record(
              await deps.slackTools!.searchMessages.execute({
                connection,
                input: {
                  query,
                  ...(fromUserId ? { fromUserId } : {}),
                  ...(inChannel ? { inChannel } : {}),
                  ...(limit ? { limit } : {})
                }
              })
            );
          })
      });
    }

    deps.logInfo(
      [
        `LLM call start model=${deps.model}`,
        `provider=${deps.resolvedModel.provider}`,
        `modelId=${deps.resolvedModel.modelId}`,
        `textLength=${input.text.length}`
      ].join(" ")
    );

    const llmCallId = crypto.randomUUID();
    const llmStartedAt = Date.now();
    const principalId = `${input.principal.workspaceId}:${input.principal.slackUserId}`;
    deps.observability?.emit({
      name: "llm.call.started",
      callId: llmCallId,
      workspaceId: input.principal.workspaceId,
      principalId,
      model: deps.model,
      provider: deps.resolvedModel.provider,
      attributes: {
        modelId: deps.resolvedModel.modelId,
        textLength: input.text.length
      }
    });

    const result = await deps.generateTextFn({
      model: deps.resolvedModel,
      system: systemPrompt,
      prompt: formatAgentPrompt(input),
      tools,
      stopWhen: stepCountIs(4),
      maxRetries: 1,
      experimental_telemetry: {
        isEnabled: false,
        recordInputs: false,
        recordOutputs: false
      }
    });
    const text = result.text.trim() || "I could not produce a response.";
    if (result.usage) {
      deps.logInfo(
        [
          `LLM usage model=${deps.model}`,
          `provider=${deps.resolvedModel.provider}`,
          `modelId=${deps.resolvedModel.modelId}`,
          summarizeLanguageModelUsage(result.usage)
        ].join(" ")
      );
    }

    deps.logInfo(
      [
        `LLM call finish model=${deps.model}`,
        `classification=${classification}`,
        `textLength=${text.length}`
      ].join(" ")
    );
    deps.observability?.emit({
      name: "llm.call.completed",
      callId: llmCallId,
      workspaceId: input.principal.workspaceId,
      principalId,
      model: deps.model,
      provider: deps.resolvedModel.provider,
      classification,
      durationMs: Date.now() - llmStartedAt,
      status: "ok",
      usage: result.usage ? toAgentUsage(result.usage) : undefined,
      attributes: {
        modelId: deps.resolvedModel.modelId,
        textLength: text.length
      }
    });

    return {
      classification,
      text,
      ...(result.usage ? { usage: toAgentUsage(result.usage) } : {})
    };
}

function formatAgentPrompt(input: AgentInput): string {
  const allRecentMessages = input.context?.recentMessages ?? [];
  const recentMessages = selectRecentSlackContextMessages(allRecentMessages);
  const currentChannel = input.context?.currentChannel;
  const header = [
    `Requesting Slack user ID: ${input.principal.slackUserId}`,
    ...(currentChannel
      ? [
          `Current Slack channel ID: ${currentChannel.id}`,
          `Current Slack channel type: ${currentChannel.isDirectMessage ? "direct_message" : "channel"}`,
          `Current Slack channel history: ${
            currentChannel.historyAvailable
              ? formatRecentSlackHistoryStatus(
                  recentMessages.length,
                  allRecentMessages.length
                )
              : `unavailable (${currentChannel.historyError ?? "unknown_error"})`
          }`
        ]
      : []),
    ""
  ];
  if (recentMessages.length === 0) {
    return [
      ...header,
      ...formatAgentAttachmentContext(input),
      `Current request: ${input.text}`
    ].join("\n");
  }

  return [
    ...header,
    "Recent Slack context (oldest to newest):",
    ...recentMessages.map(
      (message) =>
        `${formatSlackContextAuthor(message)}: ${truncateSlackContextText(message.text)}`
    ),
    "",
    ...formatAgentAttachmentContext(input),
    `Current request: ${input.text}`
  ].join("\n");
}

function selectRecentSlackContextMessages(
  messages: NonNullable<AgentInput["context"]>["recentMessages"]
): NonNullable<AgentInput["context"]>["recentMessages"] {
  return messages.slice(-MAX_RECENT_SLACK_CONTEXT_MESSAGES);
}

function formatRecentSlackHistoryStatus(included: number, total: number): string {
  if (included === total) {
    return `available (${included} recent messages)`;
  }

  return `available (${included} of ${total} recent messages included)`;
}

function truncateSlackContextText(text: string): string {
  return text.length <= MAX_RECENT_SLACK_CONTEXT_MESSAGE_CHARS
    ? text
    : `${text.slice(0, MAX_RECENT_SLACK_CONTEXT_MESSAGE_CHARS - 3)}...`;
}

function formatAgentAttachmentContext(input: AgentInput): string[] {
  const attachments = input.attachments ?? [];
  if (attachments.length === 0) {
    return [];
  }

  return [
    "Current request attachments:",
    ...attachments.map((attachment) => {
      const details = [
        `id=${attachment.id}`,
        `kind=${attachment.kind}`,
        `mime=${attachment.mimeType}`,
        ...(attachment.name ? [`name=${attachment.name}`] : []),
        ...(typeof attachment.sizeBytes === "number"
          ? [`sizeBytes=${attachment.sizeBytes}`]
          : [])
      ];
      return `- ${details.join(" ")}`;
    }),
    ""
  ];
}

function formatSlackContextAuthor(
  message: NonNullable<AgentInput["context"]>["recentMessages"][number]
): string {
  if (message.author === "assistant") {
    return "Burble";
  }

  return message.speaker ? `Slack user ${message.speaker}` : "User";
}

async function defaultGenerateText(
  request: AgentGenerateRequest
): Promise<AgentGenerateResult> {
  return generateText({
    model: request.model,
    system: request.system,
    prompt: request.prompt,
    tools: request.tools,
    stopWhen: request.stopWhen,
    maxRetries: request.maxRetries,
    experimental_telemetry: request.experimental_telemetry
  });
}

function summarizeLanguageModelUsage(usage: LanguageModelUsage): string {
  const inputTokens = usage.inputTokens;
  const outputTokens = usage.outputTokens;
  const totalTokens =
    usage.totalTokens ??
    (typeof inputTokens === "number" && typeof outputTokens === "number"
      ? inputTokens + outputTokens
      : undefined);
  const cachedInputTokens =
    usage.inputTokenDetails?.cacheReadTokens ?? usage.cachedInputTokens;
  const reasoningTokens =
    usage.outputTokenDetails?.reasoningTokens ?? usage.reasoningTokens;

  return [
    `inputTokens=${formatOptionalNumber(inputTokens)}`,
    `outputTokens=${formatOptionalNumber(outputTokens)}`,
    `totalTokens=${formatOptionalNumber(totalTokens)}`,
    `cachedInputTokens=${formatOptionalNumber(cachedInputTokens)}`,
    `reasoningTokens=${formatOptionalNumber(reasoningTokens)}`
  ].join(" ");
}

function toAgentUsage(usage: LanguageModelUsage): AgentUsage {
  const inputTokens = usage.inputTokens;
  const outputTokens = usage.outputTokens;
  const totalTokens =
    usage.totalTokens ??
    (typeof inputTokens === "number" && typeof outputTokens === "number"
      ? inputTokens + outputTokens
      : undefined);
  const cachedInputTokens =
    usage.inputTokenDetails?.cacheReadTokens ?? usage.cachedInputTokens;
  const reasoningTokens =
    usage.outputTokenDetails?.reasoningTokens ?? usage.reasoningTokens;

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens,
    reasoningTokens
  };
}

function formatOptionalNumber(value: number | undefined): string {
  return typeof value === "number" ? String(value) : "unknown";
}

function mergeClassification(
  current: ToolClassification,
  next: ToolClassification
): ToolClassification {
  if (current === "restricted" || next === "restricted") {
    return "restricted";
  }

  if (current === "user_private" || next === "user_private") {
    return "user_private";
  }

  return "public";
}
