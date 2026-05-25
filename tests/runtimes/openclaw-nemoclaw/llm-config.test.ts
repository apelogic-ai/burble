import { describe, expect, test } from "bun:test";
import {
  buildOpenClawLlmPatch,
  parseLlmModelId
} from "../../../runtimes/openclaw-nemoclaw/src/llm-config";

describe("parseLlmModelId", () => {
  test("keeps provider tags after the first colon in the model name", () => {
    expect(parseLlmModelId("ollama:qwen3-coder:30b-cloud")).toEqual({
      provider: "ollama",
      model: "qwen3-coder:30b-cloud"
    });
  });
});

describe("buildOpenClawLlmPatch", () => {
  test("builds an OpenAI provider patch", () => {
    const patch = JSON.parse(
      buildOpenClawLlmPatch({
        modelId: "openai:gpt-5.4",
        ollamaBaseUrl: "https://ollama.com"
      })
    );

    expect(patch.agents.defaults.model.primary).toBe("openai/gpt-5.4");
    expect(patch.agents.defaults.heartbeat.every).toBe("0m");
    expect(patch.agents.defaults.skills).toEqual([]);
    expect(patch.agents.defaults.contextInjection).toBe("never");
    expect(patch.agents.defaults.skipBootstrap).toBe(true);
    expect(patch.agents.defaults.systemPromptOverride).toContain(
      "Burble's OpenClaw runtime"
    );
    expect(patch.skills.allowBundled).toEqual([]);
    expect(patch.gateway.http.endpoints.responses.enabled).toBe(true);
    expect(patch.logging.file).toBe("/data/openclaw/logs/openclaw.log");
    expect(patch.plugins.allow).toEqual(["openai"]);
    expect(patch.auth.profiles["openai:default"]).toEqual({
      provider: "openai",
      mode: "api_key"
    });
  });

  test("builds an Ollama cloud provider patch", () => {
    const patch = JSON.parse(
      buildOpenClawLlmPatch({
        modelId: "ollama:qwen3-coder:30b-cloud",
        ollamaBaseUrl: "https://ollama.com"
      })
    );

    expect(patch.agents.defaults.model.primary).toBe(
      "ollama/qwen3-coder:30b-cloud"
    );
    expect(patch.plugins.allow).toEqual(["ollama"]);
    expect(patch.models.providers.ollama).toMatchObject({
      baseUrl: "https://ollama.com",
      apiKey: "OLLAMA_API_KEY",
      api: "ollama"
    });
  });
});
