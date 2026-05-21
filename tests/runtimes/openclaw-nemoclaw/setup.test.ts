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
  openClawSetupOnStart: true
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

  test("skips setup when disabled", async () => {
    let called = false;

    await ensureOpenClawSetup(
      { ...config, openClawSetupOnStart: false },
      async () => {
        called = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    );

    expect(called).toBe(false);
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
      }
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
});
