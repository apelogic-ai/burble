import { describe, expect, test } from "bun:test";
import {
  collectApprovedRuntimeEnv,
  modelProviderUrlsForRuntimeModel,
  runtimeExtraAllowedUrlsFromEnv
} from "../../src/agent/runtime-env";

describe("runtime env egress helpers", () => {
  test("derives browser provider egress hosts from forwarded env", () => {
    const env = {
      OPENAI_API_KEY: "openai-key",
      ANTHROPIC_API_KEY: "anthropic-key",
      BROWSER_USE_API_KEY: "browser-use-key",
      BROWSERBASE_API_KEY: "browserbase-key",
      BROWSER_CDP_URL: "wss://Chrome.Example.Net:9222/devtools/browser/1",
      UNAPPROVED_SECRET: "nope"
    };

    expect(collectApprovedRuntimeEnv(env)).toEqual({
      BROWSER_CDP_URL: "wss://Chrome.Example.Net:9222/devtools/browser/1"
    });
    expect(collectApprovedRuntimeEnv(env).OPENAI_API_KEY).toBeUndefined();
    expect(collectApprovedRuntimeEnv(env).ANTHROPIC_API_KEY).toBeUndefined();
    expect(collectApprovedRuntimeEnv(env).BROWSER_USE_API_KEY).toBeUndefined();
    expect(collectApprovedRuntimeEnv(env).BROWSERBASE_API_KEY).toBeUndefined();
    expect(runtimeExtraAllowedUrlsFromEnv(env)).toEqual([
      "https://api.anthropic.com",
      "https://api.browserbase.com",
      "wss://connect.browserbase.com",
      "https://api.browser-use.com",
      "wss://Chrome.Example.Net:9222/devtools/browser/1"
    ]);
  });

  test("fails loudly for unsupported sandbox model providers", () => {
    expect(() =>
      modelProviderUrlsForRuntimeModel({
        provider: "deepseek",
        model: "deepseek-chat"
      })
    ).toThrow("Unsupported sandbox model provider for egress allowlist: deepseek");
  });

  test("prefers a neutral inference gateway over direct provider egress", () => {
    expect(
      modelProviderUrlsForRuntimeModel("openai:gpt-5.4", {}, {
        inferenceBaseUrl: "http://llm-gw:4000/v1"
      })
    ).toEqual(["http://llm-gw:4000/v1"]);

    expect(
      modelProviderUrlsForRuntimeModel("openai:gpt-5.4", {
        AGENT_RUNTIME_INFERENCE_BASE_URL: "http://inference.local/v1"
      })
    ).toEqual(["http://inference.local/v1"]);
  });
});
