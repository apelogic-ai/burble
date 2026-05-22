import type { RuntimeConfig } from "./config";
import { info, type RuntimeLogger } from "./logger";
import { isSupportedGitHubRequest, runBurbleRequest } from "./runner";
import type { RunEvent, RunRequest, RunResponse, ToolExecutor } from "./types";

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

export type CliCommandStreamEvent =
  | { type: "stdout"; text: string }
  | { type: "exit"; exitCode: number };

export type CliCommandStreamer = (
  command: string,
  args: string[],
  options: { timeoutMs: number; env?: Record<string, string> }
) => AsyncIterable<CliCommandStreamEvent>;

const streamHeartbeatMs = 8_000;

export async function runOpenClawCliRequest(
  request: RunRequest,
  config: RuntimeConfig,
  executeTool: ToolExecutor,
  runCommand: CliCommandRunner = runCliCommand,
  logInfo: RuntimeLogger = info
): Promise<RunResponse> {
  const baseline = await runBurbleRequest(request, config, executeTool);
  if (!request.input.connections.github.connected) {
    logInfo("OpenClaw agent skipped githubConnected=false");
    return baseline;
  }

  if (!isSupportedGitHubRequest(request.input.text)) {
    logInfo("OpenClaw agent skipped supportedIntent=false");
    return baseline;
  }

  const prompt = buildOpenClawPrompt(request, baseline);
  logInfo(
    `OpenClaw agent start runId=${request.runId ?? "unknown"} agent=${config.openClawAgent} textLength=${request.input.text.length} classification=${baseline.response.classification}`
  );
  const result = await runCommand(
    config.openClawCommand,
    buildOpenClawArgs(config, prompt, request),
    {
      timeoutMs: config.openClawTimeoutMs,
      env: openClawEnv(config)
    }
  );

  if (result.exitCode !== 0) {
    throw new Error(`OpenClaw CLI exited with code ${result.exitCode}`);
  }

  const text = extractOpenClawText(result.stdout) || baseline.response.text;
  logInfo(
    `OpenClaw agent finish runId=${request.runId ?? "unknown"} classification=${baseline.response.classification} textLength=${text.length}`
  );

  return {
    response: {
      classification: baseline.response.classification,
      text
    }
  };
}

export async function* runOpenClawCliRequestStream(
  request: RunRequest,
  config: RuntimeConfig,
  executeTool: ToolExecutor,
  runCommandStream: CliCommandStreamer = runCliCommandStream,
  logInfo: RuntimeLogger = info,
  heartbeatMs = streamHeartbeatMs
): AsyncIterable<RunEvent> {
  yield { type: "status", text: "Loading Burble GitHub context..." };
  const baseline = await runBurbleRequest(request, config, executeTool);
  if (!request.input.connections.github.connected) {
    logInfo("OpenClaw agent skipped githubConnected=false");
    yield { type: "final", response: baseline.response };
    return;
  }

  if (!isSupportedGitHubRequest(request.input.text)) {
    logInfo("OpenClaw agent skipped supportedIntent=false");
    yield { type: "final", response: baseline.response };
    return;
  }

  const prompt = buildOpenClawPrompt(request, baseline);
  logInfo(
    `OpenClaw agent start runId=${request.runId ?? "unknown"} agent=${config.openClawAgent} textLength=${request.input.text.length} classification=${baseline.response.classification}`
  );
  yield { type: "status", text: "Running OpenClaw/NemoClaw..." };

  let stdout = "";
  let exitCode: number | null = null;
  let chunkCount = 0;
  let deltaCount = 0;
  const startedAt = Date.now();
  for await (const event of withHeartbeat(
    runCommandStream(
      config.openClawCommand,
      buildOpenClawArgs(config, prompt, request),
      {
        timeoutMs: config.openClawTimeoutMs,
        env: openClawEnv(config)
      }
    ),
    heartbeatMs
  )) {
    if (event.type === "heartbeat") {
      yield {
        type: "status",
        text: `Still running OpenClaw... ${Math.round(
          (Date.now() - startedAt) / 1000
        )}s`
      };
      logStreamDebug(config, logInfo, "heartbeat", {
        runId: request.runId ?? "unknown",
        elapsedMs: Date.now() - startedAt
      });
      continue;
    }

    if (event.type === "stdout") {
      chunkCount += 1;
      stdout += event.text;
      logStreamDebug(config, logInfo, "stdout chunk", {
        runId: request.runId ?? "unknown",
        elapsedMs: Date.now() - startedAt,
        chunkCount,
        bytes: new TextEncoder().encode(event.text).length,
        chars: event.text.length,
        preview: event.text
      });
      const delta = extractOpenClawStreamDelta(event.text);
      if (delta) {
        deltaCount += 1;
        logStreamDebug(config, logInfo, "delta parsed", {
          runId: request.runId ?? "unknown",
          elapsedMs: Date.now() - startedAt,
          deltaCount,
          chars: delta.length,
          preview: delta
        });
        yield { type: "message_delta", text: delta };
      }
      continue;
    }

    exitCode = event.exitCode;
  }
  logStreamDebug(config, logInfo, "stdout complete", {
    runId: request.runId ?? "unknown",
    elapsedMs: Date.now() - startedAt,
    chunkCount,
    deltaCount,
    stdoutChars: stdout.length,
    exitCode: exitCode ?? "unknown"
  });

  if (exitCode !== 0) {
    const partialText = extractOpenClawText(stdout);
    if (partialText) {
      logInfo(
        `OpenClaw agent partial finish runId=${request.runId ?? "unknown"} exitCode=${exitCode ?? "unknown"} classification=${baseline.response.classification} textLength=${partialText.length}`
      );
      yield {
        type: "final",
        response: {
          classification: baseline.response.classification,
          text: partialText
        }
      };
      return;
    }

    throw new Error(`OpenClaw CLI exited with code ${exitCode ?? "unknown"}`);
  }

  const text = extractOpenClawText(stdout) || baseline.response.text;
  logInfo(
    `OpenClaw agent finish runId=${request.runId ?? "unknown"} classification=${baseline.response.classification} textLength=${text.length}`
  );

  yield {
    type: "final",
    response: {
      classification: baseline.response.classification,
      text
    }
  };
}

