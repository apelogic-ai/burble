import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeConfig } from "./config";
import { readGatewayDiagnosticTextSince } from "./gateway-diagnostics";
import { info, type RuntimeLogger } from "./logger";
import {
  isSupportedGitHubRequest,
  isSupportedJiraRequest,
  runBurbleRequest
} from "./runner";
import type {
  RunEvent,
  RunRequest,
  RunResponse,
  ToolExecutor,
  ToolResult
} from "./types";

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

const preloadedRuntimeSkillNames = ["core", "github", "atlassian-jira"] as const;
const preloadedRuntimeSkills = preloadedRuntimeSkillNames
  .map((name) => loadRuntimeSkill(name))
  .join("\n\n");

export type CliCommandStreamEvent =
  | { type: "stdout"; text: string }
  | { type: "stderr"; text: string }
  | { type: "exit"; exitCode: number };

export type CliCommandStreamer = (
  command: string,
  args: string[],
  options: { timeoutMs: number; env?: Record<string, string> }
) => AsyncIterable<CliCommandStreamEvent>;

const streamHeartbeatMs = 8_000;
const maxPlannedToolCalls = 5;

type ToolCatalogItem = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

type PlannedToolCall = {
  name: string;
  arguments: Record<string, unknown>;
};

type ExecutedToolCall = {
  toolCall: PlannedToolCall;
  toolResult: ToolResult;
};

type BurbleToolContext = {
  baseline: RunResponse;
  catalog: ToolCatalogItem[];
  upstreamMcpSchemas: Record<string, unknown>;
};

export async function runOpenClawCliRequest(
  request: RunRequest,
  config: RuntimeConfig,
  executeTool: ToolExecutor,
  runCommand: CliCommandRunner = runCliCommand,
  logInfo: RuntimeLogger = info
): Promise<RunResponse> {
  const toolContext = await buildBurbleToolContext(
    request,
    config,
    executeTool,
    logInfo
  );
  const baseline = toolContext.baseline;
  if (
    isSupportedGitHubRequest(request.input.text) &&
    !request.input.connections.github.connected
  ) {
    logInfo("OpenClaw agent skipped githubConnected=false");
    return baseline;
  }
  if (
    isSupportedJiraRequest(request.input.text) &&
    !request.input.connections.jira?.connected
  ) {
    logInfo("OpenClaw agent skipped jiraConnected=false");
    return baseline;
  }

  const sessionId = buildRunSessionId(request);
  logInfo(
    `OpenClaw agent start runId=${request.runId ?? "unknown"} agent=${config.openClawAgent} sessionId=${sessionId} sessionScope=run textLength=${request.input.text.length} classification=${baseline.response.classification}`
  );
  const executedTools: ExecutedToolCall[] = [];
  let classification = baseline.response.classification;

  for (let step = 0; step <= maxPlannedToolCalls; step += 1) {
    const prompt = buildOpenClawPrompt(request, toolContext, executedTools);
    logInfo(
      `OpenClaw planning start runId=${request.runId ?? "unknown"} step=${step + 1} executedTools=${executedTools.length} promptChars=${prompt.length}`
    );
    logPromptTokenEstimate(request, prompt, step + 1, logInfo);
    const result = await runOpenClawCommand(
      request,
      config,
      prompt,
      buildStepSessionId(sessionId, step + 1),
      runCommand,
      logInfo,
      step + 1
    );
    const plannedToolCall = normalizePlannedToolCall(
      readPlannedToolCall(result.stdout, toolContext.catalog)
    );

    if (!plannedToolCall) {
      const lastToolResult = executedTools.at(-1)?.toolResult;
      const text =
        extractOpenClawText(result.stdout) ||
        (lastToolResult ? formatToolResult(lastToolResult) : baseline.response.text);
      logInfo(
        `OpenClaw agent finish runId=${request.runId ?? "unknown"} classification=${classification} textLength=${text.length}`
      );

      return {
        response: {
          classification,
          text
        }
      };
    }

    if (executedTools.length >= maxPlannedToolCalls) {
      const text = "I stopped after several provider tool calls. Please narrow the request and try again.";
      logInfo(
        `OpenClaw agent finish runId=${request.runId ?? "unknown"} classification=${classification} textLength=${text.length} maxToolCalls=true`
      );
      return {
        response: {
          classification,
          text
        }
      };
    }

    logInfo(
      `OpenClaw tool requested runId=${request.runId ?? "unknown"} tool=${plannedToolCall.name}${summarizeLogObject("args", plannedToolCall.arguments)}`
    );
    const toolStartedAt = Date.now();
    const toolResult = await executePlannedToolCall(
      plannedToolCall,
      request,
      toolContext,
      executeTool
    );
    logInfo(
      `OpenClaw tool result runId=${request.runId ?? "unknown"} tool=${plannedToolCall.name} classification=${toolResult.classification} elapsedMs=${Date.now() - toolStartedAt}${summarizeToolResultForLog(toolResult)}`
    );
    classification = mergeClassification(classification, toolResult.classification);
    if (isTerminalToolCall(plannedToolCall.name)) {
      const text = formatTerminalToolResult(plannedToolCall.name, toolResult);
      logInfo(
        `OpenClaw agent finish runId=${request.runId ?? "unknown"} classification=${classification} textLength=${text.length} terminalTool=${plannedToolCall.name}`
      );
      return {
        response: {
          classification,
          text
        }
      };
    }
    executedTools.push({ toolCall: plannedToolCall, toolResult });
  }

  return {
    response: {
      classification,
      text: baseline.response.text
    }
  };
}

