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

  const sessionId = buildSessionId(request);
  logInfo(
    `OpenClaw agent start runId=${request.runId ?? "unknown"} agent=${config.openClawAgent} sessionId=${sessionId} textLength=${request.input.text.length} classification=${baseline.response.classification}`
  );
  const executedTools: ExecutedToolCall[] = [];
  let classification = baseline.response.classification;

  for (let step = 0; step <= maxPlannedToolCalls; step += 1) {
    const prompt = buildOpenClawPrompt(request, toolContext, executedTools);
    logInfo(
      `OpenClaw planning start runId=${request.runId ?? "unknown"} step=${step + 1} executedTools=${executedTools.length} promptChars=${prompt.length}`
    );
    const result = await runOpenClawCommand(
      request,
      config,
      prompt,
      sessionId,
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
  logInfo(
    `OpenClaw command start runId=${request.runId ?? "unknown"} step=${step} command=${config.openClawCommand} agent=${config.openClawAgent} promptChars=${prompt.length}`
  );
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
  logInfo(
    `OpenClaw command finish runId=${request.runId ?? "unknown"} step=${step} elapsedMs=${Date.now() - startedAt} stdoutChars=${result.stdout.length} stderrChars=${result.stderr.length}`
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

  const sessionId = buildSessionId(request);
  logInfo(
    `OpenClaw agent start runId=${request.runId ?? "unknown"} agent=${config.openClawAgent} sessionId=${sessionId} textLength=${request.input.text.length} classification=${baseline.response.classification}`
  );
  yield { type: "status", text: "Running OpenClaw/NemoClaw..." };

  const executedTools: ExecutedToolCall[] = [];
  let classification = baseline.response.classification;

  for (let step = 0; step <= maxPlannedToolCalls; step += 1) {
    const prompt = buildOpenClawPrompt(request, toolContext, executedTools);
    logInfo(
      `OpenClaw planning start runId=${request.runId ?? "unknown"} step=${step + 1} executedTools=${executedTools.length} promptChars=${prompt.length}`
    );
    const result = yield* collectOpenClawStream(
      request,
      config,
      prompt,
      sessionId,
      runCommandStream,
      logInfo,
      heartbeatMs,
      true
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
  emitDeltas: boolean
): AsyncGenerator<RunEvent, { stdout: string }, void> {
  let stdout = "";
  let exitCode: number | null = null;
  let chunkCount = 0;
  let deltaCount = 0;
  let firstStdoutLogged = false;
  const startedAt = Date.now();
  logInfo(
    `OpenClaw command stream start runId=${request.runId ?? "unknown"} command=${config.openClawCommand} agent=${config.openClawAgent} promptChars=${prompt.length}`
  );

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
  logInfo(
    `OpenClaw command stream finish runId=${request.runId ?? "unknown"} elapsedMs=${Date.now() - startedAt} exitCode=${exitCode ?? "unknown"} chunkCount=${chunkCount} deltaCount=${deltaCount} stdoutChars=${stdout.length}`
  );

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
    value.replace(
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
