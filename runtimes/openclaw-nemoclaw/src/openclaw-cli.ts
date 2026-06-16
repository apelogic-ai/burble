import { createHash, randomUUID } from "node:crypto";
import { stripRuntimeToolCallProtocolFragments } from "@burble/runtime-sdk/runtime-text-protocol";
import { readFileSync } from "node:fs";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeConfig } from "./config";
import { readGatewayDiagnosticTextSince } from "./gateway-diagnostics";
import { parseLlmModelId, type ParsedLlmModel } from "./llm-config";
import { info, type RuntimeLogger } from "./logger";
import { buildOpenClawProcessEnv } from "./process-env";
import {
  isSupportedGitHubRequest,
  isSupportedJiraRequest,
  runBurbleRequest
} from "./runner";
import type {
  RunEvent,
  RunRequest,
  RunResponse,
  RunTelemetry,
  RunUsage,
  ToolExecutor,
  ToolResult
} from "./types";

export type CliCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  deltaCount?: number;
  usage?: RunUsage;
  telemetry?: RunTelemetry;
};

export type CliCommandRunner = (
  command: string,
  args: string[],
  options: { timeoutMs: number; env?: Record<string, string> }
) => Promise<CliCommandResult>;

const preloadedRuntimeSkillNames = ["core", "github", "atlassian-jira"] as const;
type PreloadedRuntimeSkillName = (typeof preloadedRuntimeSkillNames)[number];
type RuntimeToolGroup = NonNullable<
  RunRequest["input"]["toolGroups"]
>["groups"][number];
const maxRecentSlackContextMessages = 12;
const maxRecentSlackContextMessageChars = 300;
const preloadedRuntimeSkillText: Record<PreloadedRuntimeSkillName, string> =
  Object.fromEntries(
    preloadedRuntimeSkillNames.map((name) => [name, loadRuntimeSkill(name)])
  ) as Record<PreloadedRuntimeSkillName, string>;
const defaultPreloadedRuntimeSkills = preloadedRuntimeSkillNames.map((name) => ({
  id: name,
  version: "1",
  enabled: true
}));

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
const maxBootstrapRetries = 1;

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

type RunUsageTelemetryResult = {
  usage?: RunUsage;
  telemetry: RunTelemetry;
};

type GatewayHttpResponseResult = {
  stdout: string;
  responseText: string;
  deltaCount: number;
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
  const sessionScope = buildRunSessionScope(request);
  logInfo(
    `OpenClaw agent start runId=${request.runId ?? "unknown"} agent=${config.openClawAgent} sessionId=${sessionId} sessionScope=${sessionScope} textLength=${request.input.text.length} classification=${baseline.response.classification}`
  );
  const executedTools: ExecutedToolCall[] = [];
  const rejectedDirectResponses: string[] = [];
  let classification = baseline.response.classification;
  let totalUsage: RunUsage | undefined;
  let totalTelemetry: RunTelemetry | undefined;

  for (let step = 0; step <= maxPlannedToolCalls; step += 1) {
    const prompt = buildPlanningPrompt(
      config,
      request,
      toolContext,
      executedTools,
      rejectedDirectResponses
    );
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
    totalUsage = addRunUsage(totalUsage, result.usage);
    totalTelemetry = addRunTelemetry(totalTelemetry, result.telemetry);

    if (!plannedToolCall) {
      const lastToolResult = executedTools.at(-1)?.toolResult;
      const rawText =
        extractOpenClawText(result.stdout) ||
        (lastToolResult ? formatToolResult(lastToolResult) : baseline.response.text);
      if (
        rejectedDirectResponses.length < maxBootstrapRetries &&
        isBootstrapSetupAnswer(rawText)
      ) {
        rejectedDirectResponses.push(rawText);
        logInfo(
          config.engine === "burble-direct"
            ? `Burble direct model retry runId=${request.runId ?? "unknown"} step=${step + 1} reason=bootstrap_response`
            : `OpenClaw bootstrap retry runId=${request.runId ?? "unknown"} step=${step + 1} reason=bootstrap_response`
        );
        continue;
      }
      const text = sanitizeBootstrapFragments(rawText, baseline.response.text);
      logInfo(
        `OpenClaw agent finish runId=${request.runId ?? "unknown"} classification=${classification} textLength=${text.length}`
      );

      return {
        response: {
          classification,
          text,
          ...(totalUsage ? { usage: totalUsage } : {}),
          ...(totalTelemetry ? { telemetry: totalTelemetry } : {})
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
          text,
          ...(totalUsage ? { usage: totalUsage } : {}),
          ...(totalTelemetry ? { telemetry: totalTelemetry } : {})
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
          text,
          ...(totalUsage ? { usage: totalUsage } : {}),
          ...(totalTelemetry ? { telemetry: totalTelemetry } : {})
        }
      };
    }
    executedTools.push({ toolCall: plannedToolCall, toolResult });
  }

  return {
    response: {
      classification,
      text: baseline.response.text,
      ...(totalUsage ? { usage: totalUsage } : {}),
      ...(totalTelemetry ? { telemetry: totalTelemetry } : {})
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
  if (config.engine === "openclaw-gateway") {
    const result = await runOpenClawGatewayHttpRequest(
      request,
      config,
      prompt,
      sessionId,
      logInfo,
      step
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `OpenClaw Gateway HTTP request failed${result.stderr ? `: ${truncate(redactPreview(result.stderr), 300)}` : ""}`
      );
    }
    return result;
  }
  if (config.engine === "burble-direct") {
    const result = await runBurbleDirectProviderRequest(
      request,
      config,
      prompt,
      sessionId,
      logInfo,
      step
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `Burble direct model request failed${result.stderr ? `: ${truncate(redactPreview(result.stderr), 300)}` : ""}`
      );
    }
    return result;
  }

  const startedAt = Date.now();
  const rawStreamPath = await prepareRawStreamPath(config, request, step, logInfo);
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
    const rawStream = await readRawStreamForUsage(
      config,
      rawStreamPath,
      logInfo,
      request,
      step
    );
    const gatewayDiagnostics = readGatewayDiagnosticTextSince(startedAt);
    logOpenClawUsageFromOutput(
      request,
      step,
      prompt,
      result.stdout,
      result.stderr,
      rawStream,
      gatewayDiagnostics,
      sessionId,
      logInfo
    );
    logInfo(
      `OpenClaw command error runId=${request.runId ?? "unknown"} step=${step} exitCode=${result.exitCode}${summarizeLogObject("stdoutPreview", result.stdout)}${summarizeLogObject("stderrPreview", result.stderr)}`
    );
    throw new Error(`OpenClaw CLI exited with code ${result.exitCode}`);
  }
  const rawStream = await readRawStreamForUsage(
    config,
    rawStreamPath,
    logInfo,
    request,
    step
  );
  const gatewayDiagnostics = readGatewayDiagnosticTextSince(startedAt);
  const usageTelemetry = logOpenClawUsageFromOutput(
    request,
    step,
    prompt,
    result.stdout,
    result.stderr,
    rawStream,
    gatewayDiagnostics,
    sessionId,
    logInfo
  );
  logInfo(
    `OpenClaw command finish runId=${request.runId ?? "unknown"} step=${step} elapsedMs=${Date.now() - startedAt} stdoutChars=${result.stdout.length} stderrChars=${result.stderr.length}${summarizeLogObject("stderrPreview", result.stderr)}`
  );
  return { ...result, ...usageTelemetry };
}

async function runOpenClawGatewayHttpRequest(
  request: RunRequest,
  config: RuntimeConfig,
  prompt: string,
  sessionId: string,
  logInfo: RuntimeLogger,
  step: number,
  onDelta?: (delta: string) => void
): Promise<CliCommandResult> {
  const startedAt = Date.now();
  const baseSessionKey = buildGatewayHttpSessionKey(config, sessionId);
  const endpoint = buildGatewayHttpResponsesUrl(config);
  logInfo(
    `OpenClaw gateway http start runId=${request.runId ?? "unknown"} step=${step} agent=${config.openClawAgent} endpoint=/v1/responses timeoutMs=${config.openClawTimeoutMs}${summarizePromptForLog(prompt)} sessionKey=${baseSessionKey}`
  );
  logStreamDebug(config, logInfo, "prompt preview", {
    runId: request.runId ?? "unknown",
    promptHash: hashLogValue(prompt),
    chars: prompt.length,
    preview: prompt
  });

  let stdout = "";
  let stderr = "";
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attemptStartedAt = Date.now();
    const attemptSessionId = buildGatewayHttpAttemptSessionId(
      sessionId,
      attempt
    );
    const attemptSessionKey = buildGatewayHttpSessionKey(
      config,
      attemptSessionId
    );
    try {
      const response = await fetchGatewayHttpResponse(
        endpoint,
        config,
        request,
        attemptSessionKey,
        prompt,
        Boolean(onDelta)
      );
      if (!response.ok) {
        const responseText = await response.text();
        stderr = responseText;
        logInfo(
          `OpenClaw gateway http error runId=${request.runId ?? "unknown"} step=${step} status=${response.status}${summarizeLogObject("bodyPreview", responseText)}`
        );
        if (
          attempt < maxAttempts &&
          isRetryableOpenClawGatewayProviderError(response.status, responseText)
        ) {
          const nextSessionKey = buildGatewayHttpSessionKey(
            config,
            buildGatewayHttpAttemptSessionId(sessionId, attempt + 1)
          );
          logInfo(
            `OpenClaw gateway http retry runId=${request.runId ?? "unknown"} step=${step} attempt=${attempt} status=${response.status} reason=upstream_provider_timeout elapsedMs=${Date.now() - attemptStartedAt} nextSessionKey=${nextSessionKey}`
          );
          continue;
        }
        const gatewayDiagnostics = readGatewayDiagnosticTextSince(startedAt);
        const usageTelemetry = logOpenClawUsageFromOutput(
          request,
          step,
          prompt,
          stdout,
          stderr,
          null,
          gatewayDiagnostics,
          sessionId,
          logInfo,
          startedAt
        );
        return { exitCode: 1, stdout, stderr, ...usageTelemetry };
      }

      const responseResult = onDelta && isGatewayHttpStreamingResponse(response)
        ? await readGatewayHttpStreamingResponse(response, onDelta)
        : {
            responseText: await response.text(),
            stdout: "",
            deltaCount: 0
          };
      const responseText = responseResult.responseText;
      stdout =
        responseResult.stdout ||
        extractOpenResponsesText(responseText) ||
        responseText;
      const gatewayDiagnostics = readGatewayDiagnosticTextSince(startedAt);
      const usageTelemetry = logOpenClawUsageFromOutput(
        request,
        step,
        prompt,
        [responseText, stdout].join("\n"),
        stderr,
        null,
        gatewayDiagnostics,
        sessionId,
        logInfo,
        startedAt
      );
      logInfo(
        `OpenClaw gateway http finish runId=${request.runId ?? "unknown"} step=${step} elapsedMs=${Date.now() - startedAt} status=${response.status} stdoutChars=${stdout.length} responseChars=${responseText.length} deltaCount=${responseResult.deltaCount}`
      );
      return {
        exitCode: 0,
        stdout,
        stderr,
        deltaCount: responseResult.deltaCount,
        ...usageTelemetry
      };
    } catch (error) {
      stderr = error instanceof Error ? error.message : String(error);
      if (
        attempt < maxAttempts &&
        isRetryableOpenClawGatewayTransportError(error)
      ) {
        const nextSessionKey = buildGatewayHttpSessionKey(
          config,
          buildGatewayHttpAttemptSessionId(sessionId, attempt + 1)
        );
        logInfo(
          `OpenClaw gateway http retry runId=${request.runId ?? "unknown"} step=${step} attempt=${attempt} reason=transport_error elapsedMs=${Date.now() - attemptStartedAt} nextSessionKey=${nextSessionKey}${summarizeLogObject("error", stderr)}`
        );
        continue;
      }
      const gatewayDiagnostics = readGatewayDiagnosticTextSince(startedAt);
      const usageTelemetry = logOpenClawUsageFromOutput(
        request,
        step,
        prompt,
        stdout,
        stderr,
        null,
        gatewayDiagnostics,
        sessionId,
        logInfo,
        startedAt
      );
      logInfo(
        `OpenClaw gateway http error runId=${request.runId ?? "unknown"} step=${step}${summarizeLogObject("error", stderr)}`
      );
      return { exitCode: 1, stdout, stderr, ...usageTelemetry };
    }
  }
  throw new Error("OpenClaw gateway HTTP retry loop exhausted unexpectedly");
}