async function runOpenClawCommand(
  request: RunRequest,
  config: RuntimeConfig,
  prompt: string,
  sessionId: string,
  runCommand: CliCommandRunner,
  logInfo: RuntimeLogger,
  step: number
): Promise<CliCommandResult> {
  const startedAt = Date.now();
  const rawStreamPath = await prepareRawStreamPath(config, request, step);
  const args = buildOpenClawArgs(config, prompt, sessionId, rawStreamPath);
  const env = openClawEnv(config);
  logInfo(
    `OpenClaw command start runId=${request.runId ?? "unknown"} step=${step} command=${config.openClawCommand} agent=${config.openClawAgent} timeoutMs=${config.openClawTimeoutMs}${summarizePromptForLog(prompt)}${summarizeOpenClawArgsForLog(args)}${summarizeLogObject("env", env)}`
  );
  const result = await runCommand(
    config.openClawCommand,
    args,
    {
      timeoutMs: config.openClawTimeoutMs,
      env
    }
  );

  if (result.exitCode !== 0) {
    const rawStream = await readRawStreamForUsage(rawStreamPath, logInfo, request, step);
    const gatewayDiagnostics = readGatewayDiagnosticTextSince(startedAt);
    logOpenClawUsageFromOutput(
      request,
      step,
      prompt,
      result.stdout,
      result.stderr,
      rawStream,
      gatewayDiagnostics,
      logInfo
    );
    logInfo(
      `OpenClaw command error runId=${request.runId ?? "unknown"} step=${step} exitCode=${result.exitCode}${summarizeLogObject("stdoutPreview", result.stdout)}${summarizeLogObject("stderrPreview", result.stderr)}`
    );
    throw new Error(`OpenClaw CLI exited with code ${result.exitCode}`);
  }
  const rawStream = await readRawStreamForUsage(rawStreamPath, logInfo, request, step);
  const gatewayDiagnostics = readGatewayDiagnosticTextSince(startedAt);
  logOpenClawUsageFromOutput(
    request,
    step,
    prompt,
    result.stdout,
    result.stderr,
    rawStream,
    gatewayDiagnostics,
    logInfo
  );
  logInfo(
    `OpenClaw command finish runId=${request.runId ?? "unknown"} step=${step} elapsedMs=${Date.now() - startedAt} stdoutChars=${result.stdout.length} stderrChars=${result.stderr.length}${summarizeLogObject("stderrPreview", result.stderr)}`
  );
  return result;
}

export async function* runOpenClawCliRequestStream(
  request: RunRequest,
  config: RuntimeConfig,
  executeTool: ToolExecutor,
  runCommandStream: CliCommandStreamer = runCliCommandStream,
  logInfo: RuntimeLogger = info,
  heartbeatMs = streamHeartbeatMs
): AsyncIterable<RunEvent> {
  yield { type: "status", text: "Loading Burble context..." };
  const toolContext = await buildBurbleToolContext(
    request,
    config,
    executeTool,
    logInfo
  );
  const baseline = toolContext.baseline;
  if (
    isSupportedGitHubRequest(request.input.text) &&
    !request.input.connections.github.connected
  ) {
    logInfo("OpenClaw agent skipped githubConnected=false");
    yield { type: "final", response: baseline.response };
    return;
  }
  if (
    isSupportedJiraRequest(request.input.text) &&
    !request.input.connections.jira?.connected
  ) {
    logInfo("OpenClaw agent skipped jiraConnected=false");
    yield { type: "final", response: baseline.response };
    return;
  }

  const sessionId = buildRunSessionId(request);
  logInfo(
    `OpenClaw agent start runId=${request.runId ?? "unknown"} agent=${config.openClawAgent} sessionId=${sessionId} sessionScope=run textLength=${request.input.text.length} classification=${baseline.response.classification}`
  );
  yield { type: "status", text: "Running OpenClaw/NemoClaw..." };

  const executedTools: ExecutedToolCall[] = [];
  let classification = baseline.response.classification;

  for (let step = 0; step <= maxPlannedToolCalls; step += 1) {
    const prompt = buildOpenClawPrompt(request, toolContext, executedTools);
    logInfo(
      `OpenClaw planning start runId=${request.runId ?? "unknown"} step=${step + 1} executedTools=${executedTools.length} promptChars=${prompt.length}`
    );
    logPromptTokenEstimate(request, prompt, step + 1, logInfo);
    const result = yield* collectOpenClawStream(
      request,
      config,
      prompt,
      buildStepSessionId(sessionId, step + 1),
      runCommandStream,
      logInfo,
      heartbeatMs,
      true,
      step + 1
    );
    const plannedToolCall = normalizePlannedToolCall(
      readPlannedToolCall(result.stdout, toolContext.catalog)
    );

    if (!plannedToolCall) {
      const lastToolResult = executedTools.at(-1)?.toolResult;
      const text =
        extractOpenClawText(result.stdout) ||
        (lastToolResult ? formatToolResult(lastToolResult) : baseline.response.text);
      logInfo(
        `OpenClaw agent finish runId=${request.runId ?? "unknown"} classification=${classification} textLength=${text.length}`
      );

      yield {
        type: "final",
        response: {
          classification,
          text
        }
      };
      return;
    }

    if (executedTools.length >= maxPlannedToolCalls) {
      const text = "I stopped after several provider tool calls. Please narrow the request and try again.";
      logInfo(
        `OpenClaw agent finish runId=${request.runId ?? "unknown"} classification=${classification} textLength=${text.length} maxToolCalls=true`
      );
      yield {
        type: "final",
        response: {
          classification,
          text
        }
      };
      return;
    }

    logInfo(
      `OpenClaw tool requested runId=${request.runId ?? "unknown"} tool=${plannedToolCall.name}${summarizeLogObject("args", plannedToolCall.arguments)}`
    );
    const callId = crypto.randomUUID();
    yield {
      type: "tool_call",
      toolName: plannedToolCall.name,
      callId
    };
    const toolStartedAt = Date.now();
    const toolResult = await executePlannedToolCall(
      plannedToolCall,
      request,
      toolContext,
      executeTool
    );
    logInfo(
      `OpenClaw tool result runId=${request.runId ?? "unknown"} tool=${plannedToolCall.name} classification=${toolResult.classification} elapsedMs=${Date.now() - toolStartedAt}${summarizeToolResultForLog(toolResult)}`
    );
    yield {
      type: "tool_result",
      toolName: plannedToolCall.name,
      callId,
      classification: toolResult.classification
    };
    classification = mergeClassification(classification, toolResult.classification);
    if (isTerminalToolCall(plannedToolCall.name)) {
      const text = formatTerminalToolResult(plannedToolCall.name, toolResult);
      logInfo(
        `OpenClaw agent finish runId=${request.runId ?? "unknown"} classification=${classification} textLength=${text.length} terminalTool=${plannedToolCall.name}`
      );
      yield {
        type: "final",
        response: {
          classification,
          text
        }
      };
      return;
    }
    executedTools.push({ toolCall: plannedToolCall, toolResult });
  }
}

