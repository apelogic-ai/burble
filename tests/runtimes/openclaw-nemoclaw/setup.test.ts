import { describe, expect, test } from "bun:test";
import { ensureOpenClawSetup } from "../../../runtimes/openclaw-nemoclaw/src/setup";
import type { RuntimeConfig } from "../../../runtimes/openclaw-nemoclaw/src/config";

const config: RuntimeConfig = {
  port: 8080,
  toolGatewayUrl: "http://burble-app:3000/internal/tools",
  internalToken: "secret",
  engine: "openclaw-cli",
  openClawCommand: "openclaw",
  openClawAgent: "main",
  openClawTimeoutMs: 60000,
  openClawStateDir: "/data/openclaw/state",
  openClawConfigPath: "/data/openclaw/config/openclaw.json",
  openClawWorkspaceDir: "/data/openclaw/workspace",
  openClawSetupOnStart: true,
  openClawConfigPatchPath: null,
  openClawValidateOnStart: true
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

    await ensureOpenClawSetup(
      { ...config, openClawSetupOnStart: false },
      async (_command, args) => {
        calls.push(args);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    );

    expect(calls).toEqual([["config", "validate"]]);
  });

  test("runs non-interactive setup with persistent state paths", async () => {
    const calls: Array<{
      command: string;
      args: string[];
      env: Record<string, string>;
    }> = [];

    await ensureOpenClawSetup(config, async (command, args, options) => {
      calls.push({ command, args, env: options.env ?? {} });
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    expect(calls).toEqual([
      {
        command: "openclaw",
        args: [
          "setup",
          "--non-interactive",
          "--workspace",
          "/data/openclaw/workspace"
        ],
        env: {
          OPENCLAW_STATE_DIR: "/data/openclaw/state",
          OPENCLAW_CONFIG_PATH: "/data/openclaw/config/openclaw.json"
        }
      },
      {
        command: "openclaw",
        args: ["config", "validate"],
        env: {
          OPENCLAW_STATE_DIR: "/data/openclaw/state",
          OPENCLAW_CONFIG_PATH: "/data/openclaw/config/openclaw.json"
        }
      }
    ]);
  });

  test("applies an optional config patch before validation", async () => {
    const calls: string[][] = [];

    await ensureOpenClawSetup(
      { ...config, openClawConfigPatchPath: "/etc/openclaw/patch.json5" },
      async (_command, args) => {
        calls.push(args);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    );

    expect(calls).toEqual([
      ["setup", "--non-interactive", "--workspace", "/data/openclaw/workspace"],
      ["config", "patch", "--file", "/etc/openclaw/patch.json5"],
      ["config", "validate"]
    ]);
  });

  test("can disable startup validation", async () => {
    const calls: string[][] = [];

    await ensureOpenClawSetup(
      { ...config, openClawValidateOnStart: false },
      async (_command, args) => {
        calls.push(args);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    );

    expect(calls).toEqual([
      ["setup", "--non-interactive", "--workspace", "/data/openclaw/workspace"]
    ]);
  });

  test("surfaces setup failures without leaking stderr", async () => {
    await expect(
      ensureOpenClawSetup(config, async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "secret leaked"
      }))
    ).rejects.toThrow("OpenClaw setup exited with code 1");
  });

  test("surfaces config patch failures without leaking stderr", async () => {
    await expect(
      ensureOpenClawSetup(
        {
          ...config,
          openClawSetupOnStart: false,
          openClawConfigPatchPath: "/patch.json5"
        },
        async () => ({
          exitCode: 1,
          stdout: "",
          stderr: "secret leaked"
        })
      )
    ).rejects.toThrow("OpenClaw config patch exited with code 1");
  });

  test("surfaces validation failures without leaking stderr", async () => {
    await expect(
      ensureOpenClawSetup(
        { ...config, openClawSetupOnStart: false },
        async () => ({
          exitCode: 1,
          stdout: "",
          stderr: "secret leaked"
        })
      )
    ).rejects.toThrow("OpenClaw config validate exited with code 1");
  });
});
