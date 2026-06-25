import { readFile } from "node:fs/promises";
import {
  runOpenClawCliRequestStream,
  type CliCommandStreamer
} from "../runtimes/openclaw-nemoclaw/src/openclaw-cli";
import type { RuntimeConfig } from "../runtimes/openclaw-nemoclaw/src/config";
import type {
  RunEvent,
  RunRequest,
  ToolExecutor,
  ToolResult
} from "../runtimes/openclaw-nemoclaw/src/types";

type ReplayResponse =
  | {
      type: "open-responses-text";
      text: string;
      usage?: Record<string, unknown>;
      status?: number;
    }
  | {
      type: "sse";
      events: unknown[];
      done?: boolean;
      close?: boolean;
      status?: number;
    }
  | {
      type: "raw";
      body: string;
      contentType?: string;
      status?: number;
    }
  | {
      type: "hang";
      events?: unknown[];
      status?: number;
    };

type ReplayFixture = {
  name?: string;
  text?: string;
  runId?: string;
  streaming?: boolean;
  timeoutMs?: number;
  connections?: RunRequest["input"]["connections"];
  toolGroups?: RunRequest["input"]["toolGroups"];
  conversation?: RunRequest["input"]["conversation"];
  scheduledJob?: RunRequest["input"]["scheduledJob"];
  responses: ReplayResponse[];
};

type RecordedRequest = {
  index: number;
  stream: boolean;
  sessionKey: string | null;
  inputPreview: string;
};

const baselineText = "No Burble tool context is needed for this request.";

const baseConfig: RuntimeConfig = {
  port: 8080,
  toolGatewayUrl: "http://burble-app:3000/internal/tools",
  internalToken: "secret",
  mcpGatewayUrl: null,
  runtimeJwt: null,
  engine: "openclaw-gateway",
  openClawCommand: "openclaw",
  openClawAgent: "main",
  openClawTimeoutMs: 2_000,
  openClawStateDir: "/data/openclaw/state",
  openClawConfigPath: "/data/openclaw/config/openclaw.json",
  openClawWorkspaceDir: "/data/openclaw/workspace",
  openClawSetupOnStart: true,
  openClawConfigPatchPath: null,
  openClawValidateOnStart: true,
  openClawStreamDebug: false,
  openClawCodeMode: false,
  openClawFastMode: false,
  openClawRawStreamDebug: false,
  openClawGatewayPort: 18789,
  openClawGatewayBind: "loopback",
  openClawGatewayToken: "gateway-token",
  llmModel: "openai:gpt-5.4",
  inferenceBaseUrl: null,
  ollamaBaseUrl: "https://ollama.com"
};

const builtInFixtures: Record<string, ReplayFixture> = {
  success: {
    name: "success",
    text: "hello agent",
    responses: [{ type: "open-responses-text", text: "Hello!" }]
  },
  "baseline-echo": {
    name: "baseline-echo",
    text: "hello agent",
    responses: [
      { type: "open-responses-text", text: baselineText },
      { type: "open-responses-text", text: "Hello!" }
    ]
  },
  "failed-response": {
    name: "failed-response",
    text: "do we currently have any cron jobs, configured and or running?",
    responses: [
      failedResponseSse("resp_fixture_1"),
      failedResponseSse("resp_fixture_2"),
      failedResponseSse("resp_fixture_3")
    ]
  },
  "hung-stream": {
    name: "hung-stream",
    text: "hello agent",
    timeoutMs: 50,
    responses: [
      { type: "hang", events: [{ type: "response.created" }] },
      { type: "hang", events: [{ type: "response.created" }] },
      { type: "hang", events: [{ type: "response.created" }] }
    ]
  },
  "tool-call-jira": {
    name: "tool-call-jira",
    text: "what are my open tickets in Jira?",
    connections: {
      jira: {
        connected: true,
        email: "person@example.com",
        providerLogin: "person@example.com"
      }
    },
    responses: [
      {
        type: "open-responses-text",
        text: JSON.stringify({
          tool_call: {
            name: "jira.listAssignedIssues",
            arguments: {}
          }
        })
      },
      {
        type: "open-responses-text",
        text: "Your open Jira tickets:\n\n- ECS-313 - onboarding crash loop\n- ECS-312 - group by stopped working"
      }
    ]
  }
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  if (args.list) {
    console.log(Object.keys(builtInFixtures).sort().join("\n"));
    return;
  }

  const fixture = args.fixture
    ? await readFixture(args.fixture)
    : builtInFixtures[args.scenario ?? "baseline-echo"];
  if (!fixture) {
    throw new Error(
      `Unknown scenario ${JSON.stringify(args.scenario)}. Use --list to see built-ins.`
    );
  }

  const responses = [...fixture.responses];
  const requests: RecordedRequest[] = [];
  const logs: string[] = [];
  const events: RunEvent[] = [];
  const request = buildRunRequest(fixture, args);
  const config: RuntimeConfig = {
    ...baseConfig,
    openClawTimeoutMs: args.timeoutMs ?? fixture.timeoutMs ?? baseConfig.openClawTimeoutMs
  };

  await withMockFetch(buildReplayFetch(responses, requests), async () => {
    for await (const event of runOpenClawCliRequestStream(
      request,
      config,
      fakeToolExecutor,
      unexpectedCliStreamer,
      (message) => logs.push(message)
    )) {
      events.push(event);
      printEvent(event, Boolean(args.json));
    }
  }).catch((error) => {
    printHarnessError(error, Boolean(args.json));
    process.exitCode = 1;
  });

  printSummary(
    {
      fixtureName: fixture.name ?? args.fixture ?? args.scenario ?? "custom",
      requests,
      events,
      logs,
      unusedResponses: responses.length
    },
    Boolean(args.json)
  );
}