async function* collectOpenClawStream(
  request: RunRequest,
  config: RuntimeConfig,
  prompt: string,
  sessionId: string,
  runCommandStream: CliCommandStreamer,
  logInfo: RuntimeLogger,
  heartbeatMs: number,
  emitDeltas: boolean,
  step: number
): AsyncGenerator<RunEvent, { stdout: string }, void> {
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  let chunkCount = 0;
  let stderrChunkCount = 0;
  let deltaCount = 0;
  let firstStdoutLogged = false;
  let firstStderrLogged = false;
  const startedAt = Date.now();
  const rawStreamPath = await prepareRawStreamPath(config, request, step);
  const args = buildOpenClawArgs(config, prompt, sessionId, rawStreamPath);
  const env = openClawEnv(config);
  logInfo(
    `OpenClaw command stream start runId=${request.runId ?? "unknown"} command=${config.openClawCommand} agent=${config.openClawAgent} engine=${config.engine} timeoutMs=${config.openClawTimeoutMs}${summarizePromptForLog(prompt)}${summarizeOpenClawArgsForLog(args)}${summarizeLogObject("env", env)}`
  );
  logStreamDebug(config, logInfo, "prompt preview", {
    runId: request.runId ?? "unknown",
    promptHash: hashLogValue(prompt),
    chars: prompt.length,
    preview: prompt
  });

  for await (const event of withHeartbeat(
    runCommandStream(
      config.openClawCommand,
      args,
      {
        timeoutMs: config.openClawTimeoutMs,
        env
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
        elapsedMs: Date.now() - startedAt,
        stdoutChunks: chunkCount,
        stderrChunks: stderrChunkCount,
        stdoutChars: stdout.length,
        stderrChars: stderr.length
      });
      continue;
    }

    if (event.type === "stdout") {
      chunkCount += 1;
      stdout += event.text;
      if (!firstStdoutLogged) {
        firstStdoutLogged = true;
        logInfo(
          `OpenClaw command stream first_stdout runId=${request.runId ?? "unknown"} elapsedMs=${Date.now() - startedAt} bytes=${new TextEncoder().encode(event.text).length} chars=${event.text.length}`
        );
      }
      logStreamDebug(config, logInfo, "stdout chunk", {
        runId: request.runId ?? "unknown",
        elapsedMs: Date.now() - startedAt,
        chunkCount,
        bytes: new TextEncoder().encode(event.text).length,
        chars: event.text.length,
        preview: event.text
      });
      const delta = extractOpenClawStreamDelta(event.text);
      if (delta && emitDeltas) {
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

    if (event.type === "stderr") {
      stderrChunkCount += 1;
      stderr += event.text;
      if (!firstStderrLogged) {
        firstStderrLogged = true;
        logInfo(
          `OpenClaw command stream first_stderr runId=${request.runId ?? "unknown"} elapsedMs=${Date.now() - startedAt} bytes=${new TextEncoder().encode(event.text).length} chars=${event.text.length}`
        );
      }
      logStreamDebug(config, logInfo, "stderr chunk", {
        runId: request.runId ?? "unknown",
        elapsedMs: Date.now() - startedAt,
        chunkCount: stderrChunkCount,
        bytes: new TextEncoder().encode(event.text).length,
        chars: event.text.length,
        preview: event.text
      });
      continue;
    }

    exitCode = event.exitCode;
  }

  logStreamDebug(config, logInfo, "stdout complete", {
    runId: request.runId ?? "unknown",
    elapsedMs: Date.now() - startedAt,
    chunkCount,
    stderrChunkCount,
    deltaCount,
    stdoutChars: stdout.length,
    stderrChars: stderr.length,
    exitCode: exitCode ?? "unknown"
  });
  logInfo(
    `OpenClaw command stream finish runId=${request.runId ?? "unknown"} elapsedMs=${Date.now() - startedAt} exitCode=${exitCode ?? "unknown"} stdoutChunks=${chunkCount} stderrChunks=${stderrChunkCount} deltaCount=${deltaCount} stdoutChars=${stdout.length} stderrChars=${stderr.length}${summarizeLogObject("stderrPreview", stderr)}`
  );
  const rawStream = await readRawStreamForUsage(rawStreamPath, logInfo, request, step);
  const gatewayDiagnostics = readGatewayDiagnosticTextSince(startedAt);
  logOpenClawUsageFromOutput(
    request,
    step,
    prompt,
    stdout,
    stderr,
    rawStream,
    gatewayDiagnostics,
    logInfo
  );

  if (exitCode !== 0) {
    throw new Error(
      `OpenClaw CLI exited with code ${exitCode ?? "unknown"}${stderr ? `: ${truncate(redactPreview(stderr), 300)}` : ""}`
    );
  }

  return { stdout };
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
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, options.timeoutMs);

  try {
    const stdoutReader = proc.stdout.getReader();
    const stderrReader = proc.stderr.getReader();
    const stdoutDecoder = new TextDecoder();
    const stderrDecoder = new TextDecoder();
    let stdoutNext: Promise<DecodedStreamChunk> | null = readDecodedStreamChunk(
      "stdout",
      stdoutReader,
      stdoutDecoder
    );
    let stderrNext: Promise<DecodedStreamChunk> | null = readDecodedStreamChunk(
      "stderr",
      stderrReader,
      stderrDecoder
    );

    while (stdoutNext || stderrNext) {
      const pending = [stdoutNext, stderrNext].filter(
        (item): item is Promise<DecodedStreamChunk> => Boolean(item)
      );
      const result = await Promise.race(pending);
      if (result.text) {
        yield {
          type: result.stream,
          text: result.text
        };
      }

      if (result.done) {
        if (result.stream === "stdout") {
          stdoutNext = null;
        } else {
          stderrNext = null;
        }
      } else if (result.stream === "stdout") {
        stdoutNext = readDecodedStreamChunk("stdout", stdoutReader, stdoutDecoder);
      } else {
        stderrNext = readDecodedStreamChunk("stderr", stderrReader, stderrDecoder);
      }
    }

    const exitCode = await proc.exited;
    if (timedOut) {
      throw new Error("OpenClaw CLI timed out");
    }

    yield { type: "exit", exitCode };
  } finally {
    clearTimeout(timer);
  }
}

type DecodedStreamChunk = {
  stream: "stdout" | "stderr";
  done: boolean;
  text: string;
};

async function readDecodedStreamChunk(
  stream: "stdout" | "stderr",
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder
): Promise<DecodedStreamChunk> {
  const result = await reader.read();
  if (result.done) {
    return {
      stream,
      done: true,
      text: decoder.decode()
    };
  }

  return {
    stream,
    done: false,
    text: decoder.decode(result.value, { stream: true })
  };
}

export function openClawEnv(config: RuntimeConfig): Record<string, string> {
  return compactStringEnv({
    OPENCLAW_STATE_DIR: config.openClawStateDir,
    OPENCLAW_CONFIG_PATH: config.openClawConfigPath,
    OPENCLAW_LOG_LEVEL: config.openClawLogLevel,
    OPENCLAW_DIAGNOSTICS: config.openClawDiagnostics,
    OPENCLAW_DEBUG_MODEL_TRANSPORT: config.openClawDebugModelTransport,
    OPENCLAW_DEBUG_MODEL_PAYLOAD: config.openClawDebugModelPayload,
    OPENCLAW_DEBUG_SSE: config.openClawDebugSse,
    OPENCLAW_DEBUG_CODE_MODE: config.openClawDebugCodeMode,
    OPENCLAW_GATEWAY_TOKEN:
      config.engine === "openclaw-gateway"
        ? config.openClawGatewayToken
        : undefined,
    OPENCLAW_GATEWAY_PORT:
      config.engine === "openclaw-gateway"
        ? String(config.openClawGatewayPort)
        : undefined
  });
}

function compactStringEnv(
  values: Record<string, string | null | undefined>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter(
      (entry): entry is [string, string] => Boolean(entry[1]?.trim())
    )
  );
}

