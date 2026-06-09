import type { AgentRuntime, Config } from "../config";
import type { createGitHubTools } from "../tools/github";
import type { createGoogleTools } from "../tools/google";
import type { createHubSpotTools } from "../tools/hubspot";
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
  config?: Config;
  runtime: AgentRuntime;
  model: string;
  githubTools: ReturnType<typeof createGitHubTools>;
  googleTools?: ReturnType<typeof createGoogleTools>;
  hubspotTools?: ReturnType<typeof createHubSpotTools>;
  jiraTools?: ReturnType<typeof createJiraTools>;
  slackTools?: ReturnType<typeof createSlackTools>;
  managedRuntimeUrl?: string | null;
  /** Compatibility alias for older call sites. */
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
        ...(deps.hubspotTools ? { hubspotTools: deps.hubspotTools } : {}),
        ...(deps.jiraTools ? { jiraTools: deps.jiraTools } : {}),
        ...(deps.slackTools ? { slackTools: deps.slackTools } : {}),
        ...(deps.resolveModel ? { resolveModel: deps.resolveModel } : {}),
        ...(deps.generateText ? { generateText: deps.generateText } : {}),
        ...(deps.logInfo ? { logInfo: deps.logInfo } : {}),
        ...(deps.observability ? { observability: deps.observability } : {})
      });

    case "burble-runtime": {
      const managedRuntimeUrl =
        deps.managedRuntimeUrl ?? deps.openClawNemoClawUrl;
      if (!managedRuntimeUrl && !deps.runtimeFactory) {
        throw new Error("managed runtime URL is required");
      }

      return createManagedRuntimeAgentRunner({
        ...(deps.config ? { config: deps.config } : {}),
        ...(managedRuntimeUrl ? { baseUrl: managedRuntimeUrl } : {}),
        ...(deps.runtimeFactory ? { runtimeFactory: deps.runtimeFactory } : {}),
        ...(deps.logInfo ? { logInfo: deps.logInfo } : {}),
        ...(deps.observability ? { observability: deps.observability } : {})
      });
    }
  }
}