function isRetryableOpenClawGatewayProviderError(
  status: number,
  responseText: string
): boolean {
  if (status !== 408 && status < 500) {
    return false;
  }
  const normalized = responseText.toLowerCase();
  return (
    normalized.includes("upstream provider timeout") ||
    normalized.includes("server_error") ||
    normalized.includes('"code":"api_error"') ||
    normalized.includes('"code":"server_error"')
  );
}

function isRetryableOpenClawGatewayTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const normalized = `${error.name} ${error.message}`.toLowerCase();
  return (
    normalized.includes("abort") ||
    normalized.includes("timeout") ||
    normalized.includes("timed out") ||
    normalized.includes("econnreset") ||
    normalized.includes("econnrefused") ||
    normalized.includes("socket hang up") ||
    normalized.includes("network")
  );
}

async function runBurbleDirectProviderRequest(
  request: RunRequest,
  config: RuntimeConfig,
  prompt: string,
  sessionId: string,
  logInfo: RuntimeLogger,
  step: number
): Promise<CliCommandResult> {
  const startedAt = Date.now();
  const sessionKey = buildGatewayHttpSessionKey(config, sessionId);
  const parsedModel = parseLlmModelId(config.llmModel);
  logInfo(
    `Burble direct model start runId=${request.runId ?? "unknown"} step=${step} provider=${parsedModel.provider} model=${parsedModel.model} timeoutMs=${config.openClawTimeoutMs}${summarizePromptForLog(prompt)} sessionKey=${sessionKey}`
  );
  logStreamDebug(config, logInfo, "prompt preview", {
    runId: request.runId ?? "unknown",
    promptHash: hashLogValue(prompt),
    chars: prompt.length,
    preview: prompt
  });

  let stdout = "";
  let stderr = "";
  try {
    const response = await fetchDirectModelResponse(
      config,
      parsedModel,
      prompt
    );
    const responseText = await response.text();
    if (!response.ok) {
      stderr = responseText;
      const usageTelemetry = logOpenClawUsageFromOutput(
        request,
        step,
        prompt,
        stdout,
        stderr,
        null,
        "",
        sessionId,
        logInfo,
        startedAt
      );
      logInfo(
        `Burble direct model error runId=${request.runId ?? "unknown"} step=${step} status=${response.status}${summarizeLogObject("bodyPreview", responseText)}`
      );
      return { exitCode: 1, stdout, stderr, ...usageTelemetry };
    }

    stdout =
      extractDirectModelText(parsedModel.provider, responseText) ?? responseText;
    const usageTelemetry = logOpenClawUsageFromOutput(
      request,
      step,
      prompt,
      [responseText, stdout].join("\n"),
      stderr,
      null,
      "",
      sessionId,
      logInfo,
      startedAt
    );
    logInfo(
      `Burble direct model finish runId=${request.runId ?? "unknown"} step=${step} elapsedMs=${Date.now() - startedAt} status=${response.status} stdoutChars=${stdout.length} responseChars=${responseText.length}`
    );
    return { exitCode: 0, stdout, stderr, ...usageTelemetry };
  } catch (error) {
    stderr = error instanceof Error ? error.message : String(error);
    const usageTelemetry = logOpenClawUsageFromOutput(
      request,
      step,
      prompt,
      stdout,
      stderr,
      null,
      "",
      sessionId,
      logInfo,
      startedAt
    );
    logInfo(
      `Burble direct model error runId=${request.runId ?? "unknown"} step=${step}${summarizeLogObject("error", stderr)}`
    );
    return { exitCode: 1, stdout, stderr, ...usageTelemetry };
  }
}

async function* collectOpenClawGatewayHttpResponse(
  request: RunRequest,
  config: RuntimeConfig,
  prompt: string,
  sessionId: string,
  logInfo: RuntimeLogger,
  heartbeatMs: number,
  emitDeltas: boolean,
  step: number
): AsyncGenerator<
  RunEvent,
  { stdout: string; usage?: RunUsage; telemetry?: RunTelemetry },
  void
> {
  const startedAt = Date.now();
  const deltas: string[] = [];
  let wakeDeltas: (() => void) | null = null;
  const pushDelta = (delta: string) => {
    const sanitizedDelta = stripRuntimeToolCallProtocolFragments(delta);
    if (sanitizedDelta.trim()) {
      deltas.push(sanitizedDelta);
    }
    wakeDeltas?.();
    wakeDeltas = null;
  };
  const resultPromise =
    config.engine === "burble-direct"
      ? runBurbleDirectProviderRequest(
          request,
          config,
          prompt,
          sessionId,
          logInfo,
          step
        )
      : runOpenClawGatewayHttpRequest(
          request,
          config,
          prompt,
          sessionId,
          logInfo,
          step,
          emitDeltas ? pushDelta : undefined
        );
  let result: CliCommandResult | null = null;

  while (!result) {
    const raced = await Promise.race([
      resultPromise.then((value) => ({ type: "result" as const, value })),
      new Promise<{ type: "delta" }>((resolve) => {
        wakeDeltas = () => resolve({ type: "delta" });
      }),
      sleep(heartbeatMs).then(() => ({ type: "heartbeat" as const }))
    ]);

    if (raced.type === "delta") {
      while (deltas.length > 0) {
        const delta = deltas.shift();
        if (!delta) {
          continue;
        }
        yield { type: "message_delta", text: delta };
      }
      continue;
    }

    if (raced.type === "heartbeat") {
      yield {
        type: "status",
        text: `Agent has thought for ${Math.round(
          (Date.now() - startedAt) / 1000
        )}s`
      };
      logStreamDebug(config, logInfo, "heartbeat", {
        runId: request.runId ?? "unknown",
        elapsedMs: Date.now() - startedAt,
        stdoutChunks: 0,
        stderrChunks: 0,
        stdoutChars: 0,
        stderrChars: 0
      });
      continue;
    }

    result = raced.value;
  }
  while (deltas.length > 0) {
    const delta = deltas.shift();
    if (delta) {
      yield { type: "message_delta", text: delta };
    }
  }

  logStreamDebug(config, logInfo, "stdout complete", {
    runId: request.runId ?? "unknown",
    elapsedMs: Date.now() - startedAt,
    chunkCount: result.stdout ? 1 : 0,
    stderrChunkCount: result.stderr ? 1 : 0,
    deltaCount: shouldEmitGatewayHttpDelta(result.stdout) ? 1 : 0,
    stdoutChars: result.stdout.length,
    stderrChars: result.stderr.length,
    exitCode: result.exitCode
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `${config.engine === "burble-direct" ? "Burble direct model request" : "OpenClaw Gateway HTTP request"} failed${result.stderr ? `: ${truncate(redactPreview(result.stderr), 300)}` : ""}`
    );
  }

  if (
    emitDeltas &&
    (result.deltaCount ?? 0) === 0 &&
    shouldEmitGatewayHttpDelta(result.stdout)
  ) {
    logStreamDebug(config, logInfo, "delta parsed", {
      runId: request.runId ?? "unknown",
      elapsedMs: Date.now() - startedAt,
      deltaCount: 1,
      chars: result.stdout.length,
      preview: result.stdout
    });
    yield { type: "message_delta", text: result.stdout };
  }

  return {
    stdout: result.stdout,
    ...(result.usage ? { usage: result.usage } : {}),
    ...(result.telemetry ? { telemetry: result.telemetry } : {})
  };
}

function isGatewayHttpStreamingResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  return contentType.includes("text/event-stream");
}

function shouldEmitGatewayHttpDelta(stdout: string): boolean {
  const parsed = parseJsonObject(stdout.trim());
  return !(parsed && typeof parsed.tool_call === "object" && parsed.tool_call !== null);
}