async function buildBurbleToolContext(
  request: RunRequest,
  config: RuntimeConfig,
  executeTool: ToolExecutor,
  logInfo: RuntimeLogger
): Promise<BurbleToolContext> {
  const startedAt = Date.now();
  logInfo(`OpenClaw context start runId=${request.runId ?? "unknown"}`);
  const [baseline, catalogBuild] = await Promise.all([
    runBurbleRequest(request, config, executeTool),
    buildToolCatalog(request, executeTool)
  ]);
  logInfo(
    `OpenClaw context finish runId=${request.runId ?? "unknown"} elapsedMs=${Date.now() - startedAt} catalogTools=${catalogBuild.catalog.length} upstreamSchemas=${Object.keys(catalogBuild.upstreamMcpSchemas).length} baselineClassification=${baseline.response.classification}`
  );

  return {
    baseline,
    catalog: catalogBuild.catalog,
    upstreamMcpSchemas: catalogBuild.upstreamMcpSchemas
  };
}

async function buildToolCatalog(
  request: RunRequest,
  executeTool: ToolExecutor
): Promise<{
  catalog: ToolCatalogItem[];
  upstreamMcpSchemas: Record<string, unknown>;
}> {
  const catalog: ToolCatalogItem[] = [];
  const upstreamMcpSchemas: Record<string, unknown> = {};
  const github = request.input.connections.github;
  if (github.connected && github.email) {
    catalog.push(
      {
        name: "github.getAuthenticatedUser",
        description:
          "Return the GitHub identity connected to the requesting Slack user.",
        inputSchema: {}
      },
      {
        name: "github.listAssignedIssues",
        description: "List GitHub issues assigned to the requesting Slack user.",
        inputSchema: {}
      },
      {
        name: "github.searchIssues",
        description:
          "Search GitHub issues and pull requests visible to the requesting Slack user's connected GitHub account.",
        inputSchema: {
          query: "string GitHub search query, for example: is:issue assignee:@me"
        }
      },
      {
        name: "github.listMyPullRequests",
        description:
          "List open GitHub pull requests authored by the requesting Slack user's connected GitHub account.",
        inputSchema: {}
      }
    );
  }

  const jira = request.input.connections.jira;
  if (jira?.connected && jira.email) {
    catalog.push(
      {
        name: "jira.getAuthenticatedUser",
        description:
          "Return the Jira identity connected to the requesting Slack user.",
        inputSchema: {}
      },
      {
        name: "jira.listAccessibleResources",
        description:
          "List Atlassian resources visible to the requesting Slack user's connected Jira account. Use the resource url as Jira MCP cloudId when Atlassian Rovo MCP tools require cloudId.",
        inputSchema: {}
      },
      {
        name: "jira.listVisibleProjects",
        description:
          "List Jira projects visible to the requesting Slack user's connected Jira account. Use query='DM', action='create', and expandIssueTypes=true to confirm create access and issue types before jira.createIssue.",
        inputSchema: {
          query: "optional string project key or name search, for example: DM",
          action: "optional string permission filter: view, browse, edit, or create",
          expandIssueTypes: "optional boolean; set true when selecting an issue type for jira.createIssue"
        }
      },
      {
        name: "jira.searchUsers",
        description:
          "Search Jira users visible to the requesting Slack user's connected Jira account. Use this to resolve assignee account IDs from names or emails.",
        inputSchema: {
          query: "string Jira user email, display name, or search query"
        }
      },
      {
        name: "jira.createIssue",
        description:
          "Create a Jira issue via Jira REST. Use this first for ordinary Jira ticket creation after confirming project and issue type.",
        inputSchema: {
          projectKey: "string Jira project key",
          issueTypeName: "optional string Jira issue type name",
          issueTypeId: "optional string Jira issue type ID",
          summary: "string issue summary",
          description: "optional string plain text description",
          assigneeAccountId: "optional string Jira account ID"
        }
      },
      {
        name: "jira.editIssue",
        description:
          "Edit Jira issue fields via Jira REST. Resolve assignees with jira.searchUsers before setting assigneeAccountId.",
        inputSchema: {
          issueKey: "string Jira issue key",
          summary: "optional string new issue summary",
          description: "optional string new plain text description",
          assigneeAccountId: "optional string Jira account ID, or null to unassign"
        }
      },
      {
        name: "jira.listAssignedIssues",
        description: "List Jira issues assigned to the requesting Slack user.",
        inputSchema: {}
      },
      {
        name: "jira.searchIssues",
        description:
          "Search Jira issues visible to the requesting Slack user's connected Jira account.",
        inputSchema: {
          jql: "string Jira JQL query, for example: assignee = currentUser() AND statusCategory != Done"
        }
      },
      {
        name: "atlassian.listMcpTools",
        description:
          "List allowed upstream Atlassian MCP tools available through Burble for this user's Jira connection.",
        inputSchema: {}
      }
    );

    if (shouldLoadAtlassianMcpTools(request.input.text)) {
      const upstreamTools = await readAtlassianMcpToolSummaries(
        jira.email,
        executeTool
      );
      Object.assign(upstreamMcpSchemas, upstreamTools.inputSchemas);
      catalog.push({
        name: "atlassian.callMcpTool",
        description: [
          "Call an allowlisted upstream Atlassian MCP tool through Burble for Jira/Atlassian questions that need provider-native tools and do not have a first-class Burble tool.",
          "For ordinary Jira issue create/edit requests, prefer jira.createIssue or jira.editIssue. Use MCP for operations such as transition/comment/worklog or specialized provider-native lookups.",
          upstreamTools.summaries.length > 0
            ? `Known allowed Atlassian MCP tools include: ${upstreamTools.summaries.slice(0, 30).join("; ")}.`
            : "Use this only when you know the upstream allowed tool name."
        ].join(" "),
        inputSchema: {
          name: "string upstream Atlassian MCP tool name",
          arguments: "object JSON arguments for the upstream Atlassian MCP tool"
        }
      });
    }
  }

  return { catalog, upstreamMcpSchemas };
}

