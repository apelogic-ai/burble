import type { RuntimeConfig } from "./config";
import { openClawEnv, runCliCommand, type CliCommandRunner } from "./openclaw-cli";

export async function ensureOpenClawSetup(
  config: RuntimeConfig,
  runCommand: CliCommandRunner = runCliCommand
): Promise<void> {
  if (config.engine !== "openclaw-cli" || !config.openClawSetupOnStart) {
    return;
  }

  const result = await runCommand(
    config.openClawCommand,
    [
      "setup",
      "--non-interactive",
      "--workspace",
      config.openClawWorkspaceDir
    ],
    {
      timeoutMs: config.openClawTimeoutMs,
      env: openClawEnv(config)
    }
  );

  if (result.exitCode !== 0) {
    throw new Error(`OpenClaw setup exited with code ${result.exitCode}`);
  }
}
