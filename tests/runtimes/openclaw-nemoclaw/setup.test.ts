import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureOpenClawSetup } from "../../../runtimes/openclaw-nemoclaw/src/setup";
import type { RuntimeConfig } from "../../../runtimes/openclaw-nemoclaw/src/config";

const config: RuntimeConfig = {
  port: 8080,
  toolGatewayUrl: "http://burble-app:3000/internal/tools",
  internalToken: "secret",
  mcpGatewayUrl: null,
  runtimeJwt: null,
  engine: "openclaw",
  openClawCommand: "openclaw",
  openClawAgent: "main",
  openClawTimeoutMs: 60000,
  openClawStateDir: "/data/openclaw/state",
  openClawConfigPath: "/data/openclaw/config/openclaw.json",
  openClawWorkspaceDir: "/data/openclaw/workspace",
  openClawSetupOnStart: true,
  openClawConfigPatchPath: null,
  openClawValidateOnStart: true,
  openClawStreamDebug: false,
  openClawRawStreamDebug: false,
  llmModel: "openai:gpt-5.4",
  ollamaBaseUrl: "https://ollama.com"
};

describe("ensureOpenClawSetup", () => {
  test("skips setup for deterministic engine", async () => {
    let called = false;

    await ensureOpenClawSetup(
      { ...config, engine: "deterministic" },
      async () => {
        called = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    );

    expect(called).toBe(false);
  });

  test("skips setup command when setup is disabled", async () => {
    const calls: string[][] = [];
    const runtimeConfig = await configWithState({ openClawSetupOnStart: false });

    await ensureOpenClawSetup(
      runtimeConfig,
      async (_command, args) => {
        calls.push(args);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    );

    expect(calls).toEqual([
      ["config", "patch", "--file", llmPatchPath(runtimeConfig)],
      ["config", "validate"]
    ]);
  });

  test("runs non-interactive setup with persistent state paths", async () => {
    const calls: Array<{
      command: string;
      args: string[];
      env: Record<string, string>;
    }> = [];
    const runtimeConfig = await configWithState();

    await ensureOpenClawSetup(runtimeConfig, async (command, args, options) => {
      calls.push({ command, args, env: options.env ?? {} });
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    expect(calls).toEqual([
      {
        command: "openclaw",
        args: [
          "onboard",
          "--non-interactive",
          "--accept-risk",
          "--flow",
          "quickstart",
          "--mode",
          "local",
          "--auth-choice",
          "skip",
          "--skip-daemon",
          "--skip-channels",
          "--skip-skills",
          "--skip-search",
          "--skip-health",
          "--workspace",
          "/data/openclaw/workspace",
          "--json"
        ],
        env: {
          OPENCLAW_STATE_DIR: runtimeConfig.openClawStateDir,
          OPENCLAW_CONFIG_PATH: "/data/openclaw/config/openclaw.json"
        }
      },
      {
        command: "openclaw",
        args: ["config", "patch", "--file", llmPatchPath(runtimeConfig)],
        env: {
          OPENCLAW_STATE_DIR: runtimeConfig.openClawStateDir,
          OPENCLAW_CONFIG_PATH: "/data/openclaw/config/openclaw.json"
        }
      },
      {
        command: "openclaw",
        args: ["config", "validate"],
        env: {
          OPENCLAW_STATE_DIR: runtimeConfig.openClawStateDir,
          OPENCLAW_CONFIG_PATH: "/data/openclaw/config/openclaw.json"
        }
      }
    ]);
  });

  test("logs OpenClaw startup lifecycle", async () => {
    const logs: string[] = [];
    const patchPath = await writePatchFile("{ model: 'test' }\n");

    await ensureOpenClawSetup(
      await configWithState({ openClawConfigPatchPath: patchPath }),
      async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      (message) => logs.push(message)
    );

    expect(logs).toEqual([
      "OpenClaw onboard start workspace=/data/openclaw/workspace hasPatch=true",
      "OpenClaw onboard finish",
      `OpenClaw config patch start path=${patchPath}`,
      "OpenClaw config patch finish",
      "OpenClaw LLM config selected model=openai:gpt-5.4 ollamaBaseUrl=https://ollama.com",
      expect.stringContaining("OpenClaw config patch start path="),
      "OpenClaw config patch finish",
      "OpenClaw config validate start",
      "OpenClaw config validate finish"
    ]);
  });

  test("applies an optional config patch before validation", async () => {
    const calls: string[][] = [];
    const patchPath = await writePatchFile("{ model: 'test' }\n");
    const runtimeConfig = await configWithState({ openClawConfigPatchPath: patchPath });

    await ensureOpenClawSetup(
      runtimeConfig,
      async (_command, args) => {
        calls.push(args);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    );

    expect(calls).toEqual([
      [
        "onboard",
        "--non-interactive",
        "--accept-risk",
        "--flow",
        "quickstart",
        "--mode",
        "local",
        "--auth-choice",
        "skip",
        "--skip-daemon",
        "--skip-channels",
        "--skip-skills",
        "--skip-search",
        "--skip-health",
        "--workspace",
        "/data/openclaw/workspace",
        "--json"
      ],
      ["config", "patch", "--file", patchPath],
      ["config", "patch", "--file", llmPatchPath(runtimeConfig)],
      ["config", "validate"]
    ]);
  });

  test("can disable startup validation", async () => {
    const calls: string[][] = [];
    const runtimeConfig = await configWithState({ openClawValidateOnStart: false });

    await ensureOpenClawSetup(
      runtimeConfig,
      async (_command, args) => {
        calls.push(args);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    );

    expect(calls).toEqual([
      [
        "onboard",
        "--non-interactive",
        "--accept-risk",
        "--flow",
        "quickstart",
        "--mode",
        "local",
        "--auth-choice",
        "skip",
        "--skip-daemon",
        "--skip-channels",
        "--skip-skills",
        "--skip-search",
        "--skip-health",
        "--workspace",
        "/data/openclaw/workspace",
        "--json"
      ],
      ["config", "patch", "--file", llmPatchPath(runtimeConfig)]
    ]);
  });

  test("skips repeated setup when persisted state is already initialized", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "burble-openclaw-state-"));
    const calls: string[][] = [];
    const runtimeConfig = {
      ...config,
      openClawStateDir: stateDir
    };

    await ensureOpenClawSetup(runtimeConfig, async (_command, args) => {
      calls.push(args);
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    await ensureOpenClawSetup(runtimeConfig, async (_command, args) => {
      calls.push(args);
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    expect(calls).toHaveLength(3);
    expect(calls[0][0]).toBe("onboard");
    expect(calls[1]).toEqual(["config", "patch", "--file", llmPatchPath(runtimeConfig)]);
    expect(calls[2]).toEqual(["config", "validate"]);
  });

  test("reruns setup when the config patch changes", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "burble-openclaw-state-"));
    const patchDir = await mkdtemp(join(tmpdir(), "burble-openclaw-patch-"));
    const patchPath = join(patchDir, "openai.json5");
    await mkdir(patchDir, { recursive: true });
    await writeFile(patchPath, "{ model: 'first' }\n");

    const calls: string[][] = [];
    const runtimeConfig = {
      ...config,
      openClawStateDir: stateDir,
      openClawConfigPatchPath: patchPath
    };

    await ensureOpenClawSetup(runtimeConfig, async (_command, args) => {
      calls.push(args);
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    await writeFile(patchPath, "{ model: 'second' }\n");
    await ensureOpenClawSetup(runtimeConfig, async (_command, args) => {
      calls.push(args);
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    expect(calls.filter((args) => args[0] === "onboard")).toHaveLength(2);
    expect(calls.filter((args) => args[0] === "config")).toHaveLength(6);
  });

  test("writes a normalized Ollama OpenClaw model patch", async () => {
    const runtimeConfig = await configWithState({
      llmModel: "ollama:qwen3-coder:30b-cloud",
      ollamaBaseUrl: "https://ollama.com",
      openClawSetupOnStart: false,
      openClawValidateOnStart: false
    });

    await ensureOpenClawSetup(runtimeConfig, async () => ({
      exitCode: 0,
      stdout: "",
      stderr: ""
    }));

    const patch = await readFile(llmPatchPath(runtimeConfig), "utf8");
    expect(patch).toContain('"primary": "ollama/qwen3-coder:30b-cloud"');
    expect(patch).toContain('"baseUrl": "https://ollama.com"');
    expect(patch).toContain('"apiKey": "OLLAMA_API_KEY"');
    expect(patch).toContain('"allow": [');
    expect(patch).toContain('"ollama"');
  });

  test("surfaces onboarding failures without leaking stderr", async () => {
    await expect(
      ensureOpenClawSetup(config, async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "secret leaked"
      }))
    ).rejects.toThrow("OpenClaw onboard exited with code 1");
  });

  test("surfaces config patch failures without leaking stderr", async () => {
    await expect(
      ensureOpenClawSetup(
        await configWithState({
          openClawSetupOnStart: false,
          openClawConfigPatchPath: "/patch.json5"
        }),
        async () => ({
          exitCode: 1,
          stdout: "",
          stderr: "secret leaked"
        })
      )
    ).rejects.toThrow("OpenClaw config patch exited with code 1");
  });

  test("surfaces validation failures without leaking stderr", async () => {
    let callCount = 0;
    await expect(
      ensureOpenClawSetup(
        await configWithState({ openClawSetupOnStart: false }),
        async () => ({
          exitCode: ++callCount === 1 ? 0 : 1,
          stdout: "",
          stderr: "secret leaked"
        })
      )
    ).rejects.toThrow("OpenClaw config validate exited with code 1");
  });
});

async function configWithState(
  overrides: Partial<RuntimeConfig> = {}
): Promise<RuntimeConfig> {
  return {
    ...config,
    openClawStateDir: await mkdtemp(join(tmpdir(), "burble-openclaw-state-")),
    ...overrides
  };
}

async function writePatchFile(content: string): Promise<string> {
  const patchDir = await mkdtemp(join(tmpdir(), "burble-openclaw-patch-"));
  const patchPath = join(patchDir, "openai.json5");
  await writeFile(patchPath, content);
  return patchPath;
}

function llmPatchPath(config: RuntimeConfig): string {
  return join(config.openClawStateDir, "burble-llm.json");
}
