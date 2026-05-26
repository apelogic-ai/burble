import { generateText, stepCountIs, tool } from "ai";
import type {
  LanguageModelUsage,
  StopCondition,
  TelemetrySettings,
  ToolSet
} from "ai";
import { z } from "zod";
import type { createGitHubTools } from "../tools/github";
import type { createJiraTools } from "../tools/jira";
import type { createSlackTools } from "../tools/slack";
import type { ToolClassification } from "../conversation/types";
import { createDirectModelResolver } from "./providers";
import type { DirectLanguageModel, ModelResolver } from "./providers";
import type {
  AgentInput,
  AgentOutput,
  AgentRunEvent,
  AgentRunner,
  AgentUsage
} from "./types";

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
  jiraTools?: ReturnType<typeof createJiraTools>;
  slackTools?: ReturnType<typeof createSlackTools>;
  resolveModel?: ModelResolver;
  generateText?: AgentGenerateText;
  logInfo?: (message: string) => void;
};

const systemPrompt = [
  "You are Burble, a Slack-native work assistant.",
  "Answer in concise Slack mrkdwn.",
  "Use provider tools for GitHub, Jira, and Slack facts. Do not invent provider data.",
  "Never ask for, print, or expose access tokens.",
  "When a tool says GitHub is not connected, tell the user to run `@Burble connect github`.",
  "When a tool says Jira is not connected, tell the user Jira needs to be connected.",
  "When a tool says Slack is not connected, tell the user to run `/auth slack`.",
  "Use recent Slack context to resolve pronouns and short follow-ups.",
  "For requests about the current Slack channel or chat, answer from the recent Slack context when available. If channel history is unavailable, explain that Burble needs Slack bot history scopes and channel membership.",
  "For Jira questions involving a named person, search Jira users first instead of asking who they are.",
  "For Slack questions like 'what did I say about X', search Slack messages with the requesting Slack user's ID as fromUserId.",
  "Prefer short lists with links when showing issues or pull requests."
].join("\n");

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
        description: "List open GitHub pull requests authored by the Slack user.",
        inputSchema: z.object({}),
        execute: async () => executeTool("github_list_my_pull_requests", async () => {
          const connection = input.connections.github;
          if (!connection) {
            return missingGitHubConnection();
          }

          return record(
            await deps.githubTools.listMyPullRequests.execute({
              connection
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

    return {
      classification,
      text,
      ...(result.usage ? { usage: toAgentUsage(result.usage) } : {})
    };
}

function formatAgentPrompt(input: AgentInput): string {
  const recentMessages = input.context?.recentMessages ?? [];
  const currentChannel = input.context?.currentChannel;
  const header = [
    `Requesting Slack user ID: ${input.principal.slackUserId}`,
    ...(currentChannel
      ? [
          `Current Slack channel ID: ${currentChannel.id}`,
          `Current Slack channel type: ${currentChannel.isDirectMessage ? "direct_message" : "channel"}`,
          `Current Slack channel history: ${
            currentChannel.historyAvailable
              ? `available (${recentMessages.length} recent messages)`
              : `unavailable (${currentChannel.historyError ?? "unknown_error"})`
          }`
        ]
      : []),
    ""
  ];
  if (recentMessages.length === 0) {
    return [...header, `Current request: ${input.text}`].join("\n");
  }

  return [
    ...header,
    "Recent Slack context (oldest to newest):",
    ...recentMessages.map(
      (message) =>
        `${formatSlackContextAuthor(message)}: ${message.text}`
    ),
    "",
    `Current request: ${input.text}`
  ].join("\n");
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
