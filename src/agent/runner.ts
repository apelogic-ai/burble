import { generateText, stepCountIs, tool } from "ai";
import type { StopCondition, TelemetrySettings, ToolSet } from "ai";
import { z } from "zod";
import type { createGitHubTools } from "../tools/github";
import type { ToolClassification } from "../conversation/types";
import { createDirectModelResolver } from "./providers";
import type { DirectLanguageModel, ModelResolver } from "./providers";
import type { AgentInput, AgentOutput, AgentRunner } from "./types";

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
};

export type AgentGenerateText = (
  request: AgentGenerateRequest
) => Promise<AgentGenerateResult>;

export type AiSdkAgentRunnerDeps = {
  model: string;
  githubTools: ReturnType<typeof createGitHubTools>;
  resolveModel?: ModelResolver;
  generateText?: AgentGenerateText;
  logInfo?: (message: string) => void;
};

const systemPrompt = [
  "You are Burble, a Slack-native work assistant.",
  "Answer in concise Slack mrkdwn.",
  "Use provider tools for GitHub facts. Do not invent GitHub data.",
  "Never ask for, print, or expose access tokens.",
  "When a tool says GitHub is not connected, tell the user to run `@Burble connect github`.",
  "Prefer short lists with links when showing issues or pull requests."
].join("\n");

export function createAiSdkAgentRunner(
  deps: AiSdkAgentRunnerDeps
): AgentRunner {
  const generate = deps.generateText ?? defaultGenerateText;
  const resolveModel = deps.resolveModel ?? createDirectModelResolver();
  const model = resolveModel(deps.model);
  const logInfo = deps.logInfo ?? (() => undefined);

  return async (input: AgentInput): Promise<AgentOutput> => {
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

    const logToolResult = (
      name: string,
      result: AgentToolResult<unknown>
    ): AgentToolResult<unknown> => {
      logInfo(
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
      logInfo(`LLM tool start name=${name}`);
      return logToolResult(name, await fn());
    };

    const tools = {
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

    logInfo(
      [
        `LLM call start model=${deps.model}`,
        `provider=${model.provider}`,
        `modelId=${model.modelId}`,
        `textLength=${input.text.length}`
      ].join(" ")
    );

    const result = await generate({
      model,
      system: systemPrompt,
      prompt: input.text,
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

    logInfo(
      [
        `LLM call finish model=${deps.model}`,
        `classification=${classification}`,
        `textLength=${text.length}`
      ].join(" ")
    );

    return {
      classification,
      text
    };
  };
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