function shouldLoadAtlassianMcpTools(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    /\bmcp\b/.test(normalized) ||
    /\batlassian\b/.test(normalized) ||
    /\bconfluence\b/.test(normalized) ||
    /\b(comment|transition|worklog|log work|status change|move ticket|move issue)\b/.test(
      normalized
    )
  );
}

function isTerminalToolCall(toolName: string): boolean {
  return toolName === "jira.createIssue" || toolName === "jira.editIssue";
}

async function readAtlassianMcpToolSummaries(
  email: string,
  executeTool: ToolExecutor
): Promise<{
  summaries: string[];
  inputSchemas: Record<string, unknown>;
}> {
  try {
    const result = await executeTool("atlassian.listMcpTools", {
      user: { email }
    });
    if (!Array.isArray(result.content)) {
      return { summaries: [], inputSchemas: {} };
    }

    const inputSchemas: Record<string, unknown> = {};
    const summaries = result.content.flatMap((item) => {
      if (
        item &&
        typeof item === "object" &&
        "name" in item &&
        typeof item.name === "string"
      ) {
        if ("inputSchema" in item && item.inputSchema !== undefined) {
          inputSchemas[item.name] = item.inputSchema;
        }
        const title =
          "title" in item && typeof item.title === "string"
            ? ` title=${item.title}`
            : "";
        const description =
          "description" in item && typeof item.description === "string"
            ? ` description=${truncate(item.description, 240)}`
            : "";
        const schema =
          "inputSchema" in item && item.inputSchema !== undefined
            ? ` inputSchema=${truncate(
                JSON.stringify(item.inputSchema),
                atlassianMcpToolSchemaPromptLength(item.name)
              )}`
            : "";
        return [`${item.name}${title}${description}${schema}`];
      }
      return [];
    });

    return { summaries, inputSchemas };
  } catch {
    return { summaries: [], inputSchemas: {} };
  }
}

function atlassianMcpToolSchemaPromptLength(toolName: string): number {
  return isAllowedJiraWriteMcpToolName(toolName) ? 3_000 : 900;
}

function isAllowedJiraWriteMcpToolName(toolName: string): boolean {
  return [
    "addcommenttojiraissue",
    "addworklogtojiraissue",
    "createjiraissue",
    "editjiraissue",
    "transitionjiraissue"
  ].includes(toolName.trim().toLowerCase());
}

function loadRuntimeSkill(name: string): string {
  return readFileSync(new URL(`../skills/${name}.md`, import.meta.url), "utf8").trim();
}

