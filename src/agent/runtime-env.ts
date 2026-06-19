import type { RuntimeManifest } from "./runtime-manifest";

export const approvedRuntimeForwardedEnv = new Set([
  "AI_MODEL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENROUTER_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OLLAMA_API_KEY",
  "OLLAMA_BASE_URL",
  "OLLAMA_OPENAI_BASE_URL",
  "BURBLE_RUNTIME_CONTRACT_PROBE",
  "OPENCLAW_TIMEOUT_MS",
  "OPENCLAW_STREAM_DEBUG",
  "OPENCLAW_LOG_LEVEL",
  "OPENCLAW_DIAGNOSTICS",
  "OPENCLAW_DEBUG_MODEL_TRANSPORT",
  "OPENCLAW_DEBUG_MODEL_PAYLOAD",
  "OPENCLAW_DEBUG_SSE",
  "OPENCLAW_DEBUG_CODE_MODE",
  "OPENCLAW_FAST_MODE",
  "OPENCLAW_RAW_STREAM_DEBUG",
  "OPENCLAW_GATEWAY_PORT",
  "OPENCLAW_GATEWAY_BIND",
  "OPENCLAW_GATEWAY_TOKEN",
  "HERMES_GATEWAY_COMMAND",
  "HERMES_INFERENCE_MODEL",
  "HERMES_MODEL",
  "HERMES_INFERENCE_PROVIDER",
  "HERMES_RUN_TIMEOUT_SECONDS",
  "HERMES_PROGRESS_INTERVAL_SECONDS",
  "HERMES_WEB_BACKEND",
  "HERMES_WEB_SEARCH_BACKEND",
  "HERMES_WEB_EXTRACT_BACKEND",
  "WEB_TOOLS_DEBUG",
  "EXA_API_KEY",
  "PARALLEL_API_KEY",
  "PARALLEL_SEARCH_MODE",
  "TAVILY_API_KEY",
  "FIRECRAWL_API_KEY",
  "FIRECRAWL_API_URL",
  "FIRECRAWL_GATEWAY_URL",
  "SEARXNG_URL",
  "BRAVE_SEARCH_API_KEY",
  "AGENT_BROWSER_ENGINE",
  "AGENT_BROWSER_ARGS",
  "AGENT_BROWSER_EXECUTABLE_PATH",
  "AGENT_BROWSER_IDLE_TIMEOUT_MS",
  "BROWSER_INACTIVITY_TIMEOUT",
  "BROWSER_CDP_URL",
  "BROWSER_USE_API_KEY",
  "BROWSERBASE_API_KEY",
  "BROWSERBASE_PROJECT_ID",
  "BROWSERBASE_PROXIES",
  "BROWSERBASE_ADVANCED_STEALTH",
  "BROWSERBASE_KEEP_ALIVE",
  "BROWSERBASE_SESSION_TIMEOUT",
  "HERMES_BROWSER_ENGINE",
  "HERMES_BROWSER_CLOUD_PROVIDER"
]);

export function collectApprovedRuntimeEnv(
  source: Record<string, string | undefined>
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of approvedRuntimeForwardedEnv) {
    const value = source[key]?.trim();
    if (value) {
      env[key] = value;
    }
  }
  return env;
}

export function modelProviderUrlsForRuntimeModel(
  model: RuntimeManifest["model"] | string,
  env: Record<string, string | undefined> = {}
): string[] {
  const provider =
    typeof model === "string" ? model.split(":", 1)[0] : model.provider;

  switch (provider) {
    case "anthropic":
      return ["https://api.anthropic.com"];
    case "google":
    case "gemini":
      return ["https://generativelanguage.googleapis.com"];
    case "ollama":
      return [ollamaOpenAiBaseUrl(env)];
    case "openrouter":
      return ["https://openrouter.ai/api/v1"];
    case "openai":
    default:
      return [env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1"];
  }
}

export function runtimeExtraAllowedUrlsFromEnv(
  env: Record<string, string | undefined>
): string[] {
  const urls = [
    env.OPENAI_BASE_URL,
    env.OLLAMA_BASE_URL,
    env.OLLAMA_OPENAI_BASE_URL,
    env.FIRECRAWL_API_URL,
    env.FIRECRAWL_GATEWAY_URL,
    env.SEARXNG_URL
  ];

  if (env.OPENROUTER_API_KEY?.trim()) {
    urls.push("https://openrouter.ai/api/v1");
  }
  if (env.ANTHROPIC_API_KEY?.trim()) {
    urls.push("https://api.anthropic.com");
  }
  if (env.GOOGLE_API_KEY?.trim() || env.GEMINI_API_KEY?.trim()) {
    urls.push("https://generativelanguage.googleapis.com");
  }
  if (env.EXA_API_KEY?.trim()) {
    urls.push("https://api.exa.ai");
  }
  if (env.PARALLEL_API_KEY?.trim()) {
    urls.push("https://api.parallel.ai");
  }
  if (env.TAVILY_API_KEY?.trim()) {
    urls.push("https://api.tavily.com");
  }
  if (env.FIRECRAWL_API_KEY?.trim()) {
    urls.push("https://api.firecrawl.dev");
  }
  if (env.BRAVE_SEARCH_API_KEY?.trim()) {
    urls.push("https://api.search.brave.com");
  }
  if (env.BROWSERBASE_API_KEY?.trim()) {
    urls.push("https://api.browserbase.com");
  }

  return urls.filter((url): url is string => Boolean(url?.trim()));
}

function ollamaOpenAiBaseUrl(env: Record<string, string | undefined>): string {
  const explicit = env.OLLAMA_OPENAI_BASE_URL?.trim();
  if (explicit) {
    return explicit.replace(/\/+$/, "");
  }

  const nativeBaseUrl = (env.OLLAMA_BASE_URL?.trim() || "https://ollama.com")
    .replace(/\/+$/, "");
  return nativeBaseUrl.endsWith("/v1") ? nativeBaseUrl : `${nativeBaseUrl}/v1`;
}
