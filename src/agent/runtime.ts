import type { AgentRuntime } from "../config";
import type { createGitHubTools } from "../tools/github";
import type { createGoogleTools } from "../tools/google";
import type { createJiraTools } from "../tools/jira";
import type { createSlackTools } from "../tools/slack";
import { createAiSdkAgentRunner } from "./runner";
import type { AgentGenerateText } from "./runner";
import { createManagedRuntimeAgentRunner } from "./runners/managed-runtime";
import type { ModelResolver } from "./providers";
import type { RuntimeFactory } from "./runtime-factory";
import type { AgentRunner } from "./types";
import type { ObservabilitySink } from "../observability";

export type ConfiguredAgentRunnerDeps = {
  runtime: AgentRuntime;
  model: string;
  githubTools: ReturnType<typeof createGitHubTools>;
  googleTools?: ReturnType<typeof createGoogleTools>;
  jiraTools?: ReturnType<typeof createJiraTools>;
  slackTools?: ReturnType<typeof createSlackTools>;
  openClawNemoClawUrl?: string | null;
  runtimeFactory?: RuntimeFactory;
  resolveModel?: ModelResolver;
  generateText?: AgentGenerateText;
  logInfo?: (message: string) => void;
  observability?: ObservabilitySink;
};

export function createConfiguredAgentRunner(
  deps: ConfiguredAgentRunnerDeps
): AgentRunner {
  switch (deps.runtime) {
    case "ai-sdk":
      return createAiSdkAgentRunner({
        model: deps.model,
        githubTools: deps.githubTools,
        ...(deps.googleTools ? { googleTools: deps.googleTools } : {}),
        ...(deps.jiraTools ? { jiraTools: deps.jiraTools } : {}),
        ...(deps.slackTools ? { slackTools: deps.slackTools } : {}),
        ...(deps.resolveModel ? { resolveModel: deps.resolveModel } : {}),
        ...(deps.generateText ? { generateText: deps.generateText } : {}),
        ...(deps.logInfo ? { logInfo: deps.logInfo } : {}),
        ...(deps.observability ? { observability: deps.observability } : {})
      });

    case "burble-runtime":
      if (!deps.openClawNemoClawUrl && !deps.runtimeFactory) {
        throw new Error("managed runtime URL is required");
      }

      return createManagedRuntimeAgentRunner({
        ...(deps.openClawNemoClawUrl
          ? { baseUrl: deps.openClawNemoClawUrl }
          : {}),
        ...(deps.runtimeFactory ? { runtimeFactory: deps.runtimeFactory } : {}),
        ...(deps.logInfo ? { logInfo: deps.logInfo } : {}),
        ...(deps.observability ? { observability: deps.observability } : {})
      });
  }
}
