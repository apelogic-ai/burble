export type LlmProvider = "openai" | "anthropic" | "ollama";

export type ParsedLlmModel = {
  provider: LlmProvider;
  model: string;
};

export type OpenClawModelApi = "openai-responses" | "openai-completions";

type OpenClawPatchInput = {
  modelId: string;
  fallbackModelIds?: string[];
  inferenceBaseUrl?: string | null;
  modelApi?: OpenClawModelApi;
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

export function scheduledOpenClawAgentId(agentId: string): string {
  return `${agentId}-scheduled`;
}

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
  const fallbackModels = normalizeFallbackModels(input.fallbackModelIds ?? []);
  const fallbackRefs = fallbackModels.map(toModelRef);
  const agentId = input.agentId ?? "main";
  const providerConfig = buildProviderConfig(
    parsed,
    fallbackModels,
    input.inferenceBaseUrl ?? null,
    input.modelApi ?? "openai-responses",
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
  const agentRuntimeDefaults = {
    model: {
      primary: modelRef,
      ...(fallbackRefs.length > 0 ? { fallbacks: fallbackRefs } : {})
    },
    models: {
      [modelRef]: {
        alias: modelAlias(parsed.provider)
      },
      ...Object.fromEntries(
        fallbackModels.map((fallback) => [
          toModelRef(fallback),
          { alias: modelAlias(fallback.provider) }
        ])
      )
    },
    heartbeat: {
      every: "0m"
    },
    skills: [],
    contextInjection: "never",
    skipBootstrap: true,
    ...(input.fastModeEnabled
      ? {
          thinkingDefault: "minimal",
          reasoningDefault: "off"
        }
      : {})
  };
  const concreteAgentRuntimeConfig = {
    id: agentId,
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
  fallbackModels: ParsedLlmModel[],
  inferenceBaseUrl: string | null,
  modelApi: OpenClawModelApi,
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
            api: modelApi,
            timeoutSeconds: 300,
            models: [
              ...providerModelsFor(parsed.provider, parsed, fallbackModels).map(
                (model) => ({
                  ...model,
                  compat: {
                    supportsPromptCacheKey: true
                  }
                })
              )
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
              ...providerModelsFor("ollama", parsed, fallbackModels)
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
    plugins: pluginConfig(
      providersFor(parsed, fallbackModels),
      burbleChannelPluginPath
    ),
    auth: authProfilesFor(providersFor(parsed, fallbackModels))
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
  providers: LlmProvider[] | LlmProvider,
  burbleChannelPluginPath: string
): Record<string, unknown> {
  const providerList = Array.isArray(providers) ? providers : [providers];
  return {
    enabled: true,
    bundledDiscovery: "allowlist",
    allow: [...providerList, BURBLE_OPENCLAW_CHANNEL_ID],
    load: {
      paths: [burbleChannelPluginPath]
    },
    entries: {
      ...Object.fromEntries(
        providerList.map((provider) => [provider, { enabled: true }])
      ),
      [BURBLE_OPENCLAW_CHANNEL_ID]: {
        enabled: true
      }
    }
  };
}

function normalizeFallbackModels(modelIds: string[]): ParsedLlmModel[] {
  const parsedModels = modelIds.map(parseLlmModelId);
  const seen = new Set<string>();
  return parsedModels.filter((model) => {
    const ref = toModelRef(model);
    if (seen.has(ref)) {
      return false;
    }
    seen.add(ref);
    return true;
  });
}

function toModelRef(model: ParsedLlmModel): string {
  return `${model.provider}/${model.model}`;
}

function providerModelsFor(
  provider: LlmProvider,
  primary: ParsedLlmModel,
  fallbacks: ParsedLlmModel[]
): Array<{ id: string; name: string; input: string[] }> {
  return [primary, ...fallbacks]
    .filter((model) => model.provider === provider)
    .map((model) => ({
      id: model.model,
      name: model.model,
      input: ["text"]
    }));
}

function providersFor(
  primary: ParsedLlmModel,
  fallbacks: ParsedLlmModel[]
): LlmProvider[] {
  return Array.from(
    new Set([primary.provider, ...fallbacks.map((model) => model.provider)])
  );
}

function authProfilesFor(providers: LlmProvider[]): Record<string, unknown> {
  return {
    profiles: Object.fromEntries(
      providers.map((provider) => [
        `${provider}:default`,
        {
          provider,
          mode: "api_key"
        }
      ])
    ),
    order: Object.fromEntries(
      providers.map((provider) => [provider, [`${provider}:default`]])
    )
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