async function* withHeartbeat(
  events: AsyncIterable<CliCommandStreamEvent>,
  intervalMs: number
): AsyncIterable<CliCommandStreamEvent | { type: "heartbeat" }> {
  const iterator = events[Symbol.asyncIterator]();
  let next = iterator.next();

  try {
    while (true) {
      const result = await Promise.race([
        next.then((value) => ({ type: "event" as const, value })),
        sleep(intervalMs).then(() => ({ type: "heartbeat" as const }))
      ]);

      if (result.type === "heartbeat") {
        yield { type: "heartbeat" };
        continue;
      }

      if (result.value.done) {
        return;
      }

      yield result.value.value;
      next = iterator.next();
    }
  } finally {
    await iterator.return?.();
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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

export async function* runCliCommandStream(
  command: string,
  args: string[],
  options: { timeoutMs: number; env?: Record<string, string> }
): AsyncIterable<CliCommandStreamEvent> {
  const proc = Bun.spawn([command, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...Bun.env,
      ...options.env
    }
  });
  const stderr = new Response(proc.stderr).text();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, options.timeoutMs);

  try {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }

      yield {
        type: "stdout",
        text: decoder.decode(result.value, { stream: true })
      };
    }

    const remaining = decoder.decode();
    if (remaining) {
      yield { type: "stdout", text: remaining };
    }

    const exitCode = await proc.exited;
    await stderr;
    if (timedOut) {
      throw new Error("OpenClaw CLI timed out");
    }

    yield { type: "exit", exitCode };
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

function buildOpenClawArgs(
  config: RuntimeConfig,
  prompt: string,
  request: RunRequest
): string[] {
  return [
    "agent",
    "--agent",
    config.openClawAgent,
    "--local",
    "--message",
    prompt,
    "--session-id",
    buildSessionId(request)
  ];
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

  const lineText = readLastJsonResponseText(trimmed);
  if (lineText) {
    return lineText;
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

function readLastJsonResponseText(value: string): string | null {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse();

  for (const line of lines) {
    const parsed = parseJsonObject(line);
    if (!parsed) {
      continue;
    }

    const text =
      readNestedText(parsed, ["response", "text"]) ??
      readNestedText(parsed, ["text"]) ??
      readNestedText(parsed, ["message"]);
    if (text?.trim()) {
      return text.trim();
    }
  }

  return null;
}

function extractOpenClawStreamDelta(chunk: string): string | null {
  const lines = chunk
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const deltas = lines
    .map(readStreamLineText)
    .filter((value): value is string => Boolean(value));

  return deltas.length > 0 ? deltas.join("\n") : null;
}

function readStreamLineText(line: string): string | null {
  const parsed = parseJsonObject(line);
  if (parsed) {
    return (
      readNestedText(parsed, ["delta"]) ??
      readNestedText(parsed, ["message_delta", "text"]) ??
      readNestedText(parsed, ["event", "text"]) ??
      null
    );
  }

  if (line.startsWith("{") || line.startsWith("[")) {
    return null;
  }

  return line;
}

function logStreamDebug(
  config: RuntimeConfig,
  logInfo: RuntimeLogger,
  event: string,
  fields: Record<string, string | number>
): void {
  if (!config.openClawStreamDebug) {
    return;
  }

  logInfo(
    [
      `OpenClaw stream debug event=${event}`,
      ...Object.entries(fields).map(([key, value]) =>
        key === "preview"
          ? `${key}="${redactPreview(String(value))}"`
          : `${key}=${value}`
      )
    ].join(" ")
  );
}

function redactPreview(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[redacted-openai-key]")
    .replace(/xox[baprs]-[A-Za-z0-9-]+/g, "[redacted-slack-token]")
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, "[redacted-github-token]")
    .replace(/burble_rt_[a-f0-9]+/g, "[redacted-runtime-token]")
    .replace(/\s+/g, " ")
    .slice(0, 180);
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