function truncate(value: string | undefined, maxLength: number): string {
  if (!value) {
    return "";
  }

  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength - 3)}...`;
}

function buildOpenClawPrompt(
  request: RunRequest,
  toolContext: BurbleToolContext,
  executedTools: ExecutedToolCall[] = []
): string {
  const sections = [
    "Preloaded Burble runtime skills:",
    preloadedRuntimeSkills,
    "",
    "Available Burble tools:",
    formatToolCatalog(toolContext.catalog),
    "",
    `User request: ${request.input.text}`,
    "",
    "Burble baseline context:",
    toolContext.baseline.response.text
  ];

  if (executedTools.length > 0) {
    sections.push(
      "",
      "Burble executed tools:",
      JSON.stringify(
        executedTools.map((executedTool) => ({
          tool_call: executedTool.toolCall,
          result: executedTool.toolResult
        }))
      ),
      "",
      "Return either exactly one more tool_call JSON object if another provider action is required, or the final Slack-ready answer."
    );
  } else {
    sections.push("", "Return either exactly one tool_call JSON object or the final Slack-ready answer.");
  }

  return sections.join("\n");
}

function formatToolCatalog(catalog: ToolCatalogItem[]): string {
  if (catalog.length === 0) {
    return "[]";
  }

  return JSON.stringify(
    catalog.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema
    }))
  );
}

function readPlannedToolCall(
  stdout: string,
  catalog: ToolCatalogItem[]
): PlannedToolCall | null {
  const parsed = readLastJsonObject(stdout);
  const toolCall =
    parsed && typeof parsed.tool_call === "object" && parsed.tool_call !== null
      ? (parsed.tool_call as Record<string, unknown>)
      : null;
  if (!toolCall || typeof toolCall.name !== "string") {
    return null;
  }

  if (!catalog.some((tool) => tool.name === toolCall.name)) {
    return null;
  }

  const args = toolCall.arguments;
  return {
    name: toolCall.name,
    arguments:
      args && typeof args === "object" && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {}
  };
}

function normalizePlannedToolCall(toolCall: PlannedToolCall | null): PlannedToolCall | null {
  if (!toolCall || toolCall.name !== "atlassian.callMcpTool") {
    return toolCall;
  }

  const upstreamArguments =
    toolCall.arguments.arguments &&
    typeof toolCall.arguments.arguments === "object" &&
    !Array.isArray(toolCall.arguments.arguments)
      ? (toolCall.arguments.arguments as Record<string, unknown>)
      : null;
  if (!upstreamArguments || typeof upstreamArguments.cloudId !== "string") {
    return toolCall;
  }

  const normalizedCloudId = normalizeAtlassianCloudId(upstreamArguments.cloudId);
  if (normalizedCloudId === upstreamArguments.cloudId) {
    return toolCall;
  }

  return {
    ...toolCall,
    arguments: {
      ...toolCall.arguments,
      arguments: {
        ...upstreamArguments,
        cloudId: normalizedCloudId
      }
    }
  };
}

function normalizeAtlassianCloudId(value: string): string {
  const trimmed = value.trim();
  return /^[a-z0-9-]+\.atlassian\.net$/i.test(trimmed)
    ? `https://${trimmed}`
    : trimmed;
}

function readLastJsonObject(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }

  const whole = parseJsonObject(trimmed);
  if (whole) {
    return whole;
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse();
  for (const line of lines) {
    const parsed = parseJsonObject(line);
    if (parsed) {
      return parsed;
    }
  }

  return null;
}

async function executePlannedToolCall(
  toolCall: PlannedToolCall,
  request: RunRequest,
  toolContext: BurbleToolContext,
  executeTool: ToolExecutor
): Promise<ToolResult> {
  const email = readToolEmail(toolCall.name, request);
  if (!email) {
    return {
      classification: "user_private",
      content: {
        error: "provider_not_connected",
        message: `No connected provider account is available for \`${toolCall.name}\`.`
      }
    };
  }

  const validationError = validatePlannedToolCall(toolCall, toolContext);
  if (validationError) {
    return validationError;
  }

  return executeTool(toolCall.name, {
    user: { email },
    input: toolCall.arguments
  });
}

function validatePlannedToolCall(
  toolCall: PlannedToolCall,
  toolContext: BurbleToolContext
): ToolResult | null {
  if (toolCall.name !== "atlassian.callMcpTool") {
    return null;
  }

  const upstreamToolName =
    typeof toolCall.arguments.name === "string"
      ? toolCall.arguments.name.trim()
      : "";
  if (!upstreamToolName) {
    return null;
  }

  const schema = toolContext.upstreamMcpSchemas[upstreamToolName];
  const required = readRequiredSchemaFields(schema);
  if (required.length === 0) {
    return null;
  }

  const upstreamArguments =
    toolCall.arguments.arguments &&
    typeof toolCall.arguments.arguments === "object" &&
    !Array.isArray(toolCall.arguments.arguments)
      ? (toolCall.arguments.arguments as Record<string, unknown>)
      : {};
  const missing = required.filter(
    (field) => !hasPresentSchemaValue(upstreamArguments, field)
  );
  if (missing.length === 0) {
    return null;
  }

  return {
    classification: "user_private",
    content: {
      error: "mcp_schema_validation_failed",
      message: `The planned Atlassian MCP call \`${upstreamToolName}\` is missing required arguments: ${missing.join(", ")}. Use available lookup tools to resolve them, or ask one concise clarifying question before calling \`${upstreamToolName}\`.`
    }
  };
}

function readRequiredSchemaFields(schema: unknown): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return [];
  }

  const required = (schema as Record<string, unknown>).required;
  return Array.isArray(required)
    ? required.filter((field): field is string => typeof field === "string")
    : [];
}

function hasPresentSchemaValue(
  value: Record<string, unknown>,
  field: string
): boolean {
  if (!Object.hasOwn(value, field)) {
    return false;
  }

  const fieldValue = value[field];
  return fieldValue !== undefined && fieldValue !== null && fieldValue !== "";
}

function readToolEmail(toolName: string, request: RunRequest): string | null {
  if (toolName.startsWith("github.")) {
    return request.input.connections.github.email ?? null;
  }

  if (toolName.startsWith("jira.") || toolName.startsWith("atlassian.")) {
    return request.input.connections.jira?.email ?? null;
  }

  return null;
}

function formatToolResult(result: ToolResult): string {
  if (typeof result.content === "string") {
    return result.content;
  }

  return JSON.stringify(result.content);
}

function formatTerminalToolResult(toolName: string, result: ToolResult): string {
  const issue = readIssueResult(result.content);
  if (issue) {
    const verb = toolName === "jira.editIssue" ? "Updated" : "Created";
    return `${verb} Jira issue ${issue.key}: ${issue.title}\n${issue.url}`;
  }

  return formatToolResult(result);
}

