import type { RuntimeConfig } from "./config";
import { runBurbleRequest } from "./runner";
import type { RunRequest, RunResponse, ToolExecutor } from "./types";

export type CliCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type CliCommandRunner = (
  command: string,
  args: string[],
  options: { timeoutMs: number; env?: Record<string, string> }
) => Promise<CliCommandResult>;

export async function runOpenClawCliRequest(
  request: RunRequest,
  config: RuntimeConfig,
  executeTool: ToolExecutor,
  runCommand: CliCommandRunner = runCliCommand
): Promise<RunResponse> {
  const baseline = await runBurbleRequest(request, config, executeTool);
  if (!request.input.connections.github.connected) {
    return baseline;
  }

  const prompt = buildOpenClawPrompt(request, baseline);
  const result = await runCommand(
    config.openClawCommand,
    [
      "agent",
      "--agent",
      config.openClawAgent,
      "--local",
      "--message",
      prompt,
      "--session-id",
      buildSessionId(request)
    ],
    {
      timeoutMs: config.openClawTimeoutMs,
      env: openClawEnv(config)
    }
  );

  if (result.exitCode !== 0) {
    throw new Error(`OpenClaw CLI exited with code ${result.exitCode}`);
  }

  return {
    response: {
      classification: baseline.response.classification,
      text: extractOpenClawText(result.stdout) || baseline.response.text
    }
  };
}

export async function runCliCommand(
  command: string,
  args: string[],
  options: { timeoutMs: number; env?: Record<string, string> }
): Promise<CliCommandResult> {
  const proc = Bun.spawn([command, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...Bun.env,
      ...options.env
    }
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, options.timeoutMs);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited
    ]);

    if (timedOut) {
      throw new Error("OpenClaw CLI timed out");
    }

    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

export function openClawEnv(config: RuntimeConfig): Record<string, string> {
  return {
    OPENCLAW_STATE_DIR: config.openClawStateDir,
    OPENCLAW_CONFIG_PATH: config.openClawConfigPath
  };
}

function buildOpenClawPrompt(request: RunRequest, baseline: RunResponse): string {
  return [
    "You are Burble's OpenClaw runtime.",
    "Answer in concise Slack mrkdwn.",
    "Use only the provided Burble tool context. Do not invent GitHub data.",
    "Never mention tokens, credentials, or internal URLs.",
    "",
    `User request: ${request.input.text}`,
    "",
    "Burble tool context:",
    baseline.response.text,
    "",
    "Return only the final Slack-ready answer."
  ].join("\n");
}

function buildSessionId(request: RunRequest): string {
  const email = request.input.connections.github.email ?? "anonymous";
  return `burble-${email.replace(/[^a-zA-Z0-9_.-]/g, "_")}`;
}

function extractOpenClawText(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = parseJsonObject(trimmed);
  if (!parsed) {
    return trimmed;
  }

  const text = readNestedText(parsed, ["response", "text"]) ??
    readNestedText(parsed, ["text"]) ??
    readNestedText(parsed, ["message"]);

  return text?.trim() || null;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readNestedText(
  value: Record<string, unknown>,
  path: string[]
): string | null {
  let current: unknown = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null || !(key in current)) {
      return null;
    }

    current = (current as Record<string, unknown>)[key];
  }

  return typeof current === "string" ? current : null;
}
