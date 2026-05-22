import type { AgentRuntime } from "../config";
import type { createGitHubTools } from "../tools/github";
import type { createJiraTools } from "../tools/jira";
import { createAiSdkAgentRunner } from "./runner";
import type { AgentGenerateText } from "./runner";
import { createOpenClawNemoClawAgentRunner } from "./runners/openclaw-nemoclaw";
import type { ModelResolver } from "./providers";
import type { RuntimeFactory } from "./runtime-factory";
import type { AgentRunner } from "./types";

export type ConfiguredAgentRunnerDeps = {
  runtime: AgentRuntime;
  model: string;
  githubTools: ReturnType<typeof createGitHubTools>;
  jiraTools?: ReturnType<typeof createJiraTools>;
  openClawNemoClawUrl?: string | null;
  runtimeFactory?: RuntimeFactory;
  resolveModel?: ModelResolver;
  generateText?: AgentGenerateText;
  logInfo?: (message: string) => void;
};

export function createConfiguredAgentRunner(
  deps: ConfiguredAgentRunnerDeps
): AgentRunner {
  switch (deps.runtime) {
    case "ai-sdk":
      return createAiSdkAgentRunner({
        model: deps.model,
        githubTools: deps.githubTools,
        ...(deps.jiraTools ? { jiraTools: deps.jiraTools } : {}),
        ...(deps.resolveModel ? { resolveModel: deps.resolveModel } : {}),
        ...(deps.generateText ? { generateText: deps.generateText } : {}),
        ...(deps.logInfo ? { logInfo: deps.logInfo } : {})
      });

    case "openclaw-nemoclaw":
      if (!deps.openClawNemoClawUrl && !deps.runtimeFactory) {
        throw new Error("OPENCLAW_NEMOCLAW_URL is required");
      }

      return createOpenClawNemoClawAgentRunner({
        ...(deps.openClawNemoClawUrl
          ? { baseUrl: deps.openClawNemoClawUrl }
          : {}),
        ...(deps.runtimeFactory ? { runtimeFactory: deps.runtimeFactory } : {}),
        ...(deps.logInfo ? { logInfo: deps.logInfo } : {})
      });
  }
}