async function fetchDirectModelResponse(
  config: RuntimeConfig,
  parsedModel: ParsedLlmModel,
  prompt: string
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.openClawTimeoutMs);
  try {
    const request = buildDirectModelRequest(config, parsedModel, prompt);
    return await fetch(request.endpoint, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchGatewayHttpResponse(
  endpoint: string,
  config: RuntimeConfig,
  request: RunRequest,
  sessionKey: string,
  prompt: string,
  stream: boolean
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.openClawTimeoutMs);
  try {
    return await fetch(endpoint, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${config.openClawGatewayToken}`,
        "content-type": "application/json",
        "x-openclaw-agent-id": config.openClawAgent,
        "x-openclaw-message-channel": resolveGatewayHttpMessageChannel(request),
        "x-openclaw-session-key": sessionKey
      },
      body: JSON.stringify({
        model: `openclaw/${config.openClawAgent}`,
        input: prompt,
        stream
      }),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function readGatewayHttpStreamingResponse(
  response: Response,
  onDelta: (delta: string) => void
): Promise<GatewayHttpResponseResult> {
  if (!response.body) {
    const responseText = await response.text();
    return {
      responseText,
      stdout: extractOpenResponsesText(responseText) ?? responseText,
      deltaCount: 0
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const gate = createGatewayHttpDeltaGate(onDelta);
  let buffer = "";
  let responseText = "";
  let stdout = "";
  let deltaCount = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const parsed = readCompleteSsePayloads(buffer);
    buffer = parsed.remainder;
    for (const payload of parsed.payloads) {
      if (payload === "[DONE]") {
        continue;
      }
      responseText = appendStreamRecord(responseText, payload);
      const event = parseJsonObject(payload);
      if (!event) {
        continue;
      }
      const completedText = extractOpenResponsesText(payload);
      if (completedText?.trim()) {
        stdout = completedText;
      }
      const delta = extractOpenResponsesStreamDelta(event);
      if (!delta) {
        continue;
      }
      stdout += delta;
      deltaCount += 1;
      gate(delta);
    }
  }

  const tail = decoder.decode();
  if (tail) {
    buffer += tail;
  }
  const parsed = readCompleteSsePayloads(`${buffer}\n\n`);
  for (const payload of parsed.payloads) {
    if (payload === "[DONE]") {
      continue;
    }
    responseText = appendStreamRecord(responseText, payload);
    const event = parseJsonObject(payload);
    if (!event) {
      continue;
    }
    const completedText = extractOpenResponsesText(payload);
    if (completedText?.trim()) {
      stdout = completedText;
    }
    const delta = extractOpenResponsesStreamDelta(event);
    if (!delta) {
      continue;
    }
    stdout += delta;
    deltaCount += 1;
    gate(delta);
  }

  return {
    responseText,
    stdout: stdout || extractOpenResponsesText(responseText) || responseText,
    deltaCount
  };
}

function createGatewayHttpDeltaGate(
  onDelta: (delta: string) => void
): (delta: string) => void {
  let mode: "pending" | "emit" | "suppress" = "pending";
  let buffered = "";

  return (delta: string) => {
    if (mode === "suppress") {
      return;
    }
    if (mode === "emit") {
      onDelta(delta);
      return;
    }

    buffered += delta;
    const trimmed = buffered.trimStart();
    if (!trimmed) {
      return;
    }

    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      mode = "suppress";
      return;
    }

    mode = "emit";
    onDelta(buffered);
    buffered = "";
  };
}

function readCompleteSsePayloads(input: string): {
  payloads: string[];
  remainder: string;
} {
  const payloads: string[] = [];
  let offset = 0;
  while (true) {
    const separator = input.indexOf("\n\n", offset);
    if (separator === -1) {
      break;
    }
    const block = input.slice(offset, separator);
    offset = separator + 2;
    const payload = readSseBlockPayload(block);
    if (payload) {
      payloads.push(payload);
    }
  }
  return { payloads, remainder: input.slice(offset) };
}

function readSseBlockPayload(block: string): string | null {
  const lines = block.split(/\r?\n/);
  const dataLines = lines
    .map((line) => line.trimEnd())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart());
  return dataLines.length > 0 ? dataLines.join("\n") : null;
}

function appendStreamRecord(current: string, payload: string): string {
  return current ? `${current}\n${payload}` : payload;
}

type DirectModelRequest = {
  endpoint: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

const directPlanningSystemPrompt = [
  "You are Burble's direct planning model for Slack.",
  "Follow the user prompt exactly.",
  "The requester is already known through Burble's Slack and provider connections.",
  "Words like me, my, and assign to me refer to the requesting Slack user, never to the assistant.",
  "Return either concise Slack mrkdwn or the exact JSON tool_call object requested by the prompt.",
  "Do not inspect files, mention bootstrap, ask who you are, ask who the user is, ask for vibe/persona/emoji setup, or ask for identity setup."
].join(" ");

function buildDirectModelRequest(
  config: RuntimeConfig,
  parsedModel: ParsedLlmModel,
  prompt: string
): DirectModelRequest {
  if (parsedModel.provider === "openai") {
    return {
      endpoint: "https://api.openai.com/v1/responses",
      headers: {
        "authorization": `Bearer ${readProviderApiKey("OPENAI_API_KEY")}`,
        "content-type": "application/json"
      },
      body: {
        model: parsedModel.model,
        instructions: directPlanningSystemPrompt,
        input: prompt,
        stream: false,
        parallel_tool_calls: false
      }
    };
  }

  if (parsedModel.provider === "anthropic") {
    return {
      endpoint: "https://api.anthropic.com/v1/messages",
      headers: {
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "x-api-key": readProviderApiKey("ANTHROPIC_API_KEY")
      },
      body: {
        model: parsedModel.model,
        max_tokens: 2048,
        system: directPlanningSystemPrompt,
        messages: [{ role: "user", content: prompt }]
      }
    };
  }

  const baseUrl = config.ollamaBaseUrl.replace(/\/+$/, "");
  const endpointBase = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
  return {
    endpoint: `${endpointBase}/chat/completions`,
    headers: {
      "authorization": `Bearer ${readOllamaApiKey(baseUrl)}`,
      "content-type": "application/json"
    },
    body: {
      model: parsedModel.model,
      messages: [
        { role: "system", content: directPlanningSystemPrompt },
        { role: "user", content: prompt }
      ],
      stream: false
    }
  };
}

function readProviderApiKey(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function readOllamaApiKey(baseUrl: string): string {
  if (isLocalOllamaBaseUrl(baseUrl)) {
    return process.env.OLLAMA_API_KEY?.trim() || "ollama-local";
  }

  return readProviderApiKey("OLLAMA_API_KEY");
}

function isLocalOllamaBaseUrl(baseUrl: string): boolean {
  try {
    const parsed = new URL(baseUrl);
    return ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function extractDirectModelText(
  provider: ParsedLlmModel["provider"],
  responseText: string
): string | null {
  if (provider === "openai") {
    return extractOpenResponsesText(responseText);
  }

  const parsed = parseJsonObject(responseText);
  if (!parsed) {
    return null;
  }

  if (provider === "anthropic") {
    const content = parsed.content;
    if (!Array.isArray(content)) {
      return null;
    }

    const text = content
      .map((part) =>
        part &&
        typeof part === "object" &&
        !Array.isArray(part) &&
        (part as Record<string, unknown>).type === "text" &&
        typeof (part as Record<string, unknown>).text === "string"
          ? String((part as Record<string, unknown>).text)
          : null
      )
      .filter((part): part is string => Boolean(part?.trim()))
      .join("\n\n")
      .trim();
    return text || null;
  }

  const choices = parsed.choices;
  if (!Array.isArray(choices)) {
    return null;
  }

  for (const choice of choices) {
    if (!choice || typeof choice !== "object" || Array.isArray(choice)) {
      continue;
    }

    const message = (choice as Record<string, unknown>).message;
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      continue;
    }

    const content = (message as Record<string, unknown>).content;
    if (typeof content === "string" && content.trim()) {
      return content.trim();
    }
  }

  return null;
}

function buildGatewayHttpSessionKey(
  config: RuntimeConfig,
  sessionId: string
): string {
  return `agent:${config.openClawAgent}:explicit:${sessionId}`;
}

function buildGatewayHttpAttemptSessionId(
  sessionId: string,
  attempt: number
): string {
  if (attempt <= 1) {
    return sessionId;
  }

  return `${sessionId}-attempt-${attempt}`;
}

function buildGatewayHttpResponsesUrl(config: RuntimeConfig): string {
  return `http://127.0.0.1:${config.openClawGatewayPort}/v1/responses`;
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
  const sessionScope = buildRunSessionScope(request);
  logInfo(
    `OpenClaw agent start runId=${request.runId ?? "unknown"} agent=${config.openClawAgent} sessionId=${sessionId} sessionScope=${sessionScope} textLength=${request.input.text.length} classification=${baseline.response.classification}`
  );
  yield { type: "status", text: "Agent is thinking..." };

  const executedTools: ExecutedToolCall[] = [];
  const rejectedDirectResponses: string[] = [];
  let classification = baseline.response.classification;
  let totalUsage: RunUsage | undefined;
  let totalTelemetry: RunTelemetry | undefined;

  for (let step = 0; step <= maxPlannedToolCalls; step += 1) {
    const prompt = buildPlanningPrompt(
      config,
      request,
      toolContext,
      executedTools,
      rejectedDirectResponses
    );
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
      runtimeMessageDeltasEnabled(request),
      step + 1
    );
    const plannedToolCall = normalizePlannedToolCall(
      readPlannedToolCall(result.stdout, toolContext.catalog)
    );
    totalUsage = addRunUsage(totalUsage, result.usage);
    totalTelemetry = addRunTelemetry(totalTelemetry, result.telemetry);

    if (!plannedToolCall) {
      const lastToolResult = executedTools.at(-1)?.toolResult;
      const rawText =
        extractOpenClawText(result.stdout) ||
        (lastToolResult ? formatToolResult(lastToolResult) : baseline.response.text);
      if (
        rejectedDirectResponses.length < maxBootstrapRetries &&
        isBootstrapSetupAnswer(rawText)
      ) {
        rejectedDirectResponses.push(rawText);
        logInfo(
          config.engine === "burble-direct"
            ? `Burble direct model retry runId=${request.runId ?? "unknown"} step=${step + 1} reason=bootstrap_response`
            : `OpenClaw bootstrap retry runId=${request.runId ?? "unknown"} step=${step + 1} reason=bootstrap_response`
        );
        continue;
      }
      const text = sanitizeBootstrapFragments(rawText, baseline.response.text);
      logInfo(
        `OpenClaw agent finish runId=${request.runId ?? "unknown"} classification=${classification} textLength=${text.length}`
      );

      yield {
        type: "final",
        response: {
          classification,
          text,
          ...(totalUsage ? { usage: totalUsage } : {}),
          ...(totalTelemetry ? { telemetry: totalTelemetry } : {})
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
          text,
          ...(totalUsage ? { usage: totalUsage } : {}),
          ...(totalTelemetry ? { telemetry: totalTelemetry } : {})
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
          text,
          ...(totalUsage ? { usage: totalUsage } : {}),
          ...(totalTelemetry ? { telemetry: totalTelemetry } : {})
        }
      };
      return;
    }
    executedTools.push({ toolCall: plannedToolCall, toolResult });
  }
}

function runtimeMessageDeltasEnabled(request: RunRequest): boolean {
  return request.runtime?.manifest?.streaming?.messageDeltasEnabled !== false;
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
): AsyncGenerator<
  RunEvent,
  { stdout: string; usage?: RunUsage; telemetry?: RunTelemetry },
  void
> {
  if (config.engine === "openclaw-gateway" || config.engine === "burble-direct") {
    return yield* collectOpenClawGatewayHttpResponse(
      request,
      config,
      prompt,
      sessionId,
      logInfo,
      heartbeatMs,
      emitDeltas,
      step
    );
  }

  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  let chunkCount = 0;
  let stderrChunkCount = 0;
  let deltaCount = 0;
  let firstStdoutLogged = false;
  let firstStderrLogged = false;
  const startedAt = Date.now();
  const rawStreamPath = await prepareRawStreamPath(config, request, step, logInfo);
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
        text: `Agent has thought for ${Math.round(
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
  const rawStream = await readRawStreamForUsage(
    config,
    rawStreamPath,
    logInfo,
    request,
    step
  );
  const gatewayDiagnostics = readGatewayDiagnosticTextSince(startedAt);
  const usageTelemetry = logOpenClawUsageFromOutput(
    request,
    step,
    prompt,
    stdout,
    stderr,
    rawStream,
    gatewayDiagnostics,
    sessionId,
    logInfo
  );

  if (exitCode !== 0) {
    throw new Error(
      `OpenClaw CLI exited with code ${exitCode ?? "unknown"}${stderr ? `: ${truncate(redactPreview(stderr), 300)}` : ""}`
    );
  }

  return { stdout, ...usageTelemetry };
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
    env: buildOpenClawProcessEnv(options.env)
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
    env: buildOpenClawProcessEnv(options.env)
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
    buildToolCatalog(request, config, executeTool)
  ]);
  logInfo(
    `OpenClaw context finish runId=${request.runId ?? "unknown"} elapsedMs=${Date.now() - startedAt} catalogTools=${catalogBuild.catalog.length} upstreamSchemas=${Object.keys(catalogBuild.upstreamMcpSchemas).length} toolGroups=${formatSelectedRuntimeToolGroups(request)} baselineClassification=${baseline.response.classification}`
  );

  return {
    baseline,
    catalog: catalogBuild.catalog,
    upstreamMcpSchemas: catalogBuild.upstreamMcpSchemas
  };
}

async function buildToolCatalog(
  request: RunRequest,
  config: RuntimeConfig,
  executeTool: ToolExecutor
): Promise<{
  catalog: ToolCatalogItem[];
  upstreamMcpSchemas: Record<string, unknown>;
}> {
  const catalog: ToolCatalogItem[] = [];
  const upstreamMcpSchemas: Record<string, unknown> = {};
  if (request.input.conversation) {
    catalog.push({
      name: "conversation.sendMessage",
      description:
        "Send a message through Burble to the active conversation or a durable conversation route. Burble chooses and validates the transport and destination; provide message text. Scheduled/background routeId and jobId are injected from trusted run context.",
      inputSchema: {
        text: "string message text to send",
        routeId:
          "optional durable Burble route ID for non-scheduled messages",
        jobId:
          "ignored unless supplied by trusted scheduled run context; do not invent scheduled job ids"
      }
    });
    catalog.push({
      name: "scheduledJob.registerCapability",
      description:
        "Register the Burble provider tools, durable state references, and optional resolved Slack delivery route a native scheduled/background job will need. Use before creating, updating, enabling, or triggering a native cron/background job that will call Burble provider tools or post scheduled output to a Slack destination; include the returned scheduledPromptInstruction verbatim in the scheduled job prompt and use the returned convrt_* route for native delivery.",
      inputSchema: {
        jobId: "string stable native scheduler job id or name",
        requiredTools:
          "string[] Burble provider tools the scheduled job may call",
        routeId:
          "optional durable Burble route ID for scheduled/background delivery",
        destination:
          "optional Slack destination label for scheduled/background delivery, such as #eng, <#C123|eng>, or a channel id; pass named Slack channels here instead of using them as delivery route ids. Burble resolves it only when the user has already granted that channel with /agent grant here",
        stateRefs:
          'optional array of durable provider-backed state reference objects, never strings; each entry must include provider and kind strings, for example {"provider":"google","kind":"drive_file","id":"<fileId>","purpose":"dedupe_state"}',
        visibilityPolicy:
          'optional output visibility policy for scheduled delivery; Slack channel destinations require {"maxOutputVisibility":"public","allowPrivateToolDeclassification":true} when the user explicitly asked to post scheduled output to that channel'
      }
    });
    if (selectedRuntimeToolGroups(request)?.has("scheduler")) {
      catalog.push({
        name: "burble_provider_call",
        description:
          "Call one Burble provider tool through the runtime-scoped Burble provider bridge. Use this envelope for scheduled/background provider calls; set toolName to an allowed Burble provider tool and input to that tool's arguments, including jobId for scheduled jobs.",
        inputSchema: {
          toolName:
            "Burble provider tool name, for example google_get_drive_file",
          input:
            "object arguments for that Burble provider tool; scheduled jobs must include jobId"
        }
      });
    }
  }
  if ((request.input.attachments ?? []).length > 0) {
    catalog.push({
      name: "conversation.getAttachment",
      description:
        "Fetch bytes for a Slack attachment from the current request. Use only attachment IDs listed under Current request attachments. Burble validates access and returns metadata plus contentBase64, and text for small text-like files.",
      inputSchema: {
        attachmentId:
          "string attachment id from Current request attachments, for example slack:F123"
      }
    });
  }

  if (config.mcpGatewayUrl && config.runtimeJwt) {
    const discoveredProviderCatalog = await readDiscoveredProviderToolCatalog(
      request,
      executeTool
    );
    if (discoveredProviderCatalog) {
      catalog.push(...discoveredProviderCatalog.catalog);
      Object.assign(
        upstreamMcpSchemas,
        discoveredProviderCatalog.upstreamMcpSchemas
      );
      return filterToolCatalogBySelectedGroups(request, {
        catalog,
        upstreamMcpSchemas
      });
    }
  }

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
          "List GitHub pull requests authored by the requesting Slack user's connected GitHub account. Defaults to open PRs sorted by most recently updated.",
        inputSchema: {
          limit: "number optional, 1-20, maximum pull requests to return",
          state: "string optional, one of: open, closed, all",
          sort: "string optional, one of: updated, created, comments",
          order: "string optional, one of: desc, asc",
          owner:
            "string optional GitHub owner or organization login to filter by, for example example-org",
          repo:
            "string optional repository in owner/name format; takes precedence over owner"
        }
      },
      {
        name: "github.createIssue",
        description:
          "Create a GitHub issue. Use only when the user clearly asks to create an issue.",
        inputSchema: {
          repo: "string repository in owner/name format",
          title: "string issue title",
          body: "optional string issue body",
          labels: "optional string[] labels",
          assignees: "optional string[] GitHub usernames"
        }
      },
      {
        name: "github.commentOnIssueOrPullRequest",
        description:
          "Add a comment to a GitHub issue or pull request. Use only when the user clearly asks to comment.",
        inputSchema: {
          repo: "string repository in owner/name format",
          number: "number issue or pull request number",
          body: "string comment body"
        }
      },
      {
        name: "github.createPullRequest",
        description:
          "Open a GitHub pull request from an existing branch. Use only when explicitly requested.",
        inputSchema: {
          repo: "string repository in owner/name format",
          title: "string pull request title",
          head: "string head branch or owner:branch",
          base: "string base branch",
          body: "optional string pull request body",
          draft: "optional boolean"
        }
      },
      {
        name: "github.updatePullRequest",
        description:
          "Update GitHub pull request metadata: title, body, base branch, or draft state. Does not edit code.",
        inputSchema: {
          repo: "string repository in owner/name format",
          number: "number pull request number",
          title: "optional string new title",
          body: "optional string new body",
          base: "optional string new base branch",
          draft: "optional boolean draft state"
        }
      },
      {
        name: "github.addLabels",
        description: "Add labels to a GitHub issue or pull request.",
        inputSchema: {
          repo: "string repository in owner/name format",
          number: "number issue or pull request number",
          labels: "string[] labels to add"
        }
      },
      {
        name: "github.removeLabels",
        description: "Remove labels from a GitHub issue or pull request.",
        inputSchema: {
          repo: "string repository in owner/name format",
          number: "number issue or pull request number",
          labels: "string[] labels to remove"
        }
      },
      {
        name: "github.requestReview",
        description: "Request user or team reviewers for a GitHub pull request.",
        inputSchema: {
          repo: "string repository in owner/name format",
          number: "number pull request number",
          reviewers: "optional string[] GitHub usernames",
          teamReviewers: "optional string[] GitHub team slugs"
        }
      }
    );
  }

  const slack = request.input.connections.slack;
  if (slack?.connected && slack.email) {
    catalog.push(
      {
        name: "slack.searchUsers",
        description:
          "Search Slack users by display name, real name, username, or Slack user ID.",
        inputSchema: {
          query: "string Slack user name, display name, or ID"
        }
      },
      {
        name: "slack.searchMessages",
        description:
          `Search Slack messages visible to the requesting Slack user's connected Slack search token. The requesting Slack user ID is ${slack.providerLogin ?? "unknown"}; use it as fromUserId for questions like "what did I say about X".`,
        inputSchema: {
          query: "string Slack search terms",
          fromUserId: `optional string Slack user ID to filter by author; for 'what did I say', use ${slack.providerLogin ?? "the requesting Slack user ID"}`,
          inChannel: "optional string channel name without #, or channel ID",
          limit: "optional integer 1-20"
        }
      }
    );
  }

  const google = request.input.connections.google;
  if (google?.connected && google.email) {
    catalog.push(
      {
        name: "google.getAuthenticatedUser",
        description:
          "Return the Google Workspace identity connected to the requesting Slack user.",
        inputSchema: {}
      },
      {
        name: "google.searchDriveFiles",
        description:
          "Search Google Drive files visible to the requesting Slack user's connected Google account.",
        inputSchema: {
          query: "optional string Drive file-name search terms",
          limit: "optional integer 1-20"
        }
      },
      {
        name: "google.createDriveTextFile",
        description:
          "Create a new app-owned plain/text-like file in Google Drive using the requesting Slack user's connected Google account. Do not use this to create Google Docs, Sheets, or Slides.",
        inputSchema: {
          name: "string Drive file name",
          text: "optional string text body to write into the file; defaults to an empty text file",
          mimeType:
            "optional non-Google-Workspace MIME type; defaults to text/plain"
        }
      },
      {
        name: "google.searchCalendarEvents",
        description:
          "Search Google Calendar events visible to the requesting Slack user's connected Google account.",
        inputSchema: {
          query: "optional string event search terms",
          timeMin: "optional RFC3339 lower bound; defaults to now",
          timeMax: "optional RFC3339 upper bound",
          limit: "optional integer 1-20"
        }
      },
      {
        name: "google.searchMailMessages",
        description:
          "Search Gmail messages visible to the requesting Slack user's connected Google account.",
        inputSchema: {
          query: "string Gmail search query",
          limit: "optional integer 1-10"
        }
      },
      {
        name: "google.slidesSearchPresentations",
        description:
          "Search Google Slides presentations visible to the requesting Slack user's connected Google account.",
        inputSchema: {
          query: "optional string presentation title search terms",
          limit: "optional integer 1-20"
        }
      },
      {
        name: "google.slidesGetPresentation",
        description:
          "Read Google Slides presentation structure, slide text, speaker notes, and layout hints.",
        inputSchema: {
          presentationId: "string Google Slides presentation ID",
          includeSlides: "optional boolean; defaults to true"
        }
      },
      {
        name: "google.slidesProbeTemplate",
        description:
          "Inspect a Google Slides presentation as a reusable template: layouts, placeholders, masters, and theme metadata.",
        inputSchema: {
          presentationId: "string Google Slides presentation ID"
        }
      },
      {
        name: "google.slidesCopyPresentation",
        description:
          "Copy an existing Google Slides presentation into a new presentation. Use only when the user explicitly asks to create a new deck from a template.",
        inputSchema: {
          presentationId: "string source Google Slides presentation ID",
          name: "string name for the copied presentation"
        }
      },
      {
        name: "google.slidesCreateSlide",
        description:
          "Create a new slide in an existing Google Slides presentation, optionally using a layout or predefined layout, and optionally fill placeholders on the created slide.",
        inputSchema: {
          presentationId: "string Google Slides presentation ID to edit",
          objectId: "optional string caller-supplied object ID for the new slide",
          insertionIndex: "optional integer zero-based insertion index; use 2 to create slide 3",
          layoutObjectId:
            "optional string layout object ID from google.slidesGetPresentation or google.slidesProbeTemplate",
          predefinedLayout:
            "optional string Google predefined layout such as TITLE_AND_BODY or TITLE_AND_TWO_COLUMNS",
          replacements:
            "optional array of {placeholderType:string,text:string,index?:number} to fill on the created slide"
        }
      },
      {
        name: "google.slidesFillPlaceholders",
        description:
          "Fill text placeholders on an existing Google Slides presentation slide. When slideObjectId is omitted, Burble chooses the slide that best matches the requested placeholders. Use after copying a deck when the user asks to set title, subtitle, body, or similar placeholder text.",
        inputSchema: {
          presentationId: "string Google Slides presentation ID to edit",
          slideObjectId: "optional string slide object ID; omit to choose the best matching slide",
          replacements:
            "array of {placeholderType:string,text:string,index?:number}; placeholderType examples include TITLE and SUBTITLE"
        }
      },
      {
        name: "google.analyticsListProperties",
        description:
          "List Google Analytics GA4 properties available to the requesting Slack user's connected Google account.",
        inputSchema: {
          limit: "optional integer 1-20"
        }
      },
      {
        name: "google.analyticsGetMetadata",
        description:
          "List available Google Analytics dimensions and metrics for a GA4 property.",
        inputSchema: {
          propertyId: "string GA4 property id",
          dimensionQuery: "optional string filter for dimension API names or display names",
          metricQuery: "optional string filter for metric API names or display names",
          limit: "optional integer 1-20"
        }
      },
      {
        name: "google.analyticsRunReport",
        description:
          "Run a bounded read-only Google Analytics GA4 report for a property.",
        inputSchema: {
          propertyId: "string GA4 property id",
          startDate: "string date YYYY-MM-DD, today, yesterday, or NdaysAgo",
          endDate: "string date YYYY-MM-DD, today, yesterday, or NdaysAgo",
          metrics: "string[] metric API names",
          dimensions: "optional string[] dimension API names",
          limit: "optional integer 1-100"
        }
      }
    );
  }

  const hubspot = request.input.connections.hubspot;
  if (hubspot?.connected && hubspot.email) {
    catalog.push(
      {
        name: "hubspot.getAuthenticatedUser",
        description:
          "Return the HubSpot identity connected to the requesting Slack user.",
        inputSchema: {}
      },
      {
        name: "hubspot.searchContacts",
        description:
          "Search HubSpot CRM contacts visible to the requesting Slack user's connected HubSpot account.",
        inputSchema: {
          query: "optional string contact name, email, company, or other search terms",
          limit: "optional integer 1-20"
        }
      },
      {
        name: "hubspot.searchCompanies",
        description:
          "Search HubSpot CRM companies visible to the requesting Slack user's connected HubSpot account.",
        inputSchema: {
          query: "optional string company name, domain, or other search terms",
          limit: "optional integer 1-20"
        }
      },
      {
        name: "hubspot.searchDeals",
        description:
          "Search HubSpot CRM deals visible to the requesting Slack user's connected HubSpot account.",
        inputSchema: {
          query: "optional string deal name, company, contact, or other search terms",
          limit: "optional integer 1-20"
        }
      },
      {
        name: "hubspot.searchCrmObjects",
        description:
          "Search or list HubSpot CRM objects covered by the connected account's read scopes. Omit query for most-recent records.",
        inputSchema: {
          objectType:
            "appointments | carts | commercepayments | companies | contacts | courses | deals | goals | invoices | leads | line_items | listings | marketing_events | orders | partner-clients | partner-services | quotes | services | subscriptions | users",
          query: "optional string search terms",
          limit: "optional integer 1-20",
          properties: "optional array of property names"
        }
      },
      {
        name: "hubspot.listOwners",
        description: "List HubSpot CRM owners/users assignable to CRM records.",
        inputSchema: {
          limit: "optional integer 1-100",
          after: "optional paging cursor"
        }
      },
      {
        name: "hubspot.listUsers",
        description:
          "List users in the connected HubSpot account when settings.users.read was granted.",
        inputSchema: {
          limit: "optional integer 1-100",
          after: "optional paging cursor"
        }
      },
      {
        name: "hubspot.readApiResource",
        description:
          "Read a HubSpot API resource with GET for less common read-only HubSpot scopes when no first-class HubSpot tool exists.",
        inputSchema: {
          path: "HubSpot API path starting with /, for example /crm/v3/schemas/deals",
          query: "optional query string parameter object"
        }
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
          "Search Jira users visible to the requesting Slack user's connected Jira account. Use this to resolve assignee account IDs from names or emails. For named-person Jira questions, search users before asking who the person is.",
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
          "Search Jira issues visible to the requesting Slack user's connected Jira account. For a resolved named assignee, use that Jira accountId in JQL.",
        inputSchema: {
          jql: "string Jira JQL query, for example: assignee = currentUser() AND statusCategory != Done"
        }
      }
    );

    if (shouldLoadAtlassianMcpTools(request.input.text)) {
      catalog.push({
        name: "atlassian.listMcpTools",
        description:
          "List allowed upstream Atlassian MCP tools available through Burble for this user's Jira connection.",
        inputSchema: {}
      });
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

  return filterToolCatalogBySelectedGroups(request, {
    catalog,
    upstreamMcpSchemas
  });
}

function filterToolCatalogBySelectedGroups(
  request: RunRequest,
  catalogBuild: {
    catalog: ToolCatalogItem[];
    upstreamMcpSchemas: Record<string, unknown>;
  }
): {
  catalog: ToolCatalogItem[];
  upstreamMcpSchemas: Record<string, unknown>;
} {
  const selectedGroups = selectedRuntimeToolGroups(request);
  if (!selectedGroups) {
    return catalogBuild;
  }

  const catalog = catalogBuild.catalog.filter((tool) =>
    isRouteScopedControlPlaneTool(tool.name) ||
    isToolAllowedBySelectedGroups(tool.name, selectedGroups)
  );
  const allowedToolNames = new Set(catalog.map((tool) => tool.name));
  const upstreamMcpSchemas = Object.fromEntries(
    Object.entries(catalogBuild.upstreamMcpSchemas).filter(([name]) =>
      allowedToolNames.has(name) ||
      isToolAllowedBySelectedGroups(name, selectedGroups)
    )
  );

  return { catalog, upstreamMcpSchemas };
}

function selectedRuntimeToolGroups(
  request: RunRequest
): Set<RuntimeToolGroup> | null {
  const groups = request.input.toolGroups?.groups;
  if (!groups) {
    return null;
  }

  return new Set(groups);
}

function formatSelectedRuntimeToolGroups(request: RunRequest): string {
  const groups = selectedRuntimeToolGroups(request);
  return groups ? [...groups].join(",") || "none" : "legacy-all";
}

function isRouteScopedControlPlaneTool(toolName: string): boolean {
  return toolName === "scheduledJob.registerCapability";
}

function isToolAllowedBySelectedGroups(
  toolName: string,
  selectedGroups: Set<RuntimeToolGroup>
): boolean {
  return toolGroupsForToolName(toolName).some((group) =>
    selectedGroups.has(group)
  );
}

function toolGroupsForToolName(toolName: string): RuntimeToolGroup[] {
  if (toolName === "conversation.getAttachment") {
    return ["attachments"];
  }
  if (toolName.startsWith("scheduledJob.")) {
    return ["scheduler"];
  }
  if (toolName === "burble_provider_call" || toolName === "burble.providerCall") {
    return ["scheduler"];
  }
  if (toolName.startsWith("conversation.")) {
    return ["conversation"];
  }
  if (toolName.startsWith("github.") || toolName.startsWith("github_")) {
    return ["github"];
  }
  if (
    toolName.startsWith("google.") ||
    toolName.startsWith("google_") ||
    toolName.startsWith("gmail.") ||
    toolName.startsWith("gmail_")
  ) {
    return ["google"];
  }
  if (toolName.startsWith("hubspot.") || toolName.startsWith("hubspot_")) {
    return ["hubspot"];
  }
  if (
    toolName.startsWith("jira.") ||
    toolName.startsWith("jira_") ||
    toolName.startsWith("atlassian.") ||
    toolName.startsWith("atlassian_")
  ) {
    return ["jira"];
  }
  if (toolName.startsWith("slack.") || toolName.startsWith("slack_")) {
    return ["slack"];
  }
  if (
    toolName.startsWith("cron.") ||
    toolName.startsWith("cron_") ||
    toolName.startsWith("scheduler.") ||
    toolName.startsWith("scheduler_")
  ) {
    return ["scheduler"];
  }

  return [];
}

async function readDiscoveredProviderToolCatalog(
  request: RunRequest,
  executeTool: ToolExecutor
): Promise<{
  catalog: ToolCatalogItem[];
  upstreamMcpSchemas: Record<string, unknown>;
} | null> {
  let result: ToolResult;
  try {
    result = await executeTool("burble.mcp.listTools", {});
  } catch {
    return null;
  }

  if (!Array.isArray(result.content)) {
    return null;
  }

  const shouldIncludeAtlassian = shouldLoadAtlassianMcpTools(request.input.text);
  const catalog = result.content.flatMap((item): ToolCatalogItem[] => {
    const tool = readDiscoveredMcpTool(item);
    if (!tool) {
      return [];
    }

    const name = mcpToolNameToBurbleToolName(tool.name, request);
    if (!name || !isDiscoveredProviderToolAvailable(name, request)) {
      return [];
    }

    if (name.startsWith("atlassian.") && !shouldIncludeAtlassian) {
      return [];
    }

    return [
      {
        name,
        description:
          tool.description ??
          tool.title ??
          `Burble provider MCP tool ${tool.name}`,
        inputSchema: tool.inputSchema ?? {}
      }
    ];
  });

  const upstreamMcpSchemas: Record<string, unknown> = {};
  if (
    shouldIncludeAtlassian &&
    catalog.some((tool) => tool.name === "atlassian.callMcpTool") &&
    request.input.connections.jira?.email
  ) {
    const upstreamTools = await readAtlassianMcpToolSummaries(
      request.input.connections.jira.email,
      executeTool
    );
    Object.assign(upstreamMcpSchemas, upstreamTools.inputSchemas);
    const callTool = catalog.find((tool) => tool.name === "atlassian.callMcpTool");
    if (callTool && upstreamTools.summaries.length > 0) {
      callTool.description = [
        callTool.description,
        `Known allowed upstream Atlassian MCP tools include: ${upstreamTools.summaries.slice(0, 30).join("; ")}.`
      ].join(" ");
    }
  }

  if (catalog.length === 0 && hasConnectedProvider(request)) {
    return null;
  }

  return { catalog, upstreamMcpSchemas };
}

function readDiscoveredMcpTool(value: unknown): {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string" || !record.name.trim()) {
    return null;
  }

  return {
    name: record.name,
    ...(typeof record.title === "string" ? { title: record.title } : {}),
    ...(typeof record.description === "string"
      ? { description: record.description }
      : {}),
    ...(record.inputSchema &&
    typeof record.inputSchema === "object" &&
    !Array.isArray(record.inputSchema)
      ? { inputSchema: record.inputSchema as Record<string, unknown> }
      : {})
  };
}

