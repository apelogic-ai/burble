export type LlmProvider = "openai" | "anthropic" | "ollama";

export type ParsedLlmModel = {
  provider: LlmProvider;
  model: string;
};

type OpenClawPatchInput = {
  modelId: string;
  inferenceBaseUrl?: string | null;
  ollamaBaseUrl: string;
  agentId?: string;
  codeModeEnabled?: boolean;
  fastModeEnabled?: boolean;
  burbleChannelBaseUrl?: string;
  burbleMcpBaseUrl?: string | null;
  burbleChannelPluginPath?: string;
};

export const BURBLE_OPENCLAW_CHANNEL_ID = "burble";
export const BURBLE_OPENCLAW_CHANNEL_PLUGIN_PATH =
  "/runtime/openclaw-plugins/burble-channel";

export function parseLlmModelId(modelId: string): ParsedLlmModel {
  const separatorIndex = modelId.indexOf(":");
  const provider = separatorIndex >= 0 ? modelId.slice(0, separatorIndex) : "";
  const model = separatorIndex >= 0 ? modelId.slice(separatorIndex + 1) : "";

  if (!provider || !model) {
    throw new Error("AI_MODEL must use provider:model format");
  }

  if (!isLlmProvider(provider)) {
    throw new Error("AI_MODEL provider must be one of openai, anthropic, ollama");
  }

  return { provider, model };
}

export function buildOpenClawLlmPatch(input: OpenClawPatchInput): string {
  const parsed = parseLlmModelId(input.modelId);
  const modelRef = `${parsed.provider}/${parsed.model}`;
  const agentId = input.agentId ?? "main";
  const providerConfig = buildProviderConfig(
    parsed,
    input.inferenceBaseUrl ?? null,
    input.ollamaBaseUrl,
    input.burbleChannelBaseUrl ?? "http://127.0.0.1:8080",
    input.burbleChannelPluginPath ?? BURBLE_OPENCLAW_CHANNEL_PLUGIN_PATH
  );
  if (input.fastModeEnabled) {
    const models = readObject(providerConfig.models);
    providerConfig.models = {
      ...models,
      pricing: {
        enabled: false
      }
    };
  }
  const systemPromptOverride = [
    "You are Burble's OpenClaw runtime.",
    "Follow the user prompt exactly.",
    "Answer final responses in concise Slack mrkdwn.",
    "When the user prompt requests a JSON tool_call object, output only that JSON object and no prose."
  ].join(" ");
  const agentRuntimeDefaults = {
    model: {
      primary: modelRef
    },
    models: {
      [modelRef]: {
        alias: modelAlias(parsed.provider)
      }
    },
    heartbeat: {
      every: "0m"
    },
    skills: [],
    contextInjection: "never",
    skipBootstrap: true,
    systemPromptOverride,
    ...(input.fastModeEnabled
      ? {
          thinkingDefault: "minimal",
          reasoningDefault: "off"
        }
      : {})
  };
  const concreteAgentRuntimeConfig = {
    id: agentId,
    systemPromptOverride,
    ...(input.fastModeEnabled
      ? {
          fastModeDefault: true,
          thinkingDefault: "minimal",
          reasoningDefault: "off"
        }
      : {})
  };
  const patch = {
    agents: {
      defaults: agentRuntimeDefaults,
      list: [concreteAgentRuntimeConfig]
    },
    skills: {
      allowBundled: []
    },
    gateway: {
      http: {
        endpoints: {
          responses: {
            enabled: true
          }
        }
      }
    },
    tools: {
      codeMode: {
        enabled: input.codeModeEnabled === true
      }
    },
    logging: {
      level: "info",
      consoleLevel: "info",
      consoleStyle: "compact",
      file: "/data/openclaw/logs/openclaw.log",
      redactSensitive: "tools"
    },
    ...(input.fastModeEnabled
      ? {
          env: {
            shellEnv: {
              enabled: false,
              timeoutMs: 100
            }
          }
        }
      : {}),
    memory: {
      qmd: {
        update: {
          startup: "off"
        }
      }
    },
    ...providerConfig,
    ...(input.burbleMcpBaseUrl
      ? {
          mcp: {
            servers: {
              burble: {
                url: input.burbleMcpBaseUrl,
                transport: "streamable-http"
              }
            }
          }
        }
      : {})
  };

  return `${JSON.stringify(patch, null, 2)}\n`;
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function buildProviderConfig(
  parsed: ParsedLlmModel,
  inferenceBaseUrl: string | null,
  ollamaBaseUrl: string,
  burbleChannelBaseUrl: string,
  burbleChannelPluginPath: string
): Record<string, unknown> {
  if (inferenceBaseUrl?.trim()) {
    const baseUrl = inferenceBaseUrl.trim().replace(/\/+$/, "");
    const provider = "openai";
    return {
      models: {
        providers: {
          [provider]: {
            baseUrl,
            apiKey: "OPENAI_API_KEY",
            api: "openai",
            timeoutSeconds: 300,
            models: [
              {
                id: parsed.model,
                name: parsed.model,
                input: ["text"]
              }
            ]
          }
        }
      },
      ...burbleChannelConfig(),
      plugins: pluginConfig(provider, burbleChannelPluginPath)
    };
  }

  if (parsed.provider === "ollama") {
    return {
      models: {
        providers: {
          ollama: {
            baseUrl: ollamaBaseUrl,
            apiKey: isLocalOllamaBaseUrl(ollamaBaseUrl)
              ? "ollama-local"
              : "OLLAMA_API_KEY",
            api: "ollama",
            timeoutSeconds: 300,
            models: [
              {
                id: parsed.model,
                name: parsed.model,
                input: ["text"]
              }
            ]
          }
        }
      },
      ...burbleChannelConfig(),
      plugins: pluginConfig("ollama", burbleChannelPluginPath)
    };
  }

  return {
    ...burbleChannelConfig(),
    plugins: pluginConfig(parsed.provider, burbleChannelPluginPath),
    auth: {
      profiles: {
        [`${parsed.provider}:default`]: {
          provider: parsed.provider,
          mode: "api_key"
        }
      },
      order: {
        [parsed.provider]: [`${parsed.provider}:default`]
      }
    }
  };

  function burbleChannelConfig(): Record<string, unknown> {
    return {
      channels: {
        [BURBLE_OPENCLAW_CHANNEL_ID]: {
          enabled: true,
          baseUrl: burbleChannelBaseUrl
        }
      }
    };
  }
}

function pluginConfig(
  provider: LlmProvider,
  burbleChannelPluginPath: string
): Record<string, unknown> {
  return {
    enabled: true,
    bundledDiscovery: "allowlist",
    allow: [provider, BURBLE_OPENCLAW_CHANNEL_ID],
    load: {
      paths: [burbleChannelPluginPath]
    },
    entries: {
      [provider]: {
        enabled: true
      },
      [BURBLE_OPENCLAW_CHANNEL_ID]: {
        enabled: true
      }
    }
  };
}

function modelAlias(provider: LlmProvider): string {
  switch (provider) {
    case "anthropic":
      return "Claude";
    case "ollama":
      return "Ollama";
    case "openai":
      return "GPT";
  }
}

function isLlmProvider(provider: string): provider is LlmProvider {
  return provider === "openai" || provider === "anthropic" || provider === "ollama";
}

function isLocalOllamaBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return (
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "::1" ||
      url.hostname.endsWith(".local") ||
      !url.hostname.includes(".")
    );
  } catch {
    return false;
  }
}
