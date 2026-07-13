type RuntimeEvent =
  | { type: "status"; text: string }
  | { type: "tool_call"; toolName: string; callId?: string }
  | { type: "tool_result"; toolName: string; classification?: string; callId?: string }
  | { type: "message_delta"; text: string }
  | { type: "final"; response: { classification: string; text: string; usage?: unknown } }
  | { type: "error"; message: string };

export type BenchOptions = {
  url: string;
  label: string;
  iterations: number;
  warmup: number;
  stream: boolean;
  executionMode: "default" | "openclaw-native";
  routeId: string;
  token?: string;
  scheduled?: boolean;
  questions: string[];
};

export type BenchResult = {
  runId: string;
  label: string;
  question: string;
  iteration: number;
  ok: boolean;
  status: number;
  finalMs: number;
  firstEventMs: number | null;
  firstDeltaMs: number | null;
  firstToolCallMs: number | null;
  firstToolResultMs: number | null;
  toolCalls: number;
  toolResults: number;
  finalTextChars: number;
  error?: string;
};

const defaultQuestions = [
  "Look up the current OpenAI status page headline online and tell me the result in one sentence.",
  "Look up current Model Context Protocol news online and tell me the top result in one sentence."
];

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const results: BenchResult[] = [];

  for (const question of options.questions) {
    for (let index = 0; index < options.warmup; index += 1) {
      await runOnce(options, question, -1);
    }

    for (let index = 0; index < options.iterations; index += 1) {
      const result = await runOnce(options, question, index + 1);
      results.push(result);
      printResult(result);
    }
  }

  printSummary(results);
}