function mcpToolNameToBurbleToolName(
  name: string,
  request: RunRequest
): string | null {
  const manifestToolName = manifestMcpToolNameToBurbleToolName(name, request);
  if (manifestToolName) {
    return manifestToolName;
  }

  return null;
}

function manifestMcpToolNameToBurbleToolName(
  name: string,
  request: RunRequest
): string | null {
  const tools = request.runtime?.manifest?.tools;
  if (!tools) {
    return null;
  }

  const tool = tools.find((entry) => entry.enabled !== false && entry.name === name);
  return tool?.alias ?? null;
}

export const __openClawCliProviderToolMappingTestHooks = {
  manifestMcpToolNameToBurbleToolName,
  mcpToolNameToBurbleToolName
};

function isDiscoveredProviderToolAvailable(
  toolName: string,
  request: RunRequest
): boolean {
  if (toolName.startsWith("github.")) {
    return request.input.connections.github.connected &&
      Boolean(request.input.connections.github.email);
  }
  if (toolName.startsWith("google.")) {
    return Boolean(
      request.input.connections.google?.connected &&
        request.input.connections.google.email
    );
  }
  if (toolName.startsWith("hubspot.")) {
    return Boolean(
      request.input.connections.hubspot?.connected &&
        request.input.connections.hubspot.email
    );
  }
  if (toolName.startsWith("jira.") || toolName.startsWith("atlassian.")) {
    return Boolean(
      request.input.connections.jira?.connected &&
        request.input.connections.jira.email
    );
  }
  if (toolName.startsWith("slack.")) {
    return Boolean(
      request.input.connections.slack?.connected &&
        request.input.connections.slack.email
    );
  }

  return false;
}

