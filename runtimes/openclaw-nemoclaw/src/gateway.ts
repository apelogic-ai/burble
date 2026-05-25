import type { RuntimeConfig } from "./config";
import { recordGatewayDiagnosticText } from "./gateway-diagnostics";
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
  ready: Promise<void>;
};

const gatewayReadyTimeoutMs = 60_000;

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
  const readiness = createGatewayReadiness(process, logInfo);
  drainGatewayStream(process.stdout, "stdout", logInfo, readiness.observe);
  drainGatewayStream(process.stderr, "stderr", logInfo, readiness.observe);

  const exited = process.exited.then((exitCode) => {
    logInfo(
      `OpenClaw gateway exit pid=${process.pid ?? "unknown"} exitCode=${exitCode} uptimeMs=${Date.now() - startedAt}`
    );
    readiness.exit(exitCode);
    return exitCode;
  });

  return {
    stop() {
      logInfo(`OpenClaw gateway stop pid=${process.pid ?? "unknown"}`);
      process.kill("SIGTERM");
    },
    exited,
    ready: readiness.ready
  };
}

function createGatewayReadiness(
  process: GatewayProcess,
  logInfo: RuntimeLogger
): {
  ready: Promise<void>;
  observe: (text: string) => void;
  exit: (exitCode: number) => void;
} {
  let settled = false;
  let buffer = "";
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const timeout = setTimeout(() => {
    if (settled) {
      return;
    }
    settled = true;
    rejectReady(new Error("OpenClaw gateway did not become ready before timeout"));
  }, gatewayReadyTimeoutMs);
  (timeout as { unref?: () => void }).unref?.();

  function markReady(): void {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timeout);
    logInfo(`OpenClaw gateway ready pid=${process.pid ?? "unknown"}`);
    resolveReady();
  }

  return {
    ready,
    observe(text) {
      buffer = `${buffer}${text}`.slice(-4096);
      if (/\[gateway\]\s+ready\b/.test(buffer)) {
        markReady();
      }
    },
    exit(exitCode) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      rejectReady(
        new Error(`OpenClaw gateway exited before readiness exitCode=${exitCode}`)
      );
    }
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
  logInfo: RuntimeLogger,
  onText: (text: string) => void
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
            onText(trailing);
            logGatewayChunk(label, trailing, logInfo);
          }
          return;
        }
        const text = decoder.decode(chunk.value, { stream: true });
        onText(text);
        logGatewayChunk(label, text, logInfo);
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
  recordGatewayDiagnosticText(text);
  const preview = text.replace(/\s+/g, " ").trim().slice(0, 300);
  if (preview) {
    logInfo(`OpenClaw gateway ${label} ${preview}`);
  }
}