export async function runOnce(
  options: BenchOptions,
  question: string,
  iteration: number
): Promise<BenchResult> {
  const startedAt = performance.now();
  const runId = `bench-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const body = buildRunRequest(options, question, runId);

  try {
    const response = await fetch(`${options.url.replace(/\/+$/, "")}/runs`, {
      method: "POST",
      headers: {
        "accept": options.stream ? "application/x-ndjson" : "application/json",
        "content-type": "application/json",
        "authorization": `Bearer ${options.token ?? "bench-internal-token"}`
      },
      body: JSON.stringify(body)
    });

    const contentType = response.headers.get("content-type") ?? "";
    if (
      options.stream &&
      response.ok &&
      response.body &&
      contentType.toLowerCase().includes("application/x-ndjson")
    ) {
      return await readNdjsonRun({
        response,
        startedAt,
        options,
        runId,
        question,
        iteration
      });
    }

    const text = await response.text();
    const parsed = parseJsonObject(text);
    const finalText =
      readNestedString(parsed, ["response", "text"]) ??
      readNestedString(parsed, ["response", "message"]) ??
      "";
    return {
      label: options.label,
      runId,
      question,
      iteration,
      ok: response.ok,
      status: response.status,
      finalMs: Math.round(performance.now() - startedAt),
      firstEventMs: null,
      firstDeltaMs: null,
      firstToolCallMs: null,
      firstToolResultMs: null,
      toolCalls: 0,
      toolResults: 0,
      finalTextChars: finalText.length,
      ...(response.ok ? {} : { error: truncate(text.trim(), 300) })
    };
  } catch (error) {
    return {
      label: options.label,
      runId,
      question,
      iteration,
      ok: false,
      status: 0,
      finalMs: Math.round(performance.now() - startedAt),
      firstEventMs: null,
      firstDeltaMs: null,
      firstToolCallMs: null,
      firstToolResultMs: null,
      toolCalls: 0,
      toolResults: 0,
      finalTextChars: 0,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function readNdjsonRun(input: {
  response: Response;
  startedAt: number;
  options: BenchOptions;
  runId: string;
  question: string;
  iteration: number;
}): Promise<BenchResult> {
  const decoder = new TextDecoder();
  const reader = input.response.body?.getReader();
  if (!reader) {
    throw new Error("Response body reader is unavailable");
  }

  let buffer = "";
  let firstEventMs: number | null = null;
  let firstDeltaMs: number | null = null;
  let firstToolCallMs: number | null = null;
  let firstToolResultMs: number | null = null;
  let toolCalls = 0;
  let toolResults = 0;
  let finalTextChars = 0;
  let error: string | undefined;

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      buffer += decoder.decode();
      break;
    }
    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const event = parseRuntimeEvent(line);
      if (!event) {
        continue;
      }
      const elapsed = Math.round(performance.now() - input.startedAt);
      firstEventMs ??= elapsed;
      if (event.type === "message_delta") {
        firstDeltaMs ??= elapsed;
      } else if (event.type === "tool_call") {
        firstToolCallMs ??= elapsed;
        toolCalls += 1;
      } else if (event.type === "tool_result") {
        firstToolResultMs ??= elapsed;
        toolResults += 1;
      } else if (event.type === "final") {
        finalTextChars = event.response.text.length;
      } else if (event.type === "error") {
        error = event.message;
      }
    }
  }

  if (buffer.trim()) {
    const event = parseRuntimeEvent(buffer);
    if (event?.type === "final") {
      finalTextChars = event.response.text.length;
    } else if (event?.type === "error") {
      error = event.message;
    }
  }

  return {
    label: input.options.label,
    runId: input.runId,
    question: input.question,
    iteration: input.iteration,
    ok: input.response.ok && !error,
    status: input.response.status,
    finalMs: Math.round(performance.now() - input.startedAt),
    firstEventMs,
    firstDeltaMs,
    firstToolCallMs,
    firstToolResultMs,
    toolCalls,
    toolResults,
    finalTextChars,
    ...(error ? { error } : {})
  };
}

export function buildRunRequest(
  options: BenchOptions,
  question: string,
  runId: string
): unknown {
  return {
    runId,
    principal: {
      workspaceId: "T_BENCH",
      slackUserId: "U_BENCH"
    },
    ...(options.executionMode === "openclaw-native"
      ? { executionMode: "openclaw-native" }
      : {}),
    runtime: {
      id: "rt_bench",
      engine: options.label
    },
    input: {
      text: question,
      ...(options.scheduled
        ? {
            scheduledJob: {
              jobId: "job_bench",
              capabilityProfile: "scheduled_job",
              allowedTools: [
                "web_search",
                "web_fetch",
                "burble_provider_call"
              ],
              routeId: options.routeId,
              runtimeType: "openclaw",
              stateRefs: [],
              visibilityPolicy: {
                maxOutputVisibility: "user_private"
              }
            }
          }
        : {}),
      conversation: {
        routeId: options.routeId,
        source: "slack",
        workspaceId: "T_BENCH",
        channelId: "D_BENCH",
        rootId: "dm:D_BENCH",
        isDirectMessage: true
      },
      context: {
        currentChannel: {
          id: "D_BENCH",
          isDirectMessage: true,
          historyAvailable: false,
          historyError: "bench_no_slack"
        },
        recentMessages: []
      },
      connections: {
        github: { connected: false },
        google: { connected: false },
        jira: { connected: false },
        slack: { connected: false }
      }
    }
  };
}

function parseRuntimeEvent(line: string): RuntimeEvent | null {
  const parsed = parseJsonObject(line);
  if (!parsed || typeof parsed.type !== "string") {
    return null;
  }
  return parsed as RuntimeEvent;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function readNestedString(
  value: Record<string, unknown> | null,
  path: string[]
): string | null {
  let cursor: unknown = value;
  for (const key of path) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
      return null;
    }
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return typeof cursor === "string" ? cursor : null;
}

function parseArgs(args: string[]): BenchOptions {
  const questions: string[] = [];
  let url = "http://127.0.0.1:8080";
  let label = "runtime";
  let iterations = 3;
  let warmup = 1;
  let stream = true;
  let executionMode: BenchOptions["executionMode"] = "openclaw-native";
  let routeId = "convrt_bench";
  let token = Bun.env.BURBLE_RUNTIME_BENCH_TOKEN ?? "bench-internal-token";
  let scheduled = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    const [key, inlineValue] = arg.split("=", 2);
    const nextValue = (): string => inlineValue ?? args[++index] ?? "";

    switch (key) {
      case "--url":
        url = nextValue();
        break;
      case "--label":
        label = nextValue();
        break;
      case "--iterations":
        iterations = readPositiveInt(nextValue(), "--iterations");
        break;
      case "--warmup":
        warmup = readNonNegativeInt(nextValue(), "--warmup");
        break;
      case "--question":
        questions.push(nextValue());
        break;
      case "--stream":
        stream = readBoolean(nextValue(), "--stream");
        break;
      case "--execution-mode": {
        const value = nextValue();
        if (value !== "default" && value !== "openclaw-native") {
          throw new Error("--execution-mode must be default or openclaw-native");
        }
        executionMode = value;
        break;
      }
      case "--route-id":
        routeId = nextValue();
        break;
      case "--token":
        token = nextValue();
        break;
      case "--scheduled":
        scheduled = readBoolean(nextValue(), "--scheduled");
        break;
      case "--help":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return {
    url,
    label,
    iterations,
    warmup,
    stream,
    executionMode,
    routeId,
    token,
    scheduled,
    questions: questions.length ? questions : defaultQuestions
  };
}

function readPositiveInt(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function readNonNegativeInt(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function readBoolean(value: string, name: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no"].includes(normalized)) {
    return false;
  }
  throw new Error(`${name} must be true or false`);
}

export function printResult(result: BenchResult): void {
  console.log(
    [
      result.ok ? "ok" : "fail",
      `label=${result.label}`,
      `runId=${result.runId}`,
      `iteration=${result.iteration}`,
      `status=${result.status}`,
      `finalMs=${result.finalMs}`,
      `firstEventMs=${formatNullable(result.firstEventMs)}`,
      `firstDeltaMs=${formatNullable(result.firstDeltaMs)}`,
      `firstToolCallMs=${formatNullable(result.firstToolCallMs)}`,
      `firstToolResultMs=${formatNullable(result.firstToolResultMs)}`,
      `toolCalls=${result.toolCalls}`,
      `toolResults=${result.toolResults}`,
      `finalTextChars=${result.finalTextChars}`,
      result.error ? `error=${JSON.stringify(truncate(result.error, 180))}` : ""
    ].filter(Boolean).join(" ")
  );
}

function printSummary(results: BenchResult[]): void {
  const okResults = results.filter((result) => result.ok);
  console.log("");
  console.log(`runs=${results.length} ok=${okResults.length} failed=${results.length - okResults.length}`);
  if (okResults.length === 0) {
    return;
  }
  console.log(
    [
      `finalMs.p50=${percentile(okResults.map((result) => result.finalMs), 0.5)}`,
      `finalMs.p90=${percentile(okResults.map((result) => result.finalMs), 0.9)}`,
      `firstEventMs.p50=${percentileNullable(okResults.map((result) => result.firstEventMs), 0.5)}`,
      `firstDeltaMs.p50=${percentileNullable(okResults.map((result) => result.firstDeltaMs), 0.5)}`
    ].join(" ")
  );
}

function percentile(values: number[], pct: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * pct));
  return sorted[index] ?? 0;
}

function percentileNullable(values: Array<number | null>, pct: number): string {
  const present = values.filter((value): value is number => typeof value === "number");
  return present.length ? String(percentile(present, pct)) : "n/a";
}

function formatNullable(value: number | null): string {
  return typeof value === "number" ? String(value) : "n/a";
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function printHelp(): void {
  console.log(`Usage:
  bun scripts/runtime-bench.ts [options]

Options:
  --url <url>                    Runtime base URL. Default: http://127.0.0.1:8080
  --label <name>                 Label printed with each run. Default: runtime
  --iterations <n>               Measured iterations per question. Default: 3
  --warmup <n>                   Warmup iterations per question. Default: 1
  --question <text>              Question to ask. Repeatable.
  --stream <true|false>          Request application/x-ndjson stream. Default: true
  --execution-mode <mode>        default or openclaw-native. Default: openclaw-native
  --route-id <convrt_id>         Synthetic route id. Default: convrt_bench
  --token <token>                Runtime bearer token. Default: BURBLE_RUNTIME_BENCH_TOKEN
  --scheduled <true|false>       Exercise the scheduled OpenClaw agent. Default: false
`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
