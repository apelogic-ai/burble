import type { RuntimeConfig } from "./config";
import { info } from "./logger";

export type RuntimeHeartbeat = {
  stop(): void;
};

export function startRuntimeHeartbeat(config: RuntimeConfig): RuntimeHeartbeat | null {
  if (!config.runtimeId) {
    return null;
  }

  const intervalMs = config.runtimeHeartbeatIntervalMs ?? 300_000;
  const beat = () => {
    sendRuntimeHeartbeat(config).catch((error) => {
      info(
        `Burble runtime heartbeat failed: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  };

  beat();
  const timer = setInterval(beat, intervalMs);
  if (
    typeof timer === "object" &&
    timer !== null &&
    "unref" in timer &&
    typeof timer.unref === "function"
  ) {
    timer.unref();
  }

  return {
    stop() {
      clearInterval(timer);
    }
  };
}

export async function sendRuntimeHeartbeat(config: RuntimeConfig): Promise<void> {
  if (!config.runtimeId) {
    return;
  }

  const response = await fetch(
    `${config.toolGatewayUrl}/${encodeURIComponent("runtime.heartbeat")}/execute`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.internalToken}`,
        "x-burble-runtime-id": config.runtimeId
      },
      body: "{}"
    }
  );

  if (!response.ok) {
    throw new Error(
      `Burble tool gateway returned HTTP ${response.status}${await readErrorDetail(response)}`
    );
  }
}

async function readErrorDetail(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  return text ? `: ${text.slice(0, 500)}` : "";
}
