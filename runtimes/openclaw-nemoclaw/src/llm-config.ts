export type LlmProvider = "openai" | "anthropic" | "ollama";

export type ParsedLlmModel = {
  provider: LlmProvider;
  model: string;
};

type OpenClawPatchInput = {
  modelId: string;
  ollamaBaseUrl: string;
};

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
  const providerConfig = buildProviderConfig(parsed, input.ollamaBaseUrl);
  const systemPromptOverride = [
    "You are Burble's OpenClaw runtime.",
    "Follow the user prompt exactly.",
    "Answer final responses in concise Slack mrkdwn.",
    "When the user prompt requests a JSON tool_call object, output only that JSON object and no prose."
  ].join(" ");
  const patch = {
    agents: {
      defaults: {
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
        systemPromptOverride
      }
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
        enabled: true
      }
    },
    logging: {
      level: "info",
      consoleLevel: "info",
      consoleStyle: "compact",
      file: "/data/openclaw/logs/openclaw.log",
      redactSensitive: "tools"
    },
    ...providerConfig
  };

  return `${JSON.stringify(patch, null, 2)}\n`;
}

function buildProviderConfig(
  parsed: ParsedLlmModel,
  ollamaBaseUrl: string
): Record<string, unknown> {
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
      plugins: pluginConfig("ollama")
    };
  }

  return {
    plugins: pluginConfig(parsed.provider),
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
}

function pluginConfig(provider: LlmProvider): Record<string, unknown> {
  return {
    enabled: true,
    bundledDiscovery: "allowlist",
    allow: [provider],
    entries: {
      [provider]: {
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
