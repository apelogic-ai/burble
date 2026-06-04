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
  openClawCodeMode: false,
  openClawFastMode: false,
  openClawRawStreamDebug: false,
  openClawGatewayPort: 18789,
  openClawGatewayBind: "loopback",
  openClawGatewayToken: "gateway-token",
  llmModel: "openai:gpt-5.4",
  ollamaBaseUrl: "https://ollama.com"
};

describe("ensureOpenClawSetup", () => {
  test("skips setup for deterministic engine", async () => {
    let called = false;
    const runtimeConfig = await configWithConfigFile({
      engine: "deterministic"
    });

    await ensureOpenClawSetup(
      runtimeConfig,
      async () => {
        called = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    );

    expect(called).toBe(false);
    const writtenConfig = JSON.parse(
      await readFile(runtimeConfig.openClawConfigPath, "utf8")
    );
    expect(writtenConfig).toMatchObject({
      agents: {
        defaults: {
          workspace: runtimeConfig.openClawWorkspaceDir,
          model: {
            primary: "openai/gpt-5.4"
          },
          skipBootstrap: true
        },
        list: [
          {
            id: runtimeConfig.openClawAgent,
            default: true,
            identity: {
              name: "Burble",
              theme: "Slack assistant",
              emoji: ":robot_face:"
            }
          }
        ]
      },
      messages: {
        visibleReplies: "automatic",
        groupChat: {
          visibleReplies: "message_tool",
          unmentionedInbound: "room_event"
        }
      }
    });
    expect(writtenConfig.runtime).toBeUndefined();
    expect(JSON.stringify(writtenConfig)).not.toContain("secret");
  });

  test("skips setup for burble-direct engine", async () => {
    let called = false;
    const runtimeConfig = await configWithConfigFile({
      engine: "burble-direct",
      mcpGatewayUrl: "http://agentgateway:3000/mcp",
      runtimeJwt: "runtime-jwt"
    });

    await ensureOpenClawSetup(
      runtimeConfig,
      async () => {
        called = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    );

    expect(called).toBe(false);
    const writtenConfig = JSON.parse(
      await readFile(runtimeConfig.openClawConfigPath, "utf8")
    );
    expect(writtenConfig).toMatchObject({
      agents: {
        defaults: {
          workspace: runtimeConfig.openClawWorkspaceDir,
          model: {
            primary: "openai/gpt-5.4"
          },
          skipBootstrap: true
        },
        list: [
          {
            id: runtimeConfig.openClawAgent,
            default: true,
            identity: {
              name: "Burble",
              theme: "Slack assistant",
              emoji: ":robot_face:"
            }
          }
        ]
      },
      messages: {
        visibleReplies: "automatic",
        groupChat: {
          visibleReplies: "message_tool",
          unmentionedInbound: "room_event"
        }
      }
    });
    expect(writtenConfig.mcp.servers.burble).toEqual({
      url: `http://127.0.0.1:${runtimeConfig.port}/internal/burble/mcp`,
      transport: "streamable-http"
    });
    expect(writtenConfig.runtime).toBeUndefined();
    expect(JSON.stringify(writtenConfig)).not.toContain("runtime-jwt");
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
      expect.stringMatching(
        /^OpenClaw setup phase finish phase=onboard engine=openclaw elapsedMs=\d+$/
      ),
      `OpenClaw config patch start path=${patchPath}`,
      "OpenClaw config patch finish",
      expect.stringMatching(
        /^OpenClaw setup phase finish phase=config_patch_static engine=openclaw elapsedMs=\d+$/
      ),
      "OpenClaw LLM config selected model=openai:gpt-5.4 ollamaBaseUrl=https://ollama.com",
      expect.stringContaining("OpenClaw config patch start path="),
      "OpenClaw config patch finish",
      expect.stringMatching(
        /^OpenClaw setup phase finish phase=config_patch_generated engine=openclaw elapsedMs=\d+$/
      ),
      "OpenClaw config validate start",
      "OpenClaw config validate finish",
      expect.stringMatching(
        /^OpenClaw setup phase finish phase=config_validate engine=openclaw elapsedMs=\d+$/
      )
    ]);
  });

  test("removes quickstart BOOTSTRAP.md after onboarding", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "burble-openclaw-workspace-"));
    const runtimeConfig = await configWithState({ openClawWorkspaceDir: workspaceDir });
    const logs: string[] = [];

    await ensureOpenClawSetup(
      runtimeConfig,
      async (_command, args) => {
        if (args[0] === "onboard") {
          await writeFile(
            join(workspaceDir, "BOOTSTRAP.md"),
            "Who am I? Who are you?\n"
          );
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      (message) => logs.push(message)
    );

    await expect(readFile(join(workspaceDir, "BOOTSTRAP.md"), "utf8")).rejects.toThrow(
      "ENOENT"
    );
    expect(logs).toContain(
      `OpenClaw bootstrap file removed path=${join(workspaceDir, "BOOTSTRAP.md")}`
    );
  });

  test("removes persisted BOOTSTRAP.md even when setup cache is valid", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "burble-openclaw-state-"));
    const workspaceDir = await mkdtemp(join(tmpdir(), "burble-openclaw-workspace-"));
    const calls: string[][] = [];
    const logs: string[] = [];
    const runtimeConfig = {
      ...config,
      openClawStateDir: stateDir,
      openClawWorkspaceDir: workspaceDir
    };

    await ensureOpenClawSetup(
      runtimeConfig,
      async (_command, args) => {
        calls.push(args);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      (message) => logs.push(message)
    );
    await writeFile(join(workspaceDir, "BOOTSTRAP.md"), "stale bootstrap\n");

    await ensureOpenClawSetup(
      runtimeConfig,
      async (_command, args) => {
        calls.push(args);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      (message) => logs.push(message)
    );

    expect(calls).toHaveLength(3);
    await expect(readFile(join(workspaceDir, "BOOTSTRAP.md"), "utf8")).rejects.toThrow(
      "ENOENT"
    );
    expect(logs).toContain("OpenClaw setup cached");
    expect(logs).toContain(
      `OpenClaw bootstrap file removed path=${join(workspaceDir, "BOOTSTRAP.md")}`
    );
  });

  test("logs and continues when bootstrap cleanup is not possible", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "burble-openclaw-workspace-"));
    const runtimeConfig = await configWithState({
      openClawSetupOnStart: false,
      openClawValidateOnStart: false,
      openClawWorkspaceDir: workspaceDir
    });
    const bootstrapPath = join(workspaceDir, "BOOTSTRAP.md");
    await mkdir(bootstrapPath);
    const calls: string[][] = [];
    const logs: string[] = [];

    await ensureOpenClawSetup(
      runtimeConfig,
      async (_command, args) => {
        calls.push(args);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      (message) => logs.push(message)
    );

    expect(calls).toEqual([["config", "patch", "--file", llmPatchPath(runtimeConfig)]]);
    expect(logs.some((line) => line.includes("OpenClaw bootstrap file removal skipped"))).toBe(
      true
    );
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

  test("writes a schema-compatible configured OpenClaw agent entry", async () => {
    const calls: string[][] = [];
    const runtimeConfig = await configWithState({
      openClawSetupOnStart: false,
      openClawValidateOnStart: false,
      openClawAgent: "burble"
    });

    await ensureOpenClawSetup(
      runtimeConfig,
      async (_command, args) => {
        calls.push(args);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    );

    expect(calls).toEqual([["config", "patch", "--file", llmPatchPath(runtimeConfig)]]);
    const generatedPatch = JSON.parse(
      await readFile(llmPatchPath(runtimeConfig), "utf8")
    );
    expect(generatedPatch.agents.list).toContainEqual(
      expect.objectContaining({
        id: "burble",
        default: true,
        systemPromptOverride: generatedPatch.agents.defaults.systemPromptOverride,
        identity: {
          name: "Burble",
          theme: "Slack assistant",
          emoji: ":robot_face:"
        }
      })
    );
    expect(JSON.stringify(generatedPatch.agents.list)).not.toContain("nature");
    expect(JSON.stringify(generatedPatch.agents.list)).not.toContain("vibe");
  });

  test("writes a schema-compatible generated LLM patch", async () => {
    const runtimeConfig = await configWithState({
      openClawSetupOnStart: false,
      openClawValidateOnStart: false,
      openClawAgent: "burble",
      openClawFastMode: true
    });

    await ensureOpenClawSetup(runtimeConfig, async () => ({
      exitCode: 0,
      stdout: "",
      stderr: ""
    }));

    const generatedPatch = JSON.parse(
      await readFile(llmPatchPath(runtimeConfig), "utf8")
    );

    expect(generatedPatch.agents.defaults).toMatchObject({
      skipBootstrap: true,
      contextInjection: "never",
      skills: [],
      systemPromptOverride: expect.stringContaining("Burble's OpenClaw runtime")
    });
    expect(generatedPatch.agents.list).toEqual([
      {
        id: "burble",
        default: true,
        systemPromptOverride: generatedPatch.agents.defaults.systemPromptOverride,
        identity: {
          name: "Burble",
          theme: "Slack assistant",
          emoji: ":robot_face:"
        }
      }
    ]);
    expect(JSON.stringify(generatedPatch.agents.list)).not.toContain("nature");
    expect(JSON.stringify(generatedPatch.agents.list)).not.toContain("vibe");
    expect(generatedPatch.memory.qmd.update.startup).toBe("off");
  });

  test("includes sanitized CLI details when config patch fails", async () => {
    const runtimeConfig = await configWithState({
      openClawSetupOnStart: false,
      openClawValidateOnStart: false
    });

    await expect(
      ensureOpenClawSetup(runtimeConfig, async () => ({
        exitCode: 1,
        stdout: "",
        stderr:
          "Error: Config validation failed: agents.list.0.identity: Invalid input Bearer runtime-secret sk-openai-secret"
      }))
    ).rejects.toThrow(
      "OpenClaw config patch exited with code 1: Error: Config validation failed: agents.list.0.identity: Invalid input Bearer *** sk-***"
    );
  });

  test("skips repeated setup when persisted state is already initialized", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "burble-openclaw-state-"));
    const calls: string[][] = [];
    const logs: string[] = [];
    const runtimeConfig = {
      ...config,
      openClawStateDir: stateDir
    };

    await ensureOpenClawSetup(
      runtimeConfig,
      async (_command, args) => {
        calls.push(args);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      (message) => logs.push(message)
    );
    await ensureOpenClawSetup(
      runtimeConfig,
      async (_command, args) => {
        calls.push(args);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      (message) => logs.push(message)
    );

    expect(calls).toHaveLength(3);
    expect(calls[0][0]).toBe("onboard");
    expect(calls[1]).toEqual(["config", "patch", "--file", llmPatchPath(runtimeConfig)]);
    expect(calls[2]).toEqual(["config", "validate"]);
    expect(logs).toContain("OpenClaw setup cached");
    expect(logs).toContainEqual(
      expect.stringMatching(
        /^OpenClaw setup cache hit engine=openclaw elapsedMs=\d+$/
      )
    );
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

  test("reruns setup when the generated LLM patch changes", async () => {
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
    await ensureOpenClawSetup(
      { ...runtimeConfig, llmModel: "openai:gpt-5.5" },
      async (_command, args) => {
        calls.push(args);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    );

    expect(calls.filter((args) => args[0] === "onboard")).toHaveLength(2);
    expect(calls.filter((args) => args[0] === "config")).toHaveLength(4);
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
          exitCode: ++callCount < 2 ? 0 : 1,
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

async function configWithConfigFile(
  overrides: Partial<RuntimeConfig> = {}
): Promise<RuntimeConfig> {
  const root = await mkdtemp(join(tmpdir(), "burble-openclaw-runtime-"));
  return {
    ...(await configWithState()),
    openClawConfigPath: join(root, "config", "runtime.json"),
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
