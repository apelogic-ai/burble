import { describe, expect, test } from "bun:test";
import {
  startOpenClawGatewayIfNeeded,
  type GatewayProcess
} from "../../../runtimes/openclaw-nemoclaw/src/gateway";
import type { RuntimeConfig } from "../../../runtimes/openclaw-nemoclaw/src/config";

const config: RuntimeConfig = {
  port: 8080,
  toolGatewayUrl: "http://burble-app:3000/internal/tools",
  internalToken: "secret",
  mcpGatewayUrl: null,
  runtimeJwt: null,
  engine: "openclaw-gateway",
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
  openClawRawStreamDebug: false,
  openClawGatewayPort: 18790,
  openClawGatewayBind: "loopback",
  openClawGatewayToken: "gateway-token",
  llmModel: "openai:gpt-5.4",
  ollamaBaseUrl: "https://ollama.com"
};

describe("startOpenClawGatewayIfNeeded", () => {
  test("does not start a gateway for non-gateway engines", () => {
    let called = false;

    const handle = startOpenClawGatewayIfNeeded(
      { ...config, engine: "openclaw" },
      () => {
        called = true;
        throw new Error("unexpected gateway spawn");
      }
    );

    expect(handle).toBeNull();
    expect(called).toBe(false);
  });

  test("starts a private token-authenticated gateway process", async () => {
    const logs: string[] = [];
    let killedWith: NodeJS.Signals | number | undefined;
    let resolveExit!: (exitCode: number) => void;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const calls: Array<{
      command: string;
      args: string[];
      env: Record<string, string>;
    }> = [];

    const handle = startOpenClawGatewayIfNeeded(
      config,
      (command, args, options): GatewayProcess => {
        calls.push({ command, args, env: options.env });
        return {
          pid: 123,
          exited,
          kill(signal) {
            killedWith = signal;
            resolveExit(0);
          }
        };
      },
      (message) => logs.push(message)
    );

    expect(handle).not.toBeNull();
    expect(await Promise.race([
      handle?.ready.then(() => "ready"),
      Promise.resolve("pending")
    ])).toBe("pending");
    expect(calls).toEqual([
      {
        command: "openclaw",
        args: [
          "gateway",
          "run",
          "--bind",
          "loopback",
          "--port",
          "18790",
          "--auth",
          "token",
          "--token",
          "gateway-token",
          "--allow-unconfigured",
          "--compact"
        ],
        env: {
          OPENCLAW_STATE_DIR: "/data/openclaw/state",
          OPENCLAW_CONFIG_PATH: "/data/openclaw/config/openclaw.json",
          OPENCLAW_GATEWAY_TOKEN: "gateway-token",
          OPENCLAW_GATEWAY_PORT: "18790"
        }
      }
    ]);
    expect(logs[0]).toBe(
      "OpenClaw gateway start command=openclaw port=18790 bind=loopback auth=token"
    );

    handle?.stop();
    expect(killedWith).toBe("SIGTERM");
    expect(await handle?.exited).toBe(0);
    expect(logs).toContain("OpenClaw gateway stop pid=123");
    expect(logs.some((line) => line.includes("OpenClaw gateway exit pid=123"))).toBe(
      true
    );
  });

  test("resolves readiness when gateway stdout reports ready", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            "2026-05-25T18:26:10.756+00:00 [gateway] ready\n"
          )
        );
      }
    });
    const logs: string[] = [];
    const handle = startOpenClawGatewayIfNeeded(
      config,
      (): GatewayProcess => ({
        pid: 123,
        exited: new Promise(() => {}),
        kill() {},
        stdout: stream
      }),
      (message) => logs.push(message)
    );

    await expect(handle?.ready).resolves.toBeUndefined();
    expect(logs).toContain("OpenClaw gateway ready pid=123");
  });
});
