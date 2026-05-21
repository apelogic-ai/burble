import type { RuntimeConfig } from "./config";
import { info, type RuntimeLogger } from "./logger";
import { openClawEnv, runCliCommand, type CliCommandRunner } from "./openclaw-cli";

export async function ensureOpenClawSetup(
  config: RuntimeConfig,
  runCommand: CliCommandRunner = runCliCommand,
  logInfo: RuntimeLogger = info
): Promise<void> {
  if (config.engine !== "openclaw" || !config.openClawSetupOnStart) {
    if (config.engine === "openclaw") {
      logInfo("OpenClaw onboard skipped setupOnStart=false");
    }
    await ensureOpenClawConfig(config, runCommand, logInfo);
    return;
  }

  logInfo(
    `OpenClaw onboard start workspace=${config.openClawWorkspaceDir} hasPatch=${Boolean(config.openClawConfigPatchPath)}`
  );
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
  logInfo("OpenClaw onboard finish");

  await ensureOpenClawConfig(config, runCommand, logInfo);
}

async function ensureOpenClawConfig(
  config: RuntimeConfig,
  runCommand: CliCommandRunner,
  logInfo: RuntimeLogger
): Promise<void> {
  if (config.engine !== "openclaw") {
    return;
  }

  if (config.openClawConfigPatchPath) {
    logInfo(`OpenClaw config patch start path=${config.openClawConfigPatchPath}`);
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
    logInfo("OpenClaw config patch finish");
  }

  if (!config.openClawValidateOnStart) {
    logInfo("OpenClaw config validate skipped validateOnStart=false");
    return;
  }

  logInfo("OpenClaw config validate start");
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
  logInfo("OpenClaw config validate finish");
}
