import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
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
  RunUsage,
  ToolExecutor,
  ToolResult
} from "./types";

export type CliCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  usage?: RunUsage;
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

    if (!plannedToolCall) {
      const lastToolResult = executedTools.at(-1)?.toolResult;
      const rawText =
        extractOpenClawText(result.stdout) ||
        (lastToolResult ? formatToolResult(lastToolResult) : baseline.response.text);
      const text = sanitizeBootstrapFragments(rawText);
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
      logInfo(
        `OpenClaw agent finish runId=${request.runId ?? "unknown"} classification=${classification} textLength=${text.length}`
      );

      return {
        response: {
          classification,
          text,
          ...(totalUsage ? { usage: totalUsage } : {})
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
          ...(totalUsage ? { usage: totalUsage } : {})
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
          ...(totalUsage ? { usage: totalUsage } : {})
        }
      };
    }
    executedTools.push({ toolCall: plannedToolCall, toolResult });
  }

  return {
    response: {
      classification,
      text: baseline.response.text,
      ...(totalUsage ? { usage: totalUsage } : {})
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
      sessionId,
      logInfo
    );
    logInfo(
      `OpenClaw command error runId=${request.runId ?? "unknown"} step=${step} exitCode=${result.exitCode}${summarizeLogObject("stdoutPreview", result.stdout)}${summarizeLogObject("stderrPreview", result.stderr)}`
    );
    throw new Error(`OpenClaw CLI exited with code ${result.exitCode}`);
  }
  const rawStream = await readRawStreamForUsage(rawStreamPath, logInfo, request, step);
  const gatewayDiagnostics = readGatewayDiagnosticTextSince(startedAt);
  const usage = logOpenClawUsageFromOutput(
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
  return { ...result, usage };
}

