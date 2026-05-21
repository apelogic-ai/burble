import type { RuntimeConfig } from "./config";
import { openClawEnv, runCliCommand, type CliCommandRunner } from "./openclaw-cli";

export async function ensureOpenClawSetup(
  config: RuntimeConfig,
  runCommand: CliCommandRunner = runCliCommand
): Promise<void> {
  if (config.engine !== "openclaw-cli" || !config.openClawSetupOnStart) {
    await ensureOpenClawConfig(config, runCommand);
    return;
  }

  const result = await runCommand(
    config.openClawCommand,
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
      config.openClawWorkspaceDir,
      "--json"
    ],
    {
      timeoutMs: config.openClawTimeoutMs,
      env: openClawEnv(config)
    }
  );

  if (result.exitCode !== 0) {
    throw new Error(`OpenClaw onboard exited with code ${result.exitCode}`);
  }

  await ensureOpenClawConfig(config, runCommand);
}

async function ensureOpenClawConfig(
  config: RuntimeConfig,
  runCommand: CliCommandRunner
): Promise<void> {
  if (config.engine !== "openclaw-cli") {
    return;
  }

  if (config.openClawConfigPatchPath) {
    const result = await runCommand(
      config.openClawCommand,
      ["config", "patch", "--file", config.openClawConfigPatchPath],
      {
        timeoutMs: config.openClawTimeoutMs,
        env: openClawEnv(config)
      }
    );

    if (result.exitCode !== 0) {
      throw new Error(`OpenClaw config patch exited with code ${result.exitCode}`);
    }
  }

  if (!config.openClawValidateOnStart) {
    return;
  }

  const result = await runCommand(
    config.openClawCommand,
    ["config", "validate"],
    {
      timeoutMs: config.openClawTimeoutMs,
      env: openClawEnv(config)
    }
  );

  if (result.exitCode !== 0) {
    throw new Error(`OpenClaw config validate exited with code ${result.exitCode}`);
  }
}