function hasConnectedProvider(request: RunRequest): boolean {
  return Boolean(
    (request.input.connections.github.connected &&
      request.input.connections.github.email) ||
      (request.input.connections.google?.connected &&
        request.input.connections.google.email) ||
      (request.input.connections.hubspot?.connected &&
        request.input.connections.hubspot.email) ||
      (request.input.connections.jira?.connected &&
        request.input.connections.jira.email) ||
      (request.input.connections.slack?.connected &&
        request.input.connections.slack.email)
  );
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
  return (
    toolName === "github.createIssue" ||
    toolName === "github.updateIssue" ||
    toolName === "github.closeIssue" ||
    toolName === "github.reopenIssue" ||
    toolName === "github.commentOnIssueOrPullRequest" ||
    toolName === "github.createPullRequest" ||
    toolName === "github.updatePullRequest" ||
    toolName === "github.addLabels" ||
    toolName === "github.removeLabels" ||
    toolName === "github.requestReview" ||
    toolName === "github.createOrUpdateFile" ||
    toolName === "github.createBranch" ||
    toolName === "jira.createIssue" ||
    toolName === "jira.editIssue" ||
    toolName === "jira.updateIssue" ||
    toolName === "jira.addComment" ||
    toolName === "jira.transitionIssue" ||
    toolName === "jira.addLabels" ||
    toolName === "jira.removeLabels" ||
    toolName === "jira.linkIssues" ||
    toolName === "jira.createSubtask" ||
    toolName === "google.createDriveTextFile" ||
    toolName === "google.updateDriveTextFile" ||
    toolName === "google.appendDriveTextFile" ||
    toolName === "google.appendToDriveTextFile" ||
    toolName === "google.createDriveFolder" ||
    toolName === "google.moveDriveFile" ||
    toolName === "google.createCalendarEvent" ||
    toolName === "google.updateCalendarEvent" ||
    toolName === "gmail.createDraft"
  );
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

function formatEnabledRuntimeSkills(request: RunRequest): string {
  const skills = effectiveRuntimeSkills(request);
  return skills
    .map((skill) => preloadedRuntimeSkillText[skill.id])
    .filter(Boolean)
    .join("\n\n");
}

function effectiveRuntimeSkills(
  request: RunRequest
): Array<{ id: PreloadedRuntimeSkillName; version: string; enabled: boolean }> {
  const selectedGroups = selectedRuntimeToolGroups(request);
  const manifestSkills = request.runtime?.manifest?.skills;
  if (!manifestSkills || manifestSkills.length === 0) {
    return filterRuntimeSkillsBySelectedGroups(
      defaultPreloadedRuntimeSkills,
      selectedGroups
    );
  }

  const enabledManifestSkills = manifestSkills.flatMap((skill) => {
    if (
      skill.enabled &&
      isPreloadedRuntimeSkillName(skill.id)
    ) {
      return [
        {
          id: skill.id,
          version: skill.version,
          enabled: true
        }
      ];
    }
    return [];
  });
  return filterRuntimeSkillsBySelectedGroups(
    enabledManifestSkills,
    selectedGroups
  );
}

function filterRuntimeSkillsBySelectedGroups(
  skills: Array<{
    id: PreloadedRuntimeSkillName;
    version: string;
    enabled: boolean;
  }>,
  selectedGroups: Set<RuntimeToolGroup> | null
): Array<{ id: PreloadedRuntimeSkillName; version: string; enabled: boolean }> {
  if (!selectedGroups) {
    return skills;
  }

  return skills.filter((skill) => {
    const group = runtimeToolGroupForSkill(skill.id);
    return group ? selectedGroups.has(group) : true;
  });
}

function runtimeToolGroupForSkill(
  skillId: PreloadedRuntimeSkillName
): RuntimeToolGroup | null {
  switch (skillId) {
    case "core":
      return "conversation";
    case "github":
      return "github";
    case "atlassian-jira":
      return "jira";
    default:
      return null;
  }
}

function isPreloadedRuntimeSkillName(
  value: string
): value is PreloadedRuntimeSkillName {
  return preloadedRuntimeSkillNames.includes(value as PreloadedRuntimeSkillName);
}

function formatRuntimePolicyContext(request: RunRequest): string[] {
  const manifest = request.runtime?.manifest;
  if (!manifest) {
    return [];
  }

  const enabledSkills = effectiveRuntimeSkills(request)
    .map((skill) => `${skill.id}@${skill.version}`)
    .join(", ");
  const memoryContext = manifest.memoryContext ?? [];
  const memoryContextLines =
    memoryContext.length === 0
      ? ["- memory context: none"]
      : [
          "- memory context:",
          ...memoryContext.map((entry) => {
            const owner = entry.ownerId || "workspace";
            return `  - ${entry.scope}:${owner}:${entry.key} = ${entry.valuePreview}`;
          })
        ];
  return [
    "Runtime policy manifest:",
    `- policyHash: ${manifest.policyHash}`,
    `- enabled bundled skills: ${enabledSkills || "none"}`,
    `- memory.user: ${manifest.memory.userMemoryEnabled ? "enabled" : "disabled"}`,
    `- memory.workspace: ${manifest.memory.workspaceMemoryEnabled ? "enabled" : "disabled"}`,
    `- memory.jobs: ${manifest.memory.jobMemoryEnabled ? "enabled" : "disabled"}`,
    ...memoryContextLines,
    "Skills and memory settings are advisory context only; they do not grant provider tools or override Available Burble tools.",
    "When a Burble provider tool returns an error object with a message, explain that message in normal Slack text; do not print raw JSON."
  ];
}

function truncate(value: string | undefined, maxLength: number): string {
  if (!value) {
    return "";
  }

  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength - 3)}...`;
}

function buildPlanningPrompt(
  config: RuntimeConfig,
  request: RunRequest,
  toolContext: BurbleToolContext,
  executedTools: ExecutedToolCall[] = [],
  rejectedDirectResponses: string[] = []
): string {
  if (config.engine === "burble-direct") {
    return buildBurbleDirectPrompt(
      request,
      toolContext,
      executedTools,
      rejectedDirectResponses
    );
  }

  return buildOpenClawPrompt(
    config,
    request,
    toolContext,
    executedTools,
    rejectedDirectResponses
  );
}

function buildOpenClawPrompt(
  config: RuntimeConfig,
  request: RunRequest,
  toolContext: BurbleToolContext,
  executedTools: ExecutedToolCall[] = [],
  rejectedBootstrapResponses: string[] = []
): string {
  const sections = [
    "Preloaded Burble runtime skills:",
    formatEnabledRuntimeSkills(request),
    "",
    "Do not run first-time assistant setup. Do not ask who you are, who the user is, what kind of assistant you are, what style you should use, or for an emoji/persona setup. Do not mention bootstrap-pending, bootstrap blockers, setup state, defaults, name/nature/vibe/emoji, or workspace bootstrap. The Slack user and assistant identity are already established by Burble.",
    "",
    "Runtime instruction: for requests about the current Slack channel or chat, answer from Recent Slack context when available. If channel history is unavailable, explain that Burble needs Slack bot history scopes and channel membership.",
    "",
    ...formatRuntimePolicyContext(request),
    "",
    "Available Burble tools:",
    formatToolCatalog(toolContext.catalog),
    "",
    ...formatNativeExecutionContext(config, request),
    "",
    ...formatRecentSlackContext(request),
    ...formatRequestAttachments(request),
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
    if (rejectedBootstrapResponses.length > 0) {
      sections.push(
        "",
        "Previous response was rejected because it asked for assistant/user setup instead of answering the request:",
        truncate(rejectedBootstrapResponses.at(-1) ?? "", 600),
        "Do not repeat setup/onboarding. Answer the current user request directly or use an available tool."
      );
    }
    sections.push("", formatFinalInstruction(request));
  }

  return sections.join("\n");
}

function formatRequestAttachments(request: RunRequest): string[] {
  const attachments = request.input.attachments ?? [];
  if (attachments.length === 0) {
    return [];
  }

  return [
    "Current request attachments:",
    ...attachments.map((attachment) => {
      const details = [
        `id=${attachment.id}`,
        `kind=${attachment.kind}`,
        `mime=${attachment.mimeType}`,
        `source=${attachment.source}`,
        ...(attachment.name ? [`name=${attachment.name}`] : []),
        ...(typeof attachment.sizeBytes === "number"
          ? [`sizeBytes=${attachment.sizeBytes}`]
          : []),
        ...(attachment.externalId ? [`externalId=${attachment.externalId}`] : [])
      ];
      return `- ${details.join(" ")}`;
    }),
    ""
  ];
}

function formatNativeExecutionContext(
  config: RuntimeConfig,
  request: RunRequest
): string[] {
  if (!isNativeRuntimeExecutionMode(request)) {
    return [];
  }

  return [
    "Native agent execution:",
    "This request explicitly asks for native runtime execution. Use native capabilities/tools directly when useful for code, shell/process work, cron, or long-running tasks. Use Burble JSON tool_call only for external provider data or actions listed in Available Burble tools.",
    ...formatActiveConversationRouteInstruction(config, request),
    ...formatScheduledProviderCapabilityInstruction(request),
    ...formatScheduledJobContextInstruction(request),
    "When native code tools are available, you can run programs in this runtime. Do not say you cannot run arbitrary programs, cannot run code, or can only provide a local script; use native exec instead.",
    "For code execution tasks, prefer one deliberate exec call for the main work. If that exec succeeds and prints the requested result, summarize it and stop. Do not repeatedly rewrite, rerun, or optimize code after the requested result is available.",
    "For duration or long-running tests, run exactly one timed program for the requested duration, then report its stdout/stderr summary and final observed result."
  ];
}

function formatScheduledJobContextInstruction(request: RunRequest): string[] {
  const scheduledJob = request.input.scheduledJob;
  if (!scheduledJob) {
    return [];
  }

  const allowedTools = [...new Set(scheduledJob.allowedTools)].sort().join(",");
  const lines = [
    "Scheduled Burble job context:",
    `- jobId=${scheduledJob.jobId}`,
    `- capabilityProfile=${scheduledJob.capabilityProfile}`,
    `- allowedTools=${allowedTools}`,
    ...(scheduledJob.routeId ? [`- routeId=${scheduledJob.routeId}`] : []),
    ...(scheduledJob.runtimeType
      ? [`- runtimeType=${scheduledJob.runtimeType}`]
      : []),
    `- maxOutputVisibility=${scheduledJob.visibilityPolicy.maxOutputVisibility ?? "user_private"}`,
    `- allowPrivateToolDeclassification=${scheduledJob.visibilityPolicy.allowPrivateToolDeclassification === true ? "true" : "false"}`,
    ...scheduledJob.stateRefs.map((stateRef) => {
      const parts = [
        `provider=${stateRef.provider}`,
        `kind=${stateRef.kind}`,
        ...(stateRef.id ? [`id=${stateRef.id}`] : []),
        ...(stateRef.name ? [`name=${stateRef.name}`] : []),
        ...(stateRef.purpose ? [`purpose=${stateRef.purpose}`] : [])
      ];
      return `- stateRef ${parts.join(" ")}`;
    })
  ];

  lines.push(
    "For this scheduled job, use only the listed allowedTools for Burble provider calls. Treat stateRefs as durable job state locations supplied by Burble.",
    "Respect maxOutputVisibility when sending scheduled output. Do not publicly post private-tool-derived content unless allowPrivateToolDeclassification is true and the user explicitly asked for that behavior."
  );

  return lines;
}

function formatScheduledProviderCapabilityInstruction(
  request: RunRequest
): string[] {
  const routeId = request.input.conversation?.routeId;
  if (!routeId) {
    return [];
  }

  if (!selectedRuntimeToolGroups(request)?.has("scheduler")) {
    return [
      "Scheduled provider tool registration guard:",
      "If this turn creates, updates, enables, or manually triggers a native scheduled/background job that will use Burble provider tools or post scheduled output through Burble, call scheduledJob.registerCapability after the native scheduler returns the stable job id and before enabling or triggering that job."
    ];
  }

  return [
    "Scheduled provider tool registration:",
    "Setup-time provider calls are not scheduled provider calls. If you need to create, find, read, or validate durable provider state during the current user turn, use ordinary Burble provider calls for the active conversation and do not include jobId.",
    "Never invent placeholder job ids for setup-time provider calls. jobId is only valid after the native scheduler has returned a stable job id and scheduledJob.registerCapability has returned ok for that exact id.",
    `If a native cron/background job will use Burble provider tools such as GitHub, Jira, Google, or Slack search, first call scheduledJob.registerCapability with routeId "${routeId}", requiredTools set to the exact Burble provider tool names the job will use, and stateRefs for any durable state files it should read or update.`,
    'A Slack channel label, Slack mention, Slack channel id, or guessed convrt_* value is not a delivery route. Never set native delivery.to to values like "#eng", "<#C123|eng>", "C123", "G123", or "convrt_<guess>".',
    'If the user explicitly asks scheduled output to post to a granted Slack channel, pass destination with the channel mention/name/id (for example "#eng" or "<#C123|eng>") to scheduledJob.registerCapability instead of inventing or copying a routeId. Burble resolves destination only when that user has already authorized the channel with /agent grant here.',
    'Because Slack channel delivery is public to that channel, include visibilityPolicy {"maxOutputVisibility":"public","allowPrivateToolDeclassification":true} only when the user explicitly asked scheduled output to post there.',
    "After scheduledJob.registerCapability returns ok for a Slack destination, use only the returned scheduledJob.routeId / routeId convrt_* value as native delivery.to. Do not use the original destination label in native delivery.",
    'stateRefs entries must be objects, not compact strings. Each entry must include provider and kind strings, for example {"provider":"google","kind":"drive_file","id":"<fileId>","purpose":"dedupe_state"}.',
    "When creating a new provider-backed native job, do not request an immediate/manual run as part of the create call. Create it paused/disabled or without an immediate trigger if the scheduler supports that; otherwise create it, then stop before triggering.",
    "After the native scheduler returns the stable job id, call scheduledJob.registerCapability with that exact jobId and wait for an ok result. If registration does not return ok, do not trigger the job and report the registration failure.",
    "Include the returned scheduledPromptInstruction verbatim in the native scheduled job prompt.",
    "Only after the job prompt has been updated with the returned scheduledPromptInstruction may you enable, manually trigger, or reschedule the job.",
    "Scheduled provider tool calls must include the returned jobId in each Burble provider tool input. Do not use routeId as provider-call identity; routeId is only a delivery/state binding.",
    "Provider-backed scheduled job repair: before manually triggering, enabling, or rescheduling an existing native job, inspect whether it uses provider-backed state, authenticated provider resources, or Burble channel delivery. If it does and its prompt lacks Burble jobId provider-call instructions or its delivery target is not a resolved convrt_* route, update the job first by calling scheduledJob.registerCapability and rewriting the scheduled prompt/delivery to use the returned Burble instructions and route. The job must not use direct web/browser access to provider URLs for authenticated provider work."
  ];
}

function formatActiveConversationRouteInstruction(
  _config: RuntimeConfig,
  request: RunRequest
): string[] {
  const routeId = request.input.conversation?.routeId;
  if (!routeId) {
    return [];
  }

  return [
    `Active Burble conversation channel route: ${routeId}.`,
    `Native Burble channel delivery is installed. For cron/background jobs whose requested destination is this active conversation, set delivery.mode to "announce", delivery.channel to "burble", and delivery.to to "${routeId}". The scheduled prompt should produce the final Slack-ready message text; Burble resolves the route to the actual transport outside the runtime.`,
    'If the user names a different Slack destination such as "#eng", "<#C123|eng>", or a channel id, do not use the active conversation route and do not put the Slack label in delivery.to. First call scheduledJob.registerCapability with destination set to that label and visibilityPolicy {"maxOutputVisibility":"public","allowPrivateToolDeclassification":true}, then set delivery.to to the returned convrt_* route. If registration does not return ok with a resolved route, do not update, enable, or trigger the job.',
    `For an immediate request to send, post, message, or report something here now, do not create a cron job or background job unless the user explicitly asks for a schedule, delay, recurrence, or later delivery. Produce the final Slack-ready message once and stop.`,
    "Do not fetch, POST to, or mention local/private/internal Burble URLs for delivery. Do not create cron jobs that rely on conversation.sendMessage JSON blobs, announce delivery, Slack channel IDs, Slack credentials, or Burble credentials. Burble's channel connector owns route auth and transport delivery outside the OpenClaw process."
  ];
}

function formatFinalInstruction(request: RunRequest): string {
  if (isNativeRuntimeExecutionMode(request)) {
    return "For provider data/actions, return exactly one Burble tool_call JSON object if required. Otherwise use native runtime capabilities when appropriate, avoid unnecessary extra tool loops, and return the final Slack-ready answer as soon as the requested result is available.";
  }

  return "Return either exactly one tool_call JSON object or the final Slack-ready answer.";
}

function buildBurbleDirectPrompt(
  request: RunRequest,
  toolContext: BurbleToolContext,
  executedTools: ExecutedToolCall[] = [],
  rejectedDirectResponses: string[] = []
): string {
  const sections = [
    "Burble direct runtime instructions:",
    [
      "You are Burble, a Slack assistant running inside Burble's runtime.",
      "The requesting Slack user is already authenticated through Burble connections; do not ask who you are, who the user is, what kind of assistant you are, what vibe you should have, or for an emoji/persona setup.",
      "Interpret me, my, and assign to me as the requesting Slack user.",
      "Use Recent Slack context to resolve pronouns and short follow-ups such as 'look him up'.",
      "For requests about the current Slack channel or chat, answer from Recent Slack context when available. If channel history is unavailable, explain that Burble needs Slack bot history scopes and channel membership.",
      "The Burble tool gateway injects the connected provider identity and credentials; do not include emails, tokens, or credentials in tool arguments.",
      "For provider data or actions, return exactly one JSON object and no prose: {\"tool_call\":{\"name\":\"tool.name\",\"arguments\":{}}}.",
      "Use only tool names listed in Available Burble tools.",
      "For Jira assign-to-me requests, call jira.getAuthenticatedUser when you need the requester's Jira accountId, then call jira.editIssue with assigneeAccountId.",
      "For Jira questions involving a named person, call jira.searchUsers with the exact name or email before asking who they are. If the current request uses him/her/them, use the most recent named person in Recent Slack context.",
      "For Jira tickets assigned to a resolved person, call jira.searchIssues with that person's Jira accountId in JQL. If the user asks who they assigned to that person, state that the result reflects current visible assignee unless Jira changelog data is explicitly available.",
      "For Slack questions about what someone said, call slack.searchMessages. For 'what did I say about X', pass the requesting Slack user ID as fromUserId. For named Slack people, call slack.searchUsers first if you need their Slack user ID.",
      "For Google Drive, Calendar, Gmail, Slides, or Analytics questions, call the matching google.* Burble provider tool listed in Available Burble tools.",
      "For HubSpot CRM questions about users, owners, contacts, companies, deals, or other scoped CRM objects, call the matching HubSpot tool. Use hubspot.listUsers for account users, hubspot.listOwners for assignable CRM owners, hubspot.searchCrmObjects for other CRM object types, and hubspot.readApiResource only for less common read-only HubSpot API resources with no first-class tool.",
      "For final answers, return concise Slack mrkdwn."
    ].join(" "),
    "",
    ...formatRuntimePolicyContext(request),
    "",
    "Available Burble tools:",
    formatToolCatalog(toolContext.catalog),
    "",
    ...formatRecentSlackContext(request),
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

  if (rejectedDirectResponses.length > 0) {
    sections.push(
      "",
      "Rejected previous provider response:",
      truncate(rejectedDirectResponses.at(-1), 600),
      "",
      "The rejected response asked for assistant/user bootstrap setup. That is invalid in Burble direct mode. Do not repeat it; return a valid tool_call JSON object or final Slack-ready answer."
    );
  }

  return sections.join("\n");
}

function formatRecentSlackContext(request: RunRequest): string[] {
  const allMessages = request.input.context?.recentMessages ?? [];
  const messages = allMessages.slice(-maxRecentSlackContextMessages);
  const currentChannel = request.input.context?.currentChannel;
  if (!currentChannel && allMessages.length === 0) {
    return [];
  }

  const lines = [
    ...(currentChannel
      ? [
          `Current Slack channel ID: ${currentChannel.id}`,
          `Current Slack channel type: ${currentChannel.isDirectMessage ? "direct_message" : "channel"}`,
          `Current Slack channel history: ${
            currentChannel.historyAvailable
              ? formatRecentSlackHistoryStatus(messages.length, allMessages.length)
              : `unavailable (${currentChannel.historyError ?? "unknown_error"})`
          }`
        ]
      : []),
    ...(messages.length > 0 ? ["Recent Slack context (oldest to newest):"] : []),
    ...messages.map(
      (message) =>
        `${formatSlackContextAuthor(message)}: ${truncate(message.text, maxRecentSlackContextMessageChars)}`
    )
  ];

  return lines;
}

function formatRecentSlackHistoryStatus(included: number, total: number): string {
  if (included === total) {
    return `available (${included} recent messages)`;
  }

  return `available (${included} of ${total} recent messages included)`;
}

function formatSlackContextAuthor(
  message: NonNullable<RunRequest["input"]["context"]>["recentMessages"][number]
): string {
  if (message.author === "assistant") {
    return "Burble";
  }

  return message.speaker ? `Slack user ${message.speaker}` : "User";
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

function isBootstrapSetupAnswer(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    /\bbootstrap blocker\b/.test(normalized) ||
    /\bbootstrap-pending\b/.test(normalized) ||
    /\bworkspace bootstrap\b/.test(normalized) ||
    /\bsetup\/onboarding\b/.test(normalized) ||
    /\bwho am i\b/.test(normalized) ||
    /\bwho are you\b/.test(normalized) ||
    /\bidentity setup\b/.test(normalized) ||
    /\bbootstrap\b/.test(normalized) ||
    /\bsignature emoji\b/.test(normalized) ||
    /\bwhat vibe\b/.test(normalized) ||
    /\bwhat kind of assistant\b/.test(normalized) ||
    /\bi just came online\b/.test(normalized)
  );
}

function sanitizeBootstrapFragments(text: string, fallbackText: string = text): string {
  if (!isBootstrapSetupAnswer(text)) {
    return text;
  }

  const paragraphs = text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const kept = paragraphs.filter((paragraph) => !isBootstrapSetupAnswer(paragraph));
  if (kept.length === 0) {
    return fallbackText;
  }

  return kept.join("\n\n");
}

function readPlannedToolCall(
  stdout: string,
  catalog: ToolCatalogItem[]
): PlannedToolCall | null {
  const strippedProtocol = stripRuntimeToolCallProtocolFragments(stdout).trim();
  if (strippedProtocol && strippedProtocol !== stdout.trim()) {
    return null;
  }

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
  if (
    toolCall.name === "conversation.sendMessage" ||
    toolCall.name === "conversation.getAttachment" ||
    toolCall.name === "scheduledJob.registerCapability" ||
    toolCall.name === "burble_provider_call" ||
    toolCall.name === "burble.providerCall"
  ) {
    const validationError = validatePlannedToolCall(toolCall, toolContext);
    if (validationError) {
      return validationError;
    }

    return executeTool(toolCall.name, {
      input: toolCall.arguments
    });
  }

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

  if (toolName.startsWith("slack.")) {
    return request.input.connections.slack?.email ?? null;
  }

  if (toolName.startsWith("google.")) {
    return request.input.connections.google?.email ?? null;
  }

  if (toolName.startsWith("hubspot.")) {
    return request.input.connections.hubspot?.email ?? null;
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
    const verb =
      toolName === "jira.editIssue" ||
      toolName === "jira.updateIssue" ||
      toolName === "jira.transitionIssue" ||
      toolName === "jira.addLabels" ||
      toolName === "jira.removeLabels"
        ? "Updated"
        : "Created";
    return `${verb} Jira issue ${issue.key}: ${issue.title}\n${issue.url}`;
  }

  const driveFile = readDriveFileResult(result.content);
  if (driveFile) {
    const verb =
      toolName === "google.updateDriveTextFile" ||
      toolName === "google.appendDriveTextFile" ||
      toolName === "google.appendToDriveTextFile" ||
      toolName === "google.moveDriveFile"
        ? "Updated"
        : "Created";
    return driveFile.webViewLink
      ? `${verb} Google Drive file ${driveFile.name}: ${driveFile.webViewLink}`
      : `${verb} Google Drive file ${driveFile.name}.`;
  }

  const githubWrite = readGitHubWriteResult(result.content);
  if (githubWrite) {
    switch (toolName) {
      case "github.createIssue":
        return `Created GitHub issue #${githubWrite.number}: ${githubWrite.title}\n${githubWrite.url}`;
      case "github.updateIssue":
        return `Updated GitHub issue #${githubWrite.number}: ${githubWrite.title}\n${githubWrite.url}`;
      case "github.closeIssue":
        return `Closed GitHub issue #${githubWrite.number}: ${githubWrite.title}\n${githubWrite.url}`;
      case "github.reopenIssue":
        return `Reopened GitHub issue #${githubWrite.number}: ${githubWrite.title}\n${githubWrite.url}`;
      case "github.commentOnIssueOrPullRequest":
        return `Added GitHub comment: ${githubWrite.url}`;
      case "github.createPullRequest":
        return `Created GitHub PR #${githubWrite.number}: ${githubWrite.title}\n${githubWrite.url}`;
      case "github.updatePullRequest":
        return `Updated GitHub PR #${githubWrite.number}: ${githubWrite.title}\n${githubWrite.url}`;
      case "github.addLabels":
        return `Added GitHub labels on #${githubWrite.number}: ${githubWrite.url}`;
      case "github.removeLabels":
        return `Removed GitHub labels from #${githubWrite.number}: ${githubWrite.url}`;
      case "github.requestReview":
        return `Requested GitHub review on PR #${githubWrite.number}: ${githubWrite.title}\n${githubWrite.url}`;
      case "github.createOrUpdateFile":
        return `Created or updated GitHub file.`;
      case "github.createBranch":
        return `Created GitHub branch.`;
    }
  }

  if (toolName === "gmail.createDraft") {
    return "Created Gmail draft.";
  }

  return formatToolResult(result);
}

