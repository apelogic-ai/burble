import { createProviderRegistry } from "ai";
import type { LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";

const supportedProviders = ["openai", "anthropic"] as const;
type SupportedProvider = (typeof supportedProviders)[number];
export type AgentModelId = `${SupportedProvider}:${string}`;
export type DirectLanguageModel = Extract<
  LanguageModel,
  { provider: string; modelId: string }
>;

export type ModelResolver = (modelId: string) => DirectLanguageModel;

export function validateAgentModelId(modelId: string): AgentModelId {
  const [provider, model, extra] = modelId.split(":");

  if (!provider || !model || extra !== undefined) {
    throw new Error("AI_MODEL must use provider:model format");
  }

  if (!supportedProviders.includes(provider as SupportedProvider)) {
    throw new Error(
      `AI_MODEL provider must be one of ${supportedProviders.join(", ")}`
    );
  }

  return modelId as AgentModelId;
}

export function createDirectModelResolver(): ModelResolver {
  const registry = createProviderRegistry({
    openai: createOpenAI(),
    anthropic: createAnthropic()
  });

  return (modelId: string) =>
    registry.languageModel(validateAgentModelId(modelId)) as DirectLanguageModel;
}