function buildRunRequest(
  fixture: ReplayFixture,
  args: ParsedArgs
): RunRequest {
  const streaming = args.streaming ?? fixture.streaming ?? true;
  return {
    runId: fixture.runId ?? `replay-${fixture.name ?? "fixture"}`,
    executionMode: "native-runtime",
    runtime: {
      id: "rt_replay",
      manifest: {
        version: "1",
        policyHash: "replay",
        skills: [],
        memory: {
          userMemoryEnabled: false,
          workspaceMemoryEnabled: false,
          jobMemoryEnabled: Boolean(fixture.scheduledJob)
        },
        streaming: {
          messageDeltasEnabled: streaming
        }
      }
    },
    input: {
      text: args.text ?? fixture.text ?? "hello agent",
      ...(fixture.toolGroups ? { toolGroups: fixture.toolGroups } : {}),
      ...(fixture.conversation ? { conversation: fixture.conversation } : {}),
      ...(fixture.scheduledJob ? { scheduledJob: fixture.scheduledJob } : {}),
      connections: {
        github: { connected: false },
        google: { connected: false },
        jira: { connected: false },
        slack: { connected: false },
        ...fixture.connections
      }
    }
  };
}

function buildReplayFetch(
  responses: ReplayResponse[],
  requests: RecordedRequest[]
): typeof fetch {
  return (async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      input?: unknown;
      stream?: unknown;
    };
    const headers = new Headers(init?.headers);
    requests.push({
      index: requests.length + 1,
      stream: body.stream === true,
      sessionKey: headers.get("x-openclaw-session-key"),
      inputPreview: String(body.input ?? "").slice(0, 240)
    });

    const response = responses.shift();
    if (!response) {
      return new Response("Replay fixture exhausted", { status: 500 });
    }
    return responseToFetchResponse(response);
  }) as typeof fetch;
}

function responseToFetchResponse(response: ReplayResponse): Response {
  if (response.type === "open-responses-text") {
    return new Response(
      JSON.stringify(
        openResponsesText(
          response.text,
          response.usage ?? {
            input_tokens: 100,
            output_tokens: 20,
            total_tokens: 120
          }
        )
      ),
      {
        status: response.status ?? 200,
        headers: { "content-type": "application/json" }
      }
    );
  }

  if (response.type === "raw") {
    return new Response(response.body, {
      status: response.status ?? 200,
      headers: { "content-type": response.contentType ?? "application/json" }
    });
  }

  const encoder = new TextEncoder();
  const events = response.events ?? [];
  const close = response.type === "sse" ? response.close !== false : false;
  const done = response.type === "sse" ? response.done === true : false;
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
        if (done) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        }
        if (close) {
          controller.close();
        }
      }
    }),
    {
      status: response.status ?? 200,
      headers: { "content-type": "text/event-stream" }
    }
  );
}

async function fakeToolExecutor(
  toolName: string,
  input: unknown
): Promise<ToolResult> {
  if (toolName === "jira.listAssignedIssues") {
    return {
      classification: "user_private",
      content: [
        {
          title: "ECS-313 - onboarding crash loop",
          url: "https://jira.example.test/browse/ECS-313"
        },
        {
          title: "ECS-312 - group by stopped working",
          url: "https://jira.example.test/browse/ECS-312"
        }
      ]
    };
  }

  if (toolName === "burble.mcp.listTools") {
    throw new Error("MCP discovery is disabled in replay harness");
  }

  return {
    classification: "user_private",
    content: {
      ok: true,
      toolName,
      input
    }
  };
}

