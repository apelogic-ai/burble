import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RuntimeConfig } from "./config";
import { buildOpenClawLlmPatch } from "./llm-config";
import { info, type RuntimeLogger } from "./logger";
import { openClawEnv, runCliCommand, type CliCommandRunner } from "./openclaw-cli";

const setupMarkerFile = ".burble-openclaw-setup.json";
const generatedLlmPatchFile = "burble-llm.json";

export async function ensureOpenClawSetup(
  config: RuntimeConfig,
  runCommand: CliCommandRunner = runCliCommand,
  logInfo: RuntimeLogger = info
): Promise<void> {
  if (!isOpenClawBackedEngine(config) || !config.openClawSetupOnStart) {
    if (!isOpenClawBackedEngine(config)) {
      await writeSelectedAgentConfig(config);
    }
    if (isOpenClawBackedEngine(config)) {
      logInfo("OpenClaw onboard skipped setupOnStart=false");
    }
    await ensureOpenClawConfig(config, runCommand, logInfo);
    return;
  }

  const setupCacheKey = await buildSetupCacheKey(config);
  if (await isSetupCacheValid(config, setupCacheKey)) {
    logInfo("OpenClaw setup cached");
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
  await writeSetupCache(config, setupCacheKey);
}

async function ensureOpenClawConfig(
  config: RuntimeConfig,
  runCommand: CliCommandRunner,
  logInfo: RuntimeLogger
): Promise<void> {
  if (!isOpenClawBackedEngine(config)) {
    return;
  }

  if (config.openClawConfigPatchPath) {
    await applyOpenClawConfigPatch(
      config.openClawConfigPatchPath,
      config,
      runCommand,
      logInfo
    );
  }

  const llmPatchPath = await writeGeneratedLlmPatch(config);
  logInfo(
    `OpenClaw LLM config selected model=${config.llmModel} ollamaBaseUrl=${config.ollamaBaseUrl}`
  );
  await applyOpenClawConfigPatch(llmPatchPath, config, runCommand, logInfo);

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

async function writeSelectedAgentConfig(config: RuntimeConfig): Promise<void> {
  await mkdir(dirname(config.openClawConfigPath), { recursive: true });
  const agentConfig = buildOpenClawNemoClawAgentConfig(config);
  await writeFile(
    config.openClawConfigPath,
    `${JSON.stringify(agentConfig, null, 2)}\n`
  );
}

function buildOpenClawNemoClawAgentConfig(
  config: RuntimeConfig
): Record<string, unknown> {
  const agentConfig = JSON.parse(
    buildOpenClawLlmPatch({
      modelId: config.llmModel,
      ollamaBaseUrl: config.ollamaBaseUrl,
      codeModeEnabled: config.openClawCodeMode,
      burbleChannelBaseUrl: buildLocalBurbleChannelBaseUrl(config),
      burbleMcpBaseUrl: buildLocalBurbleMcpBaseUrl(config)
    })
  ) as Record<string, unknown>;
  const agents = readObject(agentConfig.agents);
  const defaults = readObject(agents.defaults);
  defaults.workspace = config.openClawWorkspaceDir;
  agents.defaults = defaults;
  agents.list = [
    {
      id: config.openClawAgent,
      default: true,
      identity: {
        name: "Burble",
        nature: "AI copilot",
        theme: "Slack assistant",
        vibe: "concise and helpful",
        emoji: ":robot_face:"
      }
    }
  ];
  agentConfig.agents = agents;
  agentConfig.messages = {
    visibleReplies: "automatic",
    groupChat: {
      visibleReplies: "message_tool",
      unmentionedInbound: "room_event"
    }
  };

  return agentConfig;
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function applyOpenClawConfigPatch(
  path: string,
  config: RuntimeConfig,
  runCommand: CliCommandRunner,
  logInfo: RuntimeLogger
): Promise<void> {
  logInfo(`OpenClaw config patch start path=${path}`);
  const result = await runCommand(
    config.openClawCommand,
    ["config", "patch", "--file", path],
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

async function writeGeneratedLlmPatch(config: RuntimeConfig): Promise<string> {
  await mkdir(config.openClawStateDir, { recursive: true });
  const path = join(config.openClawStateDir, generatedLlmPatchFile);
  await writeFile(
    path,
    buildOpenClawLlmPatch({
      modelId: config.llmModel,
      ollamaBaseUrl: config.ollamaBaseUrl,
      codeModeEnabled: config.openClawCodeMode,
      burbleChannelBaseUrl: buildLocalBurbleChannelBaseUrl(config),
      burbleMcpBaseUrl: buildLocalBurbleMcpBaseUrl(config)
    })
  );
  return path;
}

function buildLocalBurbleChannelBaseUrl(config: RuntimeConfig): string {
  return `http://127.0.0.1:${config.port}`;
}

function buildLocalBurbleMcpBaseUrl(config: RuntimeConfig): string | null {
  if (!config.mcpGatewayUrl || !config.runtimeJwt) {
    return null;
  }
  return `${buildLocalBurbleChannelBaseUrl(config)}/internal/burble/mcp`;
}

function isOpenClawBackedEngine(config: RuntimeConfig): boolean {
  return config.engine === "openclaw" || config.engine === "openclaw-gateway";
}

async function buildSetupCacheKey(config: RuntimeConfig): Promise<string> {
  const patchHash = config.openClawConfigPatchPath
    ? await hashFile(config.openClawConfigPatchPath)
    : "none";
  const generatedLlmPatchHash = createHash("sha256")
    .update(
      buildOpenClawLlmPatch({
        modelId: config.llmModel,
        ollamaBaseUrl: config.ollamaBaseUrl,
        codeModeEnabled: config.openClawCodeMode,
        burbleChannelBaseUrl: buildLocalBurbleChannelBaseUrl(config),
        burbleMcpBaseUrl: buildLocalBurbleMcpBaseUrl(config)
      })
    )
    .digest("hex");

  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 2,
        engine: config.engine,
        command: config.openClawCommand,
        agent: config.openClawAgent,
        stateDir: config.openClawStateDir,
        configPath: config.openClawConfigPath,
        workspaceDir: config.openClawWorkspaceDir,
        configPatchPath: config.openClawConfigPatchPath,
        patchHash,
        generatedLlmPatchHash,
        validateOnStart: config.openClawValidateOnStart,
        llmModel: config.llmModel,
        ollamaBaseUrl: config.ollamaBaseUrl
      })
    )
    .digest("hex");
}

async function hashFile(path: string): Promise<string> {
  const content = await readFile(path);
  return createHash("sha256").update(content).digest("hex");
}

async function isSetupCacheValid(
  config: RuntimeConfig,
  setupCacheKey: string
): Promise<boolean> {
  try {
    const marker = JSON.parse(
      await readFile(setupMarkerPath(config), "utf8")
    ) as { setupCacheKey?: unknown };
    return marker.setupCacheKey === setupCacheKey;
  } catch {
    return false;
  }
}

async function writeSetupCache(
  config: RuntimeConfig,
  setupCacheKey: string
): Promise<void> {
  await mkdir(config.openClawStateDir, { recursive: true });
  await writeFile(
    setupMarkerPath(config),
    `${JSON.stringify({
      setupCacheKey,
      writtenAt: new Date().toISOString()
    })}\n`
  );
}

function setupMarkerPath(config: RuntimeConfig): string {
  return join(config.openClawStateDir, setupMarkerFile);
}
