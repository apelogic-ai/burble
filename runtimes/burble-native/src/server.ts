import {
  parseRuntimeRunRequest,
  type RuntimeFinalResponse
} from "@burble/runtime-sdk/runtime-contract";
import {
  createRuntimeContractServer,
  type RuntimeEventWebSocket
} from "@burble/runtime-sdk/server";
import type {
  CapabilityManifest,
  RunEvent,
  RunRequest,
  RunResponse,
  RunUsage,
  ToolClassification,
  ToolExecutor,
  ToolResult
} from "./types";

type RuntimeServerContext = {
  executeTool?: ToolExecutor;
};

type RuntimeRequestOptions = RuntimeServerContext;

const runtimeContractServer = createRuntimeContractServer<
  RuntimeServerContext,
  RunRequest,
  RunEvent,
  RunResponse
>({
  getCapabilityManifest: buildRuntimeCapabilityManifest,
  normalizeRunRequest(rawBody, runId) {
    try {
      return {
        ...parseRuntimeRunRequest(addRunId(rawBody, runId)),
        runId
      };
    } catch {
      return null;
    }
  },
  streamRun: streamNativeRun,
  responseFromEvent(event) {
    return event.type === "final" ? { response: event.response } : null;
  },
  formatError(error) {
    return error instanceof Error ? error.message : String(error);
  }
});

export async function handleRuntimeRequest(
  request: Request,
  context: RuntimeRequestOptions = {},
  options: {
    upgradeWebSocket?: (runId: string) => boolean;
  } = {}
): Promise<Response> {
  const response = await runtimeContractServer.handleRequest(
    request,
    context,
    options
  );
  return response ?? new Response("Not found", { status: 404 });
}

export function attachRuntimeEventWebSocket(
  runId: string,
  ws: RuntimeEventWebSocket
): void {
  runtimeContractServer.attachEventWebSocket(runId, ws);
}

export function buildRuntimeCapabilityManifest(): CapabilityManifest {
  return {
    runtimeType: "burble-native",
    version: "1",
    transports: ["http", "sse", "ndjson", "websocket"],
    streaming: true,
    cancellation: false,
    nativeScheduler: false,
    scheduledProviderCalls: false,
    toolCalls: true,
    toolBridgeModes: ["tool_gateway"],
    usageReporting: "exact",
    multimodalInput: false,
    multimodalOutput: false,
    memory: false,
    durableWorkflowState: false,
    attachments: false,
    conversationSend: true,
    jobScopedAuth: true
  };
}

async function* streamNativeRun(
  request: RunRequest,
  context: RuntimeServerContext
): AsyncIterable<RunEvent> {
  yield { type: "status", text: "Burble Native accepted the turn." };
  const response = await runNativeTurn(request, context.executeTool);
  if (response.text) {
    yield { type: "message_delta", text: response.text };
  }
  yield { type: "final", response };
}

async function runNativeTurn(
  request: RunRequest,
  executeTool?: ToolExecutor
): Promise<RuntimeFinalResponse> {
  const text = request.input.text.trim();
  if (isGitHubIdentityRequest(text)) {
    return runGitHubIdentityTurn(request, executeTool);
  }

  return {
    classification: "user_private",
    text: Bun.env.BURBLE_RUNTIME_CONTRACT_PROBE === "1"
      ? "Runtime contract probe response."
      : "Burble Native is ready.",
    usage: nativeUsage()
  };
}

async function runGitHubIdentityTurn(
  request: RunRequest,
  executeTool?: ToolExecutor
): Promise<RuntimeFinalResponse> {
  const github = request.input.connections.github;
  if (!github?.connected || !github.email) {
    return {
      classification: "user_private",
      text: "Connect GitHub before asking Burble Native to use GitHub.",
      usage: nativeUsage()
    };
  }
  if (!executeTool) {
    return {
      classification: "user_private",
      text: "Burble Native cannot reach the tool gateway for this turn.",
      usage: nativeUsage()
    };
  }

  const result = await executeTool("github.getAuthenticatedUser", {
    user: { email: github.email }
  });
  const toolResult = readToolResult(result);
  const login = readLogin(toolResult.content);
  const classification = toolResult.classification ?? "user_private";

  return {
    classification,
    text: login
      ? `Authenticated to GitHub as \`${login}\`.`
      : "GitHub is connected, but Burble Native could not read the authenticated user.",
    usage: nativeUsage()
  };
}

function nativeUsage(): RunUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    usageSource: "burble-native"
  };
}

function isGitHubIdentityRequest(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes("github") &&
    (normalized.includes("who am i") ||
      normalized.includes("who am i?") ||
      normalized.includes("authenticated") ||
      normalized.includes("identity"))
  );
}

function readToolResult(value: unknown): ToolResult {
  return isRecord(value) ? value : {};
}

function readLogin(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const login = value.login ?? value.username ?? value.name;
  return typeof login === "string" && login.trim() ? login.trim() : null;
}

function addRunId(rawBody: unknown, runId: string): unknown {
  return isRecord(rawBody) ? { ...rawBody, runId } : rawBody;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