function readGitHubWriteResult(
  value: unknown
): { title?: string; url: string; number?: number; id?: number } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.url !== "string") {
    return null;
  }
  return {
    url: record.url,
    ...(typeof record.title === "string" ? { title: record.title } : {}),
    ...(typeof record.number === "number" ? { number: record.number } : {}),
    ...(typeof record.id === "number" ? { id: record.id } : {})
  };
}

function readDriveFileResult(
  value: unknown
): { name: string; webViewLink?: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string") {
    return null;
  }
  return {
    name: record.name,
    ...(typeof record.webViewLink === "string"
      ? { webViewLink: record.webViewLink }
      : {})
  };
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

function addRunUsage(
  current: RunUsage | undefined,
  next: RunUsage | undefined
): RunUsage | undefined {
  if (!next) {
    return current;
  }

  return {
    inputTokens: addOptionalUsageNumber(current?.inputTokens, next.inputTokens),
    outputTokens: addOptionalUsageNumber(current?.outputTokens, next.outputTokens),
    totalTokens: addOptionalUsageNumber(current?.totalTokens, next.totalTokens),
    cachedInputTokens: addOptionalUsageNumber(
      current?.cachedInputTokens,
      next.cachedInputTokens
    ),
    reasoningTokens: addOptionalUsageNumber(
      current?.reasoningTokens,
      next.reasoningTokens
    )
  };
}