const unexpectedCliStreamer: CliCommandStreamer = async function* () {
  throw new Error("Replay harness expected OpenClaw Gateway mode, not local CLI");
};

async function withMockFetch<T>(
  mock: typeof fetch,
  run: () => Promise<T>
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function openResponsesText(
  text: string,
  usage: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...openResponsesEnvelope("resp_replay", "completed", [
      {
        type: "message",
        id: "msg_replay",
        role: "assistant",
        content: [{ type: "output_text", text }],
        status: "completed"
      }
    ]),
    usage
  };
}

function openResponsesEnvelope(
  id: string,
  status: string,
  output: unknown[]
): Record<string, unknown> {
  return {
    id,
    object: "response",
    created_at: 1,
    status,
    model: "openclaw/main",
    output,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0
    }
  };
}

function failedResponseSse(id: string): ReplayResponse {
  return {
    type: "sse",
    events: [
      {
        type: "response.created",
        response: openResponsesEnvelope(id, "in_progress", [])
      },
      {
        type: "response.failed",
        response: {
          ...openResponsesEnvelope(id, "failed", []),
          error: {
            code: "api_error",
            message: "upstream provider timeout"
          }
        }
      }
    ],
    close: true
  };
}

async function readFixture(path: string): Promise<ReplayFixture> {
  return JSON.parse(await readFile(path, "utf8")) as ReplayFixture;
}

function printEvent(event: RunEvent, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ kind: "event", event }));
    return;
  }
  if (event.type === "message_delta") {
    console.log(`[event:${event.type}] ${JSON.stringify(event.text)}`);
    return;
  }
  if (event.type === "final") {
    console.log(`[event:final] ${JSON.stringify(event.response.text)}`);
    return;
  }
  console.log(`[event:${event.type}] ${JSON.stringify(event)}`);
}

function printHarnessError(error: unknown, json: boolean): void {
  const message = error instanceof Error ? error.message : String(error);
  if (json) {
    console.log(JSON.stringify({ kind: "error", message }));
    return;
  }
  console.error(`[error] ${message}`);
}

function printSummary(
  input: {
    fixtureName: string;
    requests: RecordedRequest[];
    events: RunEvent[];
    logs: string[];
    unusedResponses: number;
  },
  json: boolean
): void {
  const finalEvent = input.events.findLast((event) => event.type === "final");
  const summary = {
    kind: "summary",
    fixture: input.fixtureName,
    requestCount: input.requests.length,
    eventCount: input.events.length,
    finalText: finalEvent?.type === "final" ? finalEvent.response.text : null,
    unusedResponses: input.unusedResponses,
    requests: input.requests,
    notableLogs: input.logs.filter(
      (line) =>
        line.includes("retry") ||
        line.includes("response_failed") ||
        line.includes("finish") ||
        line.includes("error")
    )
  };
  if (json) {
    console.log(JSON.stringify(summary));
    return;
  }
  console.log("\nSummary:");
  console.log(JSON.stringify(summary, null, 2));
}

type ParsedArgs = {
  help?: boolean;
  list?: boolean;
  json?: boolean;
  scenario?: string;
  fixture?: string;
  text?: string;
  streaming?: boolean;
  timeoutMs?: number;
};

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      case "--list":
        parsed.list = true;
        break;
      case "--json":
        parsed.json = true;
        break;
      case "--scenario":
        parsed.scenario = readArgValue(argv, (index += 1), arg);
        break;
      case "--fixture":
        parsed.fixture = readArgValue(argv, (index += 1), arg);
        break;
      case "--text":
        parsed.text = readArgValue(argv, (index += 1), arg);
        break;
      case "--timeout-ms":
        parsed.timeoutMs = Number.parseInt(
          readArgValue(argv, (index += 1), arg),
          10
        );
        break;
      case "--no-stream":
        parsed.streaming = false;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function readArgValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function printUsage(): void {
  console.log(`Usage: bun run openclaw:replay -- [options]

Options:
  --list                 List built-in replay scenarios
  --scenario <name>      Built-in scenario to run. Default: baseline-echo
  --fixture <path>       JSON fixture with responses to replay
  --text <prompt>        Override the user prompt
  --timeout-ms <ms>      Override OpenClaw adapter timeout
  --no-stream            Disable runtime message_delta streaming
  --json                 Print NDJSON events and summary

Built-ins:
  ${Object.keys(builtInFixtures).sort().join(", ")}
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
