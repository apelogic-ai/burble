import { describe, expect, test } from "bun:test";
import {
  createDirectModelResolver,
  validateAgentModelId
} from "../../src/agent/providers";

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
