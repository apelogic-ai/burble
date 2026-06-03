import { describe, expect, test } from "bun:test";
import {
  BURBLE_OPENCLAW_CHANNEL_PLUGIN_PATH,
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
    expect(patch.agents.list).toEqual([
      {
        id: "main",
        default: true,
        identity: {
          name: "Burble",
          nature: "AI copilot",
          theme: "Slack assistant",
          vibe: "concise and helpful",
          emoji: ":robot_face:"
        }
      }
    ]);
    expect(patch.memory.qmd.update.startup).toBe("off");
    expect(patch.skills.allowBundled).toEqual([]);
    expect(patch.gateway.http.endpoints.responses.enabled).toBe(true);
    expect(patch.tools.codeMode.enabled).toBe(false);
    expect(patch.logging.file).toBe("/data/openclaw/logs/openclaw.log");
    expect(patch.plugins.allow).toEqual(["openai", "burble"]);
    expect(patch.plugins.load.paths).toEqual([
      BURBLE_OPENCLAW_CHANNEL_PLUGIN_PATH
    ]);
    expect(patch.plugins.entries.burble.enabled).toBe(true);
    expect(patch.channels.burble).toEqual({
      enabled: true,
      baseUrl: "http://127.0.0.1:8080"
    });
    expect(patch.auth.profiles["openai:default"]).toEqual({
      provider: "openai",
      mode: "api_key"
    });
  });

  test("enables OpenClaw code mode only when requested", () => {
    const patch = JSON.parse(
      buildOpenClawLlmPatch({
        modelId: "openai:gpt-5.4",
        ollamaBaseUrl: "https://ollama.com",
        codeModeEnabled: true
      })
    );

    expect(patch.tools.codeMode.enabled).toBe(true);
  });

  test("enables the tightened OpenClaw fast path only when requested", () => {
    const patch = JSON.parse(
      buildOpenClawLlmPatch({
        modelId: "openai:gpt-5.4",
        ollamaBaseUrl: "https://ollama.com",
        agentId: "burble",
        fastModeEnabled: true
      })
    );

    expect(patch.agents.defaults.thinkingDefault).toBe("minimal");
    expect(patch.agents.defaults.reasoningDefault).toBe("off");
    expect(patch.agents.list).toEqual([
      {
        id: "burble",
        default: true,
        identity: {
          name: "Burble",
          nature: "AI copilot",
          theme: "Slack assistant",
          vibe: "concise and helpful",
          emoji: ":robot_face:"
        },
        fastModeDefault: true,
        thinkingDefault: "minimal",
        reasoningDefault: "off"
      }
    ]);
    expect(JSON.stringify(patch.agents.list)).not.toContain("skipBootstrap");
    expect(JSON.stringify(patch.agents.list)).not.toContain("contextInjection");
    expect(JSON.stringify(patch.agents.list)).not.toContain("systemPromptOverride");
    expect(JSON.stringify(patch.agents.list)).not.toContain("skills");
    expect(patch.models.pricing.enabled).toBe(false);
    expect(patch.env.shellEnv).toEqual({
      enabled: false,
      timeoutMs: 100
    });
    expect(patch.memory.qmd.update.startup).toBe("off");
  });

  test("configures Burble MCP through the local runtime proxy", () => {
    const patch = JSON.parse(
      buildOpenClawLlmPatch({
        modelId: "openai:gpt-5.4",
        ollamaBaseUrl: "https://ollama.com",
        burbleMcpBaseUrl: "http://127.0.0.1:8080/internal/burble/mcp"
      })
    );

    expect(patch.mcp.servers.burble).toEqual({
      url: "http://127.0.0.1:8080/internal/burble/mcp",
      transport: "streamable-http"
    });
    expect(JSON.stringify(patch)).not.toContain("runtime-jwt");
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
    expect(patch.plugins.allow).toEqual(["ollama", "burble"]);
    expect(patch.models.providers.ollama).toMatchObject({
      baseUrl: "https://ollama.com",
      apiKey: "OLLAMA_API_KEY",
      api: "ollama"
    });
  });
});