function addRunTelemetry(
  current: RunTelemetry | undefined,
  next: RunTelemetry | undefined
): RunTelemetry | undefined {
  if (!next) {
    return current;
  }

  return {
    promptChars: addOptionalUsageNumber(current?.promptChars, next.promptChars),
    promptApproxTokens: addOptionalUsageNumber(
      current?.promptApproxTokens,
      next.promptApproxTokens
    ),
    steps: [...(current?.steps ?? []), ...(next.steps ?? [])]
  };
}

function addOptionalUsageNumber(
  current: number | undefined,
  next: number | undefined
): number | undefined {
  if (typeof current !== "number") {
    return next;
  }
  if (typeof next !== "number") {
    return current;
  }
  return current + next;
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
  sessionId: string,
  logInfo: RuntimeLogger,
  startedAt?: number
): RunUsageTelemetryResult {
  const selectedGatewayDiagnostics = selectGatewayDiagnosticsForSession(
    gatewayDiagnostics,
    sessionId
  );
  const output = [
    stdout,
    stderr,
    rawStream ?? "",
    selectedGatewayDiagnostics
  ].join("\n");
  const usage = readModelUsage(output);
  const diagnostics = summarizeModelDiagnostics(output);
  const promptApproxTokens = estimateTokens(prompt);
  const rawStreamBytes = rawStream ? new TextEncoder().encode(rawStream).length : 0;
  logInfo(
    [
      `OpenClaw usage runId=${request.runId ?? "unknown"}`,
      `step=${step}`,
      `promptApproxTokens=${promptApproxTokens}`,
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
      `rawStreamBytes=${rawStreamBytes}`
    ].join(" ")
  );
  const phaseTimings = summarizeGatewayPhaseTimings(
    selectedGatewayDiagnostics,
    startedAt
  );
  if (phaseTimings) {
    logInfo(
      [
        `OpenClaw gateway phase timings runId=${request.runId ?? "unknown"}`,
        `step=${step}`,
        `requestToLaneMs=${formatUsageNumber(phaseTimings.requestToLaneMs)}`,
        `laneWaitMs=${formatUsageNumber(phaseTimings.laneWaitMs)}`,
        `laneToRunStartMs=${formatUsageNumber(phaseTimings.laneToRunStartMs)}`,
        `runStartToPromptMs=${formatUsageNumber(phaseTimings.runStartToPromptMs)}`,
        `promptToProviderMs=${formatUsageNumber(phaseTimings.promptToProviderMs)}`,
        `providerToFirstEventMs=${formatUsageNumber(phaseTimings.providerToFirstEventMs)}`,
        `providerStreamMs=${formatUsageNumber(phaseTimings.providerStreamMs)}`,
        `providerElapsedMs=${formatUsageNumber(phaseTimings.providerElapsedMs)}`,
        `gatewayRunDurationMs=${formatUsageNumber(phaseTimings.gatewayRunDurationMs)}`,
        `systemPromptChars=${formatUsageNumber(phaseTimings.systemPromptChars)}`,
        `gatewayPromptChars=${formatUsageNumber(phaseTimings.gatewayPromptChars)}`,
        `historyTextChars=${formatUsageNumber(phaseTimings.historyTextChars)}`
      ].join(" ")
    );
  }
  const telemetry = {
    promptChars: prompt.length,
    promptApproxTokens,
    steps: [
      {
        step,
        promptChars: prompt.length,
        promptApproxTokens,
        usageSource: usage ? "provider-output" : "estimate-only",
        modelDiagnostics: {
          modelStarts: diagnostics.modelStarts,
          fetchStarts: diagnostics.fetchStarts,
          streamDone: diagnostics.streamDone,
          streamDoneElapsedMs: diagnostics.streamDoneElapsedMs,
          streamDoneEvents: diagnostics.streamDoneEvents,
          compactions: diagnostics.compactions,
          exactUsageFields: diagnostics.exactUsageFields,
          exactUsageAvailable: diagnostics.exactUsageFields > 0,
          rawStreamBytes
        },
        ...(phaseTimings ? { phaseTimings } : {})
      }
    ]
  } satisfies RunTelemetry;
  return { ...(usage ? { usage } : {}), telemetry };
}