function readIssueResult(
  value: unknown
): { key: string; title: string; url: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  return typeof record.key === "string" &&
    typeof record.title === "string" &&
    typeof record.url === "string"
    ? { key: record.key, title: record.title, url: record.url }
    : null;
}

function summarizeToolResultForLog(result: ToolResult): string {
  return summarizeLogObject("result", result.content);
}

function logPromptTokenEstimate(
  request: RunRequest,
  prompt: string,
  step: number,
  logInfo: RuntimeLogger
): void {
  logInfo(
    [
      `OpenClaw token estimate runId=${request.runId ?? "unknown"}`,
      `step=${step}`,
      `promptChars=${prompt.length}`,
      `promptApproxTokens=${estimateTokens(prompt)}`
    ].join(" ")
  );
}

function logOpenClawUsageFromOutput(
  request: RunRequest,
  step: number,
  prompt: string,
  stdout: string,
  stderr: string,
  rawStream: string | null,
  gatewayDiagnostics: string,
  logInfo: RuntimeLogger
): void {
  const output = [stdout, stderr, rawStream ?? "", gatewayDiagnostics].join("\n");
  const usage = readModelUsage(output);
  const diagnostics = summarizeModelDiagnostics(output);
  logInfo(
    [
      `OpenClaw usage runId=${request.runId ?? "unknown"}`,
      `step=${step}`,
      `promptApproxTokens=${estimateTokens(prompt)}`,
      `inputTokens=${formatUsageNumber(usage?.inputTokens)}`,
      `outputTokens=${formatUsageNumber(usage?.outputTokens)}`,
      `totalTokens=${formatUsageNumber(usage?.totalTokens)}`,
      `cachedInputTokens=${formatUsageNumber(usage?.cachedInputTokens)}`,
      `reasoningTokens=${formatUsageNumber(usage?.reasoningTokens)}`,
      `source=${usage ? "provider-output" : "estimate-only"}`
    ].join(" ")
  );
  logInfo(
    [
      `OpenClaw model usage diagnostics runId=${request.runId ?? "unknown"}`,
      `step=${step}`,
      `modelStarts=${diagnostics.modelStarts}`,
      `fetchStarts=${diagnostics.fetchStarts}`,
      `streamDone=${diagnostics.streamDone}`,
      `streamDoneElapsedMs=${formatNumberList(diagnostics.streamDoneElapsedMs)}`,
      `streamDoneEvents=${formatNumberList(diagnostics.streamDoneEvents)}`,
      `compactions=${diagnostics.compactions}`,
      `exactUsageFields=${diagnostics.exactUsageFields}`,
      `exactUsageAvailable=${diagnostics.exactUsageFields > 0 ? "true" : "false"}`,
      `rawStreamBytes=${rawStream ? new TextEncoder().encode(rawStream).length : 0}`
    ].join(" ")
  );
}

type ModelUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
};

function readModelUsage(text: string): ModelUsage | null {
  const inputTokens = readNumberFieldTotal(text, [
    "input_tokens",
    "inputTokens",
    "prompt_tokens",
    "promptTokens"
  ]);
  const outputTokens = readNumberFieldTotal(text, [
    "output_tokens",
    "outputTokens",
    "completion_tokens",
    "completionTokens"
  ]);
  const totalTokens =
    readNumberFieldTotal(text, ["total_tokens", "totalTokens"]) ??
    (typeof inputTokens === "number" && typeof outputTokens === "number"
      ? inputTokens + outputTokens
      : undefined);
  const cachedInputTokens = readNumberFieldTotal(text, [
    "cached_tokens",
    "cachedInputTokens",
    "cache_read_input_tokens"
  ]);
  const reasoningTokens = readNumberFieldTotal(text, [
    "reasoning_tokens",
    "reasoningTokens"
  ]);

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined &&
    cachedInputTokens === undefined &&
    reasoningTokens === undefined
  ) {
    return null;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens,
    reasoningTokens
  };
}

type ModelDiagnostics = {
  modelStarts: number;
  fetchStarts: number;
  streamDone: number;
  streamDoneElapsedMs: number[];
  streamDoneEvents: number[];
  compactions: number;
  exactUsageFields: number;
};

function summarizeModelDiagnostics(text: string): ModelDiagnostics {
  const streamDoneLines = text
    .split(/\r?\n/)
    .filter((line) => line.includes("[openai-transport] [responses] stream_done"));

  return {
    modelStarts: countOccurrences(text, "[openai-transport] [responses] start"),
    fetchStarts: countOccurrences(text, "[provider-transport-fetch] [model-fetch] start"),
    streamDone: streamDoneLines.length,
    streamDoneElapsedMs: streamDoneLines
      .map((line) => readFirstNumberField(line, ["elapsedMs"]))
      .filter((value): value is number => typeof value === "number"),
    streamDoneEvents: streamDoneLines
      .map((line) => readFirstNumberField(line, ["events"]))
      .filter((value): value is number => typeof value === "number"),
    compactions: countOccurrences(text, "[compaction-diag] start"),
    exactUsageFields: countUsageFieldOccurrences(text)
  };
}

function readNumberFieldTotal(text: string, fieldNames: string[]): number | undefined {
  const values = readNumberFields(text, fieldNames);
  return values.length ? values.reduce((total, value) => total + value, 0) : undefined;
}

function readFirstNumberField(text: string, fieldNames: string[]): number | undefined {
  return readNumberFields(text, fieldNames)[0];
}

function readNumberFields(text: string, fieldNames: string[]): number[] {
  const values: number[] = [];
  for (const fieldName of fieldNames) {
    const escapedField = fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`["']?${escapedField}["']?\\s*[:=]\\s*(\\d+)`, "gi");
    for (const match of text.matchAll(regex)) {
      const value = Number.parseInt(match[1] ?? "", 10);
      if (Number.isInteger(value)) {
        values.push(value);
      }
    }
  }
  return values;
}

