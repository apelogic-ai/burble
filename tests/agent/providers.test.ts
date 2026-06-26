import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createDirectModelResolver,
  validateAgentModelId
} from "../../src/agent/providers";

const gatewayEnvKeys = [
  "BURBLE_INFERENCE_BASE_URL",
  "BURBLE_INFERENCE_API_KEY",
  "LLM_GW_BASE_URL",
  "AGENT_RUNTIME_INFERENCE_BASE_URL",
  "OPENAI_BASE_URL",
  "LITELLM_API_KEY"
] as const;

const savedGatewayEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of gatewayEnvKeys) {
    savedGatewayEnv.set(key, Bun.env[key]);
    delete Bun.env[key];
  }
});

afterEach(() => {
  for (const key of gatewayEnvKeys) {
    const value = savedGatewayEnv.get(key);
    if (value === undefined) {
      delete Bun.env[key];
    } else {
      Bun.env[key] = value;
    }
  }
  savedGatewayEnv.clear();
});

describe("validateAgentModelId", () => {
  test("accepts direct provider model ids", () => {
    expect(validateAgentModelId("openai:gpt-5.4")).toBe("openai:gpt-5.4");
    expect(validateAgentModelId("anthropic:claude-opus-4.6")).toBe(
      "anthropic:claude-opus-4.6"
    );
    expect(validateAgentModelId("ollama:qwen3-coder:30b-cloud")).toBe(
      "ollama:qwen3-coder:30b-cloud"
    );
  });

  test("rejects gateway-style model ids", () => {
    expect(() => validateAgentModelId("openai/gpt-5.4")).toThrow(
      "AI_MODEL must use provider:model format"
    );
  });

  test("rejects providers that are not wired for direct calls", () => {
    expect(() => validateAgentModelId("google:gemini-3-flash")).toThrow(
      "AI_MODEL provider must be one of openai, anthropic, ollama"
    );
  });
});

describe("createDirectModelResolver", () => {
  test("routes all providers through the LiteLLM gateway when configured", () => {
    Bun.env.BURBLE_INFERENCE_BASE_URL = "http://llm-gw:4000/v1/";
    const resolveModel = createDirectModelResolver();

    const openaiModel = resolveModel("openai:gpt-5.4");
    const anthropicModel = resolveModel("anthropic:claude-opus-4.6");
    const ollamaModel = resolveModel("ollama:qwen3-coder:30b-cloud");

    expect(openaiModel.provider).toStartWith("litellm");
    expect(openaiModel.modelId).toBe("gpt-5.4");
    expect(anthropicModel.provider).toStartWith("litellm");
    expect(anthropicModel.modelId).toBe("claude-opus-4.6");
    expect(ollamaModel.provider).toStartWith("litellm");
    expect(ollamaModel.modelId).toBe("qwen3-coder:30b-cloud");
  });

  test("resolves OpenAI models through the direct provider package", () => {
    const resolveModel = createDirectModelResolver();
    const model = resolveModel("openai:gpt-5.4");

    expect(model.provider).toStartWith("openai");
    expect(model.modelId).toBe("gpt-5.4");
  });

  test("resolves Anthropic models through the direct provider package", () => {
    const resolveModel = createDirectModelResolver();
    const model = resolveModel("anthropic:claude-opus-4.6");

    expect(model.provider).toStartWith("anthropic");
    expect(model.modelId).toBe("claude-opus-4.6");
  });

  test("resolves Ollama models through the compatible provider package", () => {
    const resolveModel = createDirectModelResolver();
    const model = resolveModel("ollama:qwen3-coder:30b-cloud");

    expect(model.provider).toStartWith("ollama");
    expect(model.modelId).toBe("qwen3-coder:30b-cloud");
  });
});