function selectGatewayDiagnosticsForSession(
  gatewayDiagnostics: string,
  sessionId: string
): string {
  if (!gatewayDiagnostics) {
    return "";
  }

  const lines = gatewayDiagnostics.split(/\r?\n/);
  const selected: string[] = [];
  let inTargetSession = false;
  let sawEmbeddedSession = false;
  let sawTargetSession = false;

  for (const line of lines) {
    if (line.includes("[agent/embedded] embedded run start:")) {
      sawEmbeddedSession = true;
      inTargetSession = line.includes(`sessionId=${sessionId}`) || line.includes(sessionId);
      if (inTargetSession) {
        sawTargetSession = true;
        selected.push(line);
      }
      continue;
    }

    if (!inTargetSession && line.includes(sessionId)) {
      sawTargetSession = true;
      selected.push(line);
      continue;
    }

    if (!inTargetSession) {
      continue;
    }

    selected.push(line);
    if (
      line.includes("[agent/embedded] embedded run done:") &&
      (line.includes(`sessionId=${sessionId}`) || line.includes(sessionId))
    ) {
      inTargetSession = false;
    }
  }

  if (sawTargetSession) {
    return selected.join("\n");
  }

  return sawEmbeddedSession ? "" : gatewayDiagnostics;
}

type GatewayLogEvent = {
  timestampMs: number;
  text: string;
};

type GatewayPhaseTimings = {
  requestToLaneMs?: number;
  laneWaitMs?: number;
  laneToRunStartMs?: number;
  runStartToPromptMs?: number;
  promptToProviderMs?: number;
  providerToFirstEventMs?: number;
  providerStreamMs?: number;
  providerElapsedMs?: number;
  gatewayRunDurationMs?: number;
  systemPromptChars?: number;
  gatewayPromptChars?: number;
  historyTextChars?: number;
};

function summarizeGatewayPhaseTimings(
  gatewayDiagnostics: string,
  requestStartedAt?: number
): GatewayPhaseTimings | null {
  const events = readGatewayLogEvents(gatewayDiagnostics);
  if (events.length === 0) {
    return null;
  }

  const laneEnqueue = findGatewayEvent(events, "[diagnostic] lane enqueue:");
  const laneDequeue = findGatewayEvent(events, "[diagnostic] lane dequeue:");
  const embeddedRunStart = findGatewayEvent(
    events,
    "[agent/embedded] embedded run start:"
  );
  const promptStart = findGatewayEvent(
    events,
    "[agent/embedded] embedded run prompt start:"
  );
  const contextDiag = findGatewayEvent(events, "[context-diag] pre-prompt:");
  const providerStart = findGatewayEvent(
    events,
    "[provider-transport-fetch] [model-fetch] start"
  );
  const firstEvent = findGatewayEvent(
    events,
    "[openai-transport] [responses] first_event"
  );
  const streamDone = findGatewayEvent(
    events,
    "[openai-transport] [responses] stream_done"
  );
  const embeddedRunDone = findGatewayEvent(
    events,
    "[agent/embedded] embedded run done:"
  );

  const result: GatewayPhaseTimings = {
    requestToLaneMs: diffMs(requestStartedAt, laneEnqueue?.timestampMs),
    laneWaitMs: readFirstNumberField(laneDequeue?.text ?? "", ["waitMs"]),
    laneToRunStartMs: diffMs(laneDequeue?.timestampMs, embeddedRunStart?.timestampMs),
    runStartToPromptMs: diffMs(embeddedRunStart?.timestampMs, promptStart?.timestampMs),
    promptToProviderMs: diffMs(promptStart?.timestampMs, providerStart?.timestampMs),
    providerToFirstEventMs: diffMs(providerStart?.timestampMs, firstEvent?.timestampMs),
    providerStreamMs: diffMs(firstEvent?.timestampMs, streamDone?.timestampMs),
    providerElapsedMs: readFirstNumberField(streamDone?.text ?? "", ["elapsedMs"]),
    gatewayRunDurationMs: readFirstNumberField(embeddedRunDone?.text ?? "", [
      "durationMs"
    ]),
    systemPromptChars: readFirstNumberField(contextDiag?.text ?? "", [
      "systemPromptChars"
    ]),
    gatewayPromptChars: readFirstNumberField(contextDiag?.text ?? "", [
      "promptChars"
    ]),
    historyTextChars: readFirstNumberField(contextDiag?.text ?? "", [
      "historyTextChars"
    ])
  };

  return Object.values(result).some((value) => typeof value === "number")
    ? result
    : null;
}

function readGatewayLogEvents(text: string): GatewayLogEvent[] {
  const events: GatewayLogEvent[] = [];
  const timestampPattern =
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|[+-]\d{2}:\d{2})/g;
  const matches = [...text.matchAll(timestampPattern)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    if (typeof match.index !== "number") {
      continue;
    }
    const nextIndex = matches[index + 1]?.index ?? text.length;
    const timestamp = match[0];
    const timestampMs = Date.parse(timestamp);
    if (Number.isNaN(timestampMs)) {
      continue;
    }
    events.push({
      timestampMs,
      text: text.slice(match.index + timestamp.length, nextIndex).trim()
    });
  }
  return events;
}

function findGatewayEvent(
  events: GatewayLogEvent[],
  marker: string
): GatewayLogEvent | undefined {
  return events.find((event) => event.text.includes(marker));
}

function diffMs(
  start: number | undefined,
  finish: number | undefined
): number | undefined {
  return typeof start === "number" && typeof finish === "number"
    ? Math.max(0, finish - start)
    : undefined;
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
  const explicitCachedInputTokens = readNumberFieldTotal(text, [
    "cached_tokens",
    "cachedInputTokens",
    "cache_read_input_tokens"
  ]);
  const reasoningTokens = readNumberFieldTotal(text, [
    "reasoning_tokens",
    "reasoningTokens"
  ]);
  const cachedInputTokens = explicitCachedInputTokens;

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
    const regex = new RegExp(
      `(?:^|[^A-Za-z0-9_])["']?${escapedField}["']?\\s*[:=]\\s*(\\d+)`,
      "gi"
    );
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
  step: number,
  logInfo: RuntimeLogger
): Promise<string | null> {
  const dir = join(config.openClawStateDir, "raw-streams");
  try {
    await mkdir(dir, { recursive: true });
    const runKey = hashSessionKey(request.runId ?? randomUUID());
    return join(dir, `${runKey}-step-${step}-${Date.now()}.jsonl`);
  } catch (error) {
    logInfo(
      `OpenClaw raw stream capture unavailable runId=${request.runId ?? "unknown"} step=${step} dir=${dir} error=${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

async function readRawStreamForUsage(
  config: RuntimeConfig,
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
      `OpenClaw raw stream captured runId=${request.runId ?? "unknown"} step=${step} path=${rawStreamPath} bytes=${new TextEncoder().encode(content).length} retained=${config.openClawRawStreamDebug ? "true" : "false"}`
    );
    if (!config.openClawRawStreamDebug) {
      try {
        await unlink(rawStreamPath);
      } catch (error) {
        logInfo(
          `OpenClaw raw stream cleanup skipped runId=${request.runId ?? "unknown"} step=${step} path=${rawStreamPath} error=${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    return content;
  } catch (error) {
    logInfo(
      `OpenClaw raw stream unavailable runId=${request.runId ?? "unknown"} step=${step} path=${rawStreamPath} error=${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

function buildRunSessionId(request: RunRequest): string {
  const channelSessionKey = buildBurbleChannelSessionKey(request);
  if (channelSessionKey) {
    return `burble-turn-${hashSessionKey(
      `${channelSessionKey}:${buildRunSessionKey(request)}`
    )}`;
  }

  return `burble-run-${hashSessionKey(
    `${buildSessionRoot(request)}:${buildRunSessionKey(request)}`
  )}`;
}

function buildRunSessionScope(request: RunRequest): "run" | "turn" {
  return buildBurbleChannelSessionKey(request) ? "turn" : "run";
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

function buildBurbleChannelSessionKey(request: RunRequest): string | null {
  if (!isNativeRuntimeExecutionMode(request)) {
    return null;
  }

  const conversation = request.input.conversation;
  if (!conversation?.routeId) {
    return null;
  }

  return [
    request.runtime?.id ?? "static-runtime",
    conversation.workspaceId,
    conversation.routeId,
    conversation.rootId,
    conversation.isDirectMessage ? "dm" : "channel"
  ].join(":");
}

function isNativeRuntimeExecutionMode(request: RunRequest): boolean {
  return request.executionMode === "native-runtime";
}

function resolveGatewayHttpMessageChannel(request: RunRequest): "webchat" | "burble" {
  if (!buildBurbleChannelSessionKey(request)) {
    return "webchat";
  }

  return "burble";
}

function hashSessionKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function extractOpenClawText(stdout: string): string | null {
  const trimmed = stripRuntimeToolCallProtocolFragments(stdout).trim();
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

function extractOpenResponsesText(responseText: string): string | null {
  const parsed = parseJsonObject(responseText);
  if (!parsed) {
    return null;
  }

  const outputText = readNestedText(parsed, ["output_text"]);
  if (outputText?.trim()) {
    return outputText.trim();
  }

  const output = parsed.output;
  if (!Array.isArray(output)) {
    return null;
  }

  const functionCall = output.find(
    (item): item is Record<string, unknown> =>
      Boolean(item) &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      (item as Record<string, unknown>).type === "function_call"
  );
  if (functionCall && typeof functionCall.name === "string") {
    return JSON.stringify({
      tool_call: {
        name: functionCall.name,
        arguments: parseJsonObject(String(functionCall.arguments ?? "")) ?? {}
      }
    });
  }

  const texts = output
    .flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return [];
      }
      const content = (item as Record<string, unknown>).content;
      if (!Array.isArray(content)) {
        return [];
      }
      return content
        .map((part) => {
          if (!part || typeof part !== "object" || Array.isArray(part)) {
            return null;
          }
          const record = part as Record<string, unknown>;
          return record.type === "output_text" && typeof record.text === "string"
            ? record.text
            : null;
        })
        .filter((value): value is string => Boolean(value?.trim()));
    })
    .join("\n\n")
    .trim();

  return texts || null;
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

function extractOpenResponsesStreamDelta(
  event: Record<string, unknown>
): string | null {
  const type = typeof event.type === "string" ? event.type : "";
  if (
    type === "response.output_text.delta" ||
    type === "response.refusal.delta"
  ) {
    const delta = readNestedText(event, ["delta"]);
    return delta?.length ? delta : null;
  }

  return (
    readNestedText(event, ["delta"]) ??
    readNestedText(event, ["response", "delta"]) ??
    readNestedText(event, ["message_delta", "text"]) ??
    null
  );
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