function countUsageFieldOccurrences(text: string): number {
  return readNumberFields(text, [
    "input_tokens",
    "inputTokens",
    "prompt_tokens",
    "promptTokens",
    "output_tokens",
    "outputTokens",
    "completion_tokens",
    "completionTokens",
    "total_tokens",
    "totalTokens",
    "cached_tokens",
    "cachedInputTokens",
    "cache_read_input_tokens",
    "reasoning_tokens",
    "reasoningTokens"
  ]).length;
}

function countOccurrences(text: string, pattern: string): number {
  return text.split(pattern).length - 1;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function formatUsageNumber(value: number | undefined): string {
  return typeof value === "number" ? String(value) : "unknown";
}

function formatNumberList(values: number[]): string {
  return values.length ? values.join(",") : "none";
}

function summarizePromptForLog(prompt: string): string {
  return ` promptChars=${prompt.length} promptHash=${hashLogValue(prompt)}`;
}

function summarizeOpenClawArgsForLog(args: string[]): string {
  const sanitizedArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    sanitizedArgs.push(arg);
    if (arg === "--message") {
      const message = args[index + 1] ?? "";
      sanitizedArgs.push(
        `[prompt:${message.length}:${hashLogValue(message)}]`
      );
      index += 1;
    }
  }

  return summarizeLogObject("args", sanitizedArgs);
}

function hashLogValue(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function summarizeLogObject(label: string, value: unknown): string {
  return ` ${label}=${JSON.stringify(sanitizeLogValue(value, 0))}`;
}

function sanitizeLogValue(value: unknown, depth: number): unknown {
  if (depth > 3) {
    return "[depth-limit]";
  }

  if (typeof value === "string") {
    return sanitizeLogString(value);
  }

  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 10).map((item) => sanitizeLogValue(item, depth + 1));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 30)
        .map(([key, item]) => [
          key,
          shouldRedactLogKey(key) ? "[redacted]" : sanitizeLogValue(item, depth + 1)
        ])
    );
  }

  return String(value);
}

function sanitizeLogString(value: string): string {
  return truncate(
    redactLogSecrets(value).replace(
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
      (email) => redactEmail(email)
    ),
    300
  );
}

function shouldRedactLogKey(key: string): boolean {
  return /(authorization|token|secret|password|credential|jwt|cookie)/i.test(key);
}

function redactEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) {
    return "[redacted-email]";
  }

  return `${local.slice(0, 2)}***@${domain}`;
}

function mergeClassification(
  left: RunResponse["response"]["classification"],
  right: ToolResult["classification"]
): RunResponse["response"]["classification"] {
  if (left === "restricted" || right === "restricted") {
    return "restricted";
  }

  if (left === "user_private" || right === "user_private") {
    return "user_private";
  }

  return "public";
}

function buildOpenClawArgs(
  config: RuntimeConfig,
  prompt: string,
  sessionId: string,
  rawStreamPath: string | null = null
): string[] {
  const args = [
    "agent",
    "--agent",
    config.openClawAgent,
    "--message",
    prompt,
    "--session-id",
    sessionId
  ];

  if (rawStreamPath) {
    args.push("--raw-stream", "--raw-stream-path", rawStreamPath);
  }

  if (config.engine !== "openclaw-gateway") {
    args.splice(3, 0, "--local");
  }

  return args;
}

async function prepareRawStreamPath(
  config: RuntimeConfig,
  request: RunRequest,
  step: number
): Promise<string | null> {
  if (!config.openClawRawStreamDebug) {
    return null;
  }

  const dir = join(config.openClawStateDir, "raw-streams");
  await mkdir(dir, { recursive: true });
  const runKey = hashSessionKey(request.runId ?? randomUUID());
  return join(dir, `${runKey}-step-${step}-${Date.now()}.jsonl`);
}

async function readRawStreamForUsage(
  rawStreamPath: string | null,
  logInfo: RuntimeLogger,
  request: RunRequest,
  step: number
): Promise<string | null> {
  if (!rawStreamPath) {
    return null;
  }

  try {
    const content = await readFile(rawStreamPath, "utf8");
    logInfo(
      `OpenClaw raw stream captured runId=${request.runId ?? "unknown"} step=${step} path=${rawStreamPath} bytes=${new TextEncoder().encode(content).length}`
    );
    return content;
  } catch (error) {
    logInfo(
      `OpenClaw raw stream unavailable runId=${request.runId ?? "unknown"} step=${step} path=${rawStreamPath} error=${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

function buildRunSessionId(request: RunRequest): string {
  return `burble-run-${hashSessionKey(
    `${buildSessionRoot(request)}:${buildRunSessionKey(request)}`
  )}`;
}

function buildStepSessionId(runSessionId: string, step: number): string {
  return `burble-step-${hashSessionKey(`${runSessionId}:step:${step}`)}`;
}

function buildRunSessionKey(request: RunRequest): string {
  if (request.runId) {
    return hashSessionKey(request.runId);
  }

  return randomUUID().replace(/-/g, "");
}

function buildSessionRoot(request: RunRequest): string {
  const conversation = request.input.conversation;
  if (conversation) {
    return `burble-${conversation.source}-${hashSessionKey(
      [
        conversation.workspaceId,
        conversation.channelId,
        conversation.rootId,
        conversation.isDirectMessage ? "dm" : "channel"
      ].join(":")
    )}`;
  }

  const email = request.input.connections.github.email ?? "anonymous";
  return `burble-${email.replace(/[^a-zA-Z0-9_.-]/g, "_")}`;
}

function hashSessionKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
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
  return redactLogSecrets(value)
    .replace(
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
      (email) => redactEmail(email)
    )
    .replace(/\s+/g, " ")
    .slice(0, 180);
}

function redactLogSecrets(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[redacted-openai-key]")
    .replace(/xox[baprs]-[A-Za-z0-9-]+/g, "[redacted-slack-token]")
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, "[redacted-github-token]")
    .replace(/burble_rt_[a-f0-9]+/g, "[redacted-runtime-token]");
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
