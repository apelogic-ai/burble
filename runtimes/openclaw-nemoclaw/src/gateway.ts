import type { RuntimeConfig } from "./config";
import { info, type RuntimeLogger } from "./logger";
import { openClawEnv } from "./openclaw-cli";

export type GatewayProcess = {
  pid?: number;
  exited: Promise<number>;
  kill: (signal?: NodeJS.Signals | number) => void;
  stdout?: ReadableStream<Uint8Array> | null;
  stderr?: ReadableStream<Uint8Array> | null;
};

export type GatewaySpawner = (
  command: string,
  args: string[],
  options: { env: Record<string, string> }
) => GatewayProcess;

export type GatewayHandle = {
  stop: () => void;
  exited: Promise<number>;
};

export function startOpenClawGatewayIfNeeded(
  config: RuntimeConfig,
  spawnGateway: GatewaySpawner = spawnOpenClawGateway,
  logInfo: RuntimeLogger = info
): GatewayHandle | null {
  if (config.engine !== "openclaw-gateway") {
    return null;
  }

  const args = [
    "gateway",
    "run",
    "--bind",
    config.openClawGatewayBind,
    "--port",
    String(config.openClawGatewayPort),
    "--auth",
    "token",
    "--token",
    config.openClawGatewayToken,
    "--allow-unconfigured",
    "--compact"
  ];
  const env = openClawEnv(config);
  const startedAt = Date.now();
  logInfo(
    `OpenClaw gateway start command=${config.openClawCommand} port=${config.openClawGatewayPort} bind=${config.openClawGatewayBind} auth=token`
  );
  const process = spawnGateway(config.openClawCommand, args, { env });
  drainGatewayStream(process.stdout, "stdout", logInfo);
  drainGatewayStream(process.stderr, "stderr", logInfo);

  const exited = process.exited.then((exitCode) => {
    logInfo(
      `OpenClaw gateway exit pid=${process.pid ?? "unknown"} exitCode=${exitCode} uptimeMs=${Date.now() - startedAt}`
    );
    return exitCode;
  });

  return {
    stop() {
      logInfo(`OpenClaw gateway stop pid=${process.pid ?? "unknown"}`);
      process.kill("SIGTERM");
    },
    exited
  };
}

function spawnOpenClawGateway(
  command: string,
  args: string[],
  options: { env: Record<string, string> }
): GatewayProcess {
  return Bun.spawn([command, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...Bun.env,
      ...options.env
    }
  });
}

function drainGatewayStream(
  stream: ReadableStream<Uint8Array> | null | undefined,
  label: "stdout" | "stderr",
  logInfo: RuntimeLogger
): void {
  if (!stream) {
    return;
  }

  void (async () => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          const trailing = decoder.decode();
          if (trailing) {
            logGatewayChunk(label, trailing, logInfo);
          }
          return;
        }
        logGatewayChunk(label, decoder.decode(chunk.value, { stream: true }), logInfo);
      }
    } catch (error) {
      logInfo(
        `OpenClaw gateway ${label} read error=${error instanceof Error ? error.message : String(error)}`
      );
    }
  })();
}

function logGatewayChunk(
  label: "stdout" | "stderr",
  text: string,
  logInfo: RuntimeLogger
): void {
  const preview = text.replace(/\s+/g, " ").trim().slice(0, 300);
  if (preview) {
    logInfo(`OpenClaw gateway ${label} ${preview}`);
  }
}
