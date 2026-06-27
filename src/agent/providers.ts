import { createProviderRegistry } from "ai";
import type { LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { runtimeInferenceProxyApiKey } from "./runtime-env";

const supportedProviders = ["openai", "anthropic", "ollama"] as const;
type SupportedProvider = (typeof supportedProviders)[number];
export type AgentModelId = `${SupportedProvider}:${string}`;
export type ParsedAgentModelId = {
  provider: SupportedProvider;
  model: string;
};
export type DirectLanguageModel = Extract<
  LanguageModel,
  { provider: string; modelId: string }
>;

export type ModelResolver = (modelId: string) => DirectLanguageModel;

export function validateAgentModelId(modelId: string): AgentModelId {
  parseAgentModelId(modelId);
  return modelId as AgentModelId;
}

export function parseAgentModelId(modelId: string): ParsedAgentModelId {
  const separatorIndex = modelId.indexOf(":");
  const provider = separatorIndex >= 0 ? modelId.slice(0, separatorIndex) : "";
  const model = separatorIndex >= 0 ? modelId.slice(separatorIndex + 1) : "";

  if (!provider || !model) {
    throw new Error("AI_MODEL must use provider:model format");
  }

  if (!supportedProviders.includes(provider as SupportedProvider)) {
    throw new Error(
      `AI_MODEL provider must be one of ${supportedProviders.join(", ")}`
    );
  }

  return {
    provider: provider as SupportedProvider,
    model
  };
}

export function createDirectModelResolver(): ModelResolver {
  const inferenceGatewayBaseUrl = readInferenceGatewayBaseUrl();
  if (inferenceGatewayBaseUrl) {
    const inferenceGateway = createOpenAICompatible({
      name: "litellm",
      baseURL: inferenceGatewayBaseUrl,
      apiKey: readInferenceGatewayApiKey()
    });

    return (modelId: string) => {
      const parsed = parseAgentModelId(modelId);
      return inferenceGateway.chatModel(parsed.model) as DirectLanguageModel;
    };
  }

  const registry = createProviderRegistry({
    openai: createOpenAI(),
    anthropic: createAnthropic()
  });
  const ollama = createOpenAICompatible({
    name: "ollama",
    baseURL: readOllamaOpenAiBaseUrl(),
    apiKey: Bun.env.OLLAMA_API_KEY || "ollama-local"
  });

  return (modelId: string) => {
    const parsed = parseAgentModelId(modelId);
    if (parsed.provider === "ollama") {
      return ollama.chatModel(parsed.model) as DirectLanguageModel;
    }

    return registry.languageModel(
      modelId as `openai:${string}` | `anthropic:${string}`
    ) as DirectLanguageModel;
  };
}

function readInferenceGatewayBaseUrl(): string | null {
  const explicit =
    Bun.env.BURBLE_INFERENCE_BASE_URL?.trim() ||
    Bun.env.LLM_GW_BASE_URL?.trim() ||
    Bun.env.AGENT_RUNTIME_INFERENCE_BASE_URL?.trim() ||
    Bun.env.OPENAI_BASE_URL?.trim();
  return explicit ? explicit.replace(/\/+$/, "") : null;
}

function readInferenceGatewayApiKey(): string {
  return (
    Bun.env.BURBLE_INFERENCE_API_KEY?.trim() ||
    Bun.env.LITELLM_API_KEY?.trim() ||
    runtimeInferenceProxyApiKey
  );
}

function readOllamaOpenAiBaseUrl(): string {
  const explicit = Bun.env.OLLAMA_OPENAI_BASE_URL?.trim();
  if (explicit) {
    return explicit.replace(/\/+$/, "");
  }

  const nativeBaseUrl = (Bun.env.OLLAMA_BASE_URL?.trim() || "https://ollama.com")
    .replace(/\/+$/, "");
  return nativeBaseUrl.endsWith("/v1") ? nativeBaseUrl : `${nativeBaseUrl}/v1`;
}
