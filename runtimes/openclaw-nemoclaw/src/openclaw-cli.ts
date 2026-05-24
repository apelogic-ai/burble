import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { RuntimeConfig } from "./config";
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
};

export async function runOpenClawCliRequest(
  request: RunRequest,
  config: RuntimeConfig,
  executeTool: ToolExecutor,
  runCommand: CliCommandRunner = runCliCommand,
  logInfo: RuntimeLogger = info
): Promise<RunResponse> {
  const toolContext = await buildBurbleToolContext(request, config, executeTool);
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

  const sessionId = buildSessionId(request);
  logInfo(
    `OpenClaw agent start runId=${request.runId ?? "unknown"} agent=${config.openClawAgent} sessionId=${sessionId} textLength=${request.input.text.length} classification=${baseline.response.classification}`
  );
  const executedTools: ExecutedToolCall[] = [];
  let classification = baseline.response.classification;

  for (let step = 0; step <= maxPlannedToolCalls; step += 1) {
    const result = await runOpenClawCommand(
      request,
      config,
      buildOpenClawPrompt(request, toolContext, executedTools),
      sessionId,
      runCommand
    );
    const plannedToolCall = readPlannedToolCall(result.stdout, toolContext.catalog);

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
      `OpenClaw tool requested runId=${request.runId ?? "unknown"} tool=${plannedToolCall.name}`
    );
    const toolResult = await executePlannedToolCall(
      plannedToolCall,
      request,
      executeTool
    );
    classification = mergeClassification(classification, toolResult.classification);
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
  runCommand: CliCommandRunner
): Promise<CliCommandResult> {
  const result = await runCommand(
    config.openClawCommand,
    buildOpenClawArgs(config, prompt, sessionId),
    {
      timeoutMs: config.openClawTimeoutMs,
      env: openClawEnv(config)
    }
  );

  if (result.exitCode !== 0) {
    throw new Error(`OpenClaw CLI exited with code ${result.exitCode}`);
  }
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
  const toolContext = await buildBurbleToolContext(request, config, executeTool);
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

  const sessionId = buildSessionId(request);
  logInfo(
    `OpenClaw agent start runId=${request.runId ?? "unknown"} agent=${config.openClawAgent} sessionId=${sessionId} textLength=${request.input.text.length} classification=${baseline.response.classification}`
  );
  yield { type: "status", text: "Running OpenClaw/NemoClaw..." };

  const executedTools: ExecutedToolCall[] = [];
  let classification = baseline.response.classification;

  for (let step = 0; step <= maxPlannedToolCalls; step += 1) {
    const result = yield* collectOpenClawStream(
      request,
      config,
      buildOpenClawPrompt(request, toolContext, executedTools),
      sessionId,
      runCommandStream,
      logInfo,
      heartbeatMs,
      true
    );
    const plannedToolCall = readPlannedToolCall(result.stdout, toolContext.catalog);

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
      `OpenClaw tool requested runId=${request.runId ?? "unknown"} tool=${plannedToolCall.name}`
    );
    const callId = crypto.randomUUID();
    yield {
      type: "tool_call",
      toolName: plannedToolCall.name,
      callId
    };
    const toolResult = await executePlannedToolCall(
      plannedToolCall,
      request,
      executeTool
    );
    yield {
      type: "tool_result",
      toolName: plannedToolCall.name,
      callId,
      classification: toolResult.classification
    };
    classification = mergeClassification(classification, toolResult.classification);
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
  emitDeltas: boolean
): AsyncGenerator<RunEvent, { stdout: string }, void> {
  let stdout = "";
  let exitCode: number | null = null;
  let chunkCount = 0;
  let deltaCount = 0;
  const startedAt = Date.now();

  for await (const event of withHeartbeat(
    runCommandStream(
      config.openClawCommand,
      buildOpenClawArgs(config, prompt, sessionId),
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
        `OpenClaw agent partial finish runId=${request.runId ?? "unknown"} exitCode=${exitCode ?? "unknown"} textLength=${partialText.length}`
      );
      return { stdout };
    }

    throw new Error(`OpenClaw CLI exited with code ${exitCode ?? "unknown"}`);
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

async function buildBurbleToolContext(
  request: RunRequest,
  config: RuntimeConfig,
  executeTool: ToolExecutor
): Promise<BurbleToolContext> {
  const [baseline, catalog] = await Promise.all([
    runBurbleRequest(request, config, executeTool),
    buildToolCatalog(request, executeTool)
  ]);

  return { baseline, catalog };
}

async function buildToolCatalog(
  request: RunRequest,
  executeTool: ToolExecutor
): Promise<ToolCatalogItem[]> {
  const catalog: ToolCatalogItem[] = [];
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

    const upstreamTools = await readAtlassianMcpToolSummaries(
      jira.email,
      executeTool
    );
    catalog.push({
      name: "atlassian.callMcpTool",
      description: [
        "Call an allowlisted upstream Atlassian MCP tool through Burble for Jira/Atlassian questions that need provider-native tools. Selected Jira write tools are allowed.",
        "For Jira create/edit/transition/comment/worklog requests, choose the relevant upstream Atlassian MCP tool from the known tool list and fill arguments from its inputSchema.",
        upstreamTools.length > 0
          ? `Known allowed Atlassian MCP tools include: ${upstreamTools.slice(0, 30).join("; ")}.`
          : "Use this only when you know the upstream allowed tool name."
      ].join(" "),
      inputSchema: {
        name: "string upstream Atlassian MCP tool name",
        arguments: "object JSON arguments for the upstream Atlassian MCP tool"
      }
    });
  }

  return catalog;
}

async function readAtlassianMcpToolSummaries(
  email: string,
  executeTool: ToolExecutor
): Promise<string[]> {
  try {
    const result = await executeTool("atlassian.listMcpTools", {
      user: { email }
    });
    if (!Array.isArray(result.content)) {
      return [];
    }

    return result.content.flatMap((item) => {
      if (
        item &&
        typeof item === "object" &&
        "name" in item &&
        typeof item.name === "string"
      ) {
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
  } catch {
    return [];
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

  return executeTool(toolCall.name, {
    user: { email },
    input: toolCall.arguments
  });
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
  sessionId: string
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

  if (config.engine !== "openclaw-gateway") {
    args.splice(3, 0, "--local");
  }

  return args;
}

function buildSessionId(request: RunRequest): string {
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