async function runOpenClawGatewayHttpRequest(
  request: RunRequest,
  config: RuntimeConfig,
  prompt: string,
  sessionId: string,
  logInfo: RuntimeLogger,
  step: number
): Promise<CliCommandResult> {
  const startedAt = Date.now();
  const sessionKey = buildGatewayHttpSessionKey(config, sessionId);
  const endpoint = buildGatewayHttpResponsesUrl(config);
  logInfo(
    `OpenClaw gateway http start runId=${request.runId ?? "unknown"} step=${step} agent=${config.openClawAgent} endpoint=/v1/responses timeoutMs=${config.openClawTimeoutMs}${summarizePromptForLog(prompt)} sessionKey=${sessionKey}`
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
    const response = await fetchGatewayHttpResponse(
      endpoint,
      config,
      request,
      sessionKey,
      prompt
    );
    const responseText = await response.text();
    if (!response.ok) {
      stderr = responseText;
      const gatewayDiagnostics = readGatewayDiagnosticTextSince(startedAt);
      logOpenClawUsageFromOutput(
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
        `OpenClaw gateway http error runId=${request.runId ?? "unknown"} step=${step} status=${response.status}${summarizeLogObject("bodyPreview", responseText)}`
      );
      return { exitCode: 1, stdout, stderr };
    }

    stdout = extractOpenResponsesText(responseText) ?? responseText;
    const gatewayDiagnostics = readGatewayDiagnosticTextSince(startedAt);
    logOpenClawUsageFromOutput(
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
      `OpenClaw gateway http finish runId=${request.runId ?? "unknown"} step=${step} elapsedMs=${Date.now() - startedAt} status=${response.status} stdoutChars=${stdout.length} responseChars=${responseText.length}`
    );
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    stderr = error instanceof Error ? error.message : String(error);
    const gatewayDiagnostics = readGatewayDiagnosticTextSince(startedAt);
    logOpenClawUsageFromOutput(
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
    return { exitCode: 1, stdout, stderr };
  }
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
      const usage = logOpenClawUsageFromOutput(
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
      return { exitCode: 1, stdout, stderr, usage };
    }

    stdout =
      extractDirectModelText(parsedModel.provider, responseText) ?? responseText;
    const usage = logOpenClawUsageFromOutput(
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
    return { exitCode: 0, stdout, stderr, usage };
  } catch (error) {
    stderr = error instanceof Error ? error.message : String(error);
    const usage = logOpenClawUsageFromOutput(
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
    return { exitCode: 1, stdout, stderr, usage };
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
): AsyncGenerator<RunEvent, { stdout: string; usage?: RunUsage }, void> {
  const startedAt = Date.now();
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
          step
        );
  let result: CliCommandResult | null = null;

  while (!result) {
    const raced = await Promise.race([
      resultPromise.then((value) => ({ type: "result" as const, value })),
      sleep(heartbeatMs).then(() => ({ type: "heartbeat" as const }))
    ]);

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

  if (emitDeltas && shouldEmitGatewayHttpDelta(result.stdout)) {
    logStreamDebug(config, logInfo, "delta parsed", {
      runId: request.runId ?? "unknown",
      elapsedMs: Date.now() - startedAt,
      deltaCount: 1,
      chars: result.stdout.length,
      preview: result.stdout
    });
    yield { type: "message_delta", text: result.stdout };
  }

  return { stdout: result.stdout, usage: result.usage };
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
  prompt: string
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
        stream: false
      }),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
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
      true,
      step + 1
    );
    const plannedToolCall = normalizePlannedToolCall(
      readPlannedToolCall(result.stdout, toolContext.catalog)
    );
    totalUsage = addRunUsage(totalUsage, result.usage);

    if (!plannedToolCall) {
      const lastToolResult = executedTools.at(-1)?.toolResult;
      const rawText =
        extractOpenClawText(result.stdout) ||
        (lastToolResult ? formatToolResult(lastToolResult) : baseline.response.text);
      const text = sanitizeBootstrapFragments(rawText);
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
      logInfo(
        `OpenClaw agent finish runId=${request.runId ?? "unknown"} classification=${classification} textLength=${text.length}`
      );

      yield {
        type: "final",
        response: {
          classification,
          text,
          ...(totalUsage ? { usage: totalUsage } : {})
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
          ...(totalUsage ? { usage: totalUsage } : {})
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
          ...(totalUsage ? { usage: totalUsage } : {})
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
): AsyncGenerator<RunEvent, { stdout: string; usage?: RunUsage }, void> {
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
  const rawStream = await readRawStreamForUsage(rawStreamPath, logInfo, request, step);
  const gatewayDiagnostics = readGatewayDiagnosticTextSince(startedAt);
  const usage = logOpenClawUsageFromOutput(
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

  return { stdout, usage };
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
  if (request.input.conversation) {
    catalog.push({
      name: "conversation.sendMessage",
      description:
        "Send a message through Burble to the active conversation or a durable conversation route. Burble chooses and validates the transport and destination; provide message text and, for scheduled/background jobs, the active routeId.",
      inputSchema: {
        text: "string message text to send",
        routeId:
          "optional durable Burble route ID for scheduled/background messages"
      }
    });
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
          "List open GitHub pull requests authored by the requesting Slack user's connected GitHub account.",
        inputSchema: {}
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
    preloadedRuntimeSkills,
    "",
    "Do not run first-time assistant setup. Do not ask who you are, who the user is, what kind of assistant you are, what style you should use, or for an emoji/persona setup. Do not mention bootstrap-pending, bootstrap blockers, setup state, defaults, name/nature/vibe/emoji, or workspace bootstrap. The Slack user and assistant identity are already established by Burble.",
    "",
    "Runtime instruction: for requests about the current Slack channel or chat, answer from Recent Slack context when available. If channel history is unavailable, explain that Burble needs Slack bot history scopes and channel membership.",
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
  if (request.executionMode !== "openclaw-native") {
    return [];
  }

  return [
    "Native agent execution:",
    "This request explicitly asks for OpenClaw-native execution. Use OpenClaw native capabilities/tools directly when useful for code, shell/process work, cron, or long-running tasks. Use Burble JSON tool_call only for external provider data or actions listed in Available Burble tools.",
    ...formatActiveConversationRouteInstruction(config, request),
    "When native code tools are available, you can run programs in this runtime. Do not say you cannot run arbitrary programs, cannot run code, or can only provide a local script; use native exec instead.",
    "For code execution tasks, prefer one deliberate exec call for the main work. If that exec succeeds and prints the requested result, summarize it and stop. Do not repeatedly rewrite, rerun, or optimize code after the requested result is available.",
    "For duration or long-running tests, run exactly one timed program for the requested duration, then report its stdout/stderr summary and final observed result."
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
    `Native OpenClaw Burble channel delivery is installed. For cron/background jobs, set delivery.mode to "announce", delivery.channel to "burble", and delivery.to to "${routeId}". The scheduled prompt should produce the final Slack-ready message text; Burble resolves the route to the actual transport outside OpenClaw.`,
    `For an immediate request to send, post, message, or report something here now, do not create a cron job or background job unless the user explicitly asks for a schedule, delay, recurrence, or later delivery. Produce the final Slack-ready message once and stop.`,
    "Do not fetch, POST to, or mention local/private/internal Burble URLs for delivery. Do not create cron jobs that rely on conversation.sendMessage JSON blobs, announce delivery, Slack channel IDs, Slack credentials, or Burble credentials. Burble's channel connector owns route auth and transport delivery outside the OpenClaw process."
  ];
}

function formatFinalInstruction(request: RunRequest): string {
  if (request.executionMode === "openclaw-native") {
    return "For provider data/actions, return exactly one Burble tool_call JSON object if required. Otherwise use OpenClaw native capabilities when appropriate, avoid unnecessary extra tool loops, and return the final Slack-ready answer as soon as the requested result is available.";
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
      "For Google Drive, Calendar, or Gmail questions, call google.searchDriveFiles, google.searchCalendarEvents, or google.searchMailMessages.",
      "For final answers, return concise Slack mrkdwn."
    ].join(" "),
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
  const messages = request.input.context?.recentMessages ?? [];
  const currentChannel = request.input.context?.currentChannel;
  if (!currentChannel && messages.length === 0) {
    return [];
  }

  const lines = [
    ...(currentChannel
      ? [
          `Current Slack channel ID: ${currentChannel.id}`,
          `Current Slack channel type: ${currentChannel.isDirectMessage ? "direct_message" : "channel"}`,
          `Current Slack channel history: ${
            currentChannel.historyAvailable
              ? `available (${messages.length} recent messages)`
              : `unavailable (${currentChannel.historyError ?? "unknown_error"})`
          }`
        ]
      : []),
    ...(messages.length > 0 ? ["Recent Slack context (oldest to newest):"] : []),
    ...messages.map(
      (message) =>
        `${formatSlackContextAuthor(message)}: ${truncate(message.text, 500)}`
    )
  ];

  return lines;
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

function sanitizeBootstrapFragments(text: string): string {
  if (!isBootstrapSetupAnswer(text)) {
    return text;
  }

  const paragraphs = text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const kept = paragraphs.filter((paragraph) => !isBootstrapSetupAnswer(paragraph));
  if (kept.length === 0) {
    return text;
  }

  return kept.join("\n\n");
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
  if (toolCall.name === "conversation.sendMessage") {
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
): RunUsage | undefined {
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
  return usage ?? undefined;
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
  const channelSessionKey = buildBurbleChannelSessionKey(request);
  if (channelSessionKey) {
    return `burble-channel-${hashSessionKey(channelSessionKey)}`;
  }

  return `burble-run-${hashSessionKey(
    `${buildSessionRoot(request)}:${buildRunSessionKey(request)}`
  )}`;
}

function buildRunSessionScope(request: RunRequest): "run" | "channel" {
  return buildBurbleChannelSessionKey(request) ? "channel" : "run";
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
  if (request.executionMode !== "openclaw-native") {
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

function resolveGatewayHttpMessageChannel(request: RunRequest): "webchat" | "burble" {
  return buildBurbleChannelSessionKey(request) ? "burble" : "webchat";
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
