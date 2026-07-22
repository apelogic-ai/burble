import { createParser } from "eventsource-parser";
import type {
  AgentInput,
  AgentOutput,
  AgentRunEvent,
  AgentRunner,
} from "../types";
import type { ToolClassification } from "../../conversation/types";
import type {
  RuntimeDiagnosticsInput,
  RuntimeFactory,
  RuntimeHandle,
} from "../runtime-factory";
import type { ObservabilitySink } from "../../observability";
import {
  parseRuntimeRunRequest,
  type RuntimeCapabilityManifest,
} from "@burble/runtime-sdk/runtime-contract";
import {
  createAgentRunnerFromRuntimeAdapter,
  type RuntimeAdapter,
} from "../runtime-adapter";
import {
  createRuntimeContractWebSocket,
  createRuntimeContractHttpClient,
  RuntimeCapabilityDiscoveryError,
} from "@burble/runtime-sdk/runtime-contract-http-client";
import { containsRuntimeToolCallProtocolFragments } from "@burble/runtime-sdk/runtime-text-protocol";
import { runtimeCompatibilityFamily } from "../runtime-descriptors";
import { isRuntimeProgressOnlyResponseText } from "../runtime-control-notices";
import { sealRuntimeConversationAttachments } from "../../conversation/attachment-capabilities";
import type { Config } from "../../config";
import {
  routeRuntimeEndpointWebSocket,
  routeRuntimeEndpointFetch,
} from "../runtime-endpoint-routing";
import { createRoutedRuntimeWebSocketFactory } from "../runtime-websocket";
import type {
  McpGwConnectionStatusPrincipal,
  McpGwRuntimeConnectionStatuses,
} from "../../mcp/mcp-gw-connection-status";

export type AgentRuntimeFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export type AgentRuntimeWebSocket = {
  addEventListener: (
    type: "message" | "error" | "close",
    listener: (event: { data?: unknown }) => void,
  ) => void;
  close: () => void;
};

export type AgentRuntimeWebSocketOptions = {
  headers?: HeadersInit;
};

export type AgentRuntimeWebSocketFactory = (
  url: string,
  options?: AgentRuntimeWebSocketOptions,
) => AgentRuntimeWebSocket;

export type ManagedRuntimeAgentRunnerDeps = {
  config?: Config;
  baseUrl?: string;
  runtimeFactory?: RuntimeFactory;
  fetch?: AgentRuntimeFetch;
  webSocketFactory?: AgentRuntimeWebSocketFactory;
  runSnapshotTimeoutMs?: number;
  logInfo?: (message: string) => void;
  observability?: ObservabilitySink;
  resolveMcpGwConnectionStatuses?: (
    principal: McpGwConnectionStatusPrincipal,
  ) => Promise<McpGwRuntimeConnectionStatuses>;
  mcpGwConnectionStatusCacheTtlMs?: number;
};

export type ManagedRuntimeAdmissionResult =
  | {
      checked: true;
      ok: true;
      runtimeId: string;
      runtimeType: string;
    }
  | {
      checked: true;
      ok: false;
      runtimeId?: string;
      runtimeType?: string;
      reason: string;
    }
  | {
      checked: false;
      ok: true;
      reason: string;
    };

type RemoteRunResponse = {
  response?: AgentOutput;
};

type RecoveredRuntimeSnapshot = {
  output: AgentOutput;
  toolEvents: AgentRunEvent[];
};

type RemoteRunStartResponse = {
  runId?: string;
  eventsUrl?: string;
};

type RemoteRunEvent =
  | { type: "status"; text: string }
  | {
      type: "tool_call";
      toolName: string;
      callId: string;
      input?: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      toolName: string;
      callId: string;
      classification: ToolClassification;
      status?: "ok" | "error";
      errorCode?: string;
      errorMessage?: string;
      operation?: string;
    }
  | { type: "message_delta"; text: string }
  | { type: "message_replace"; text: string }
  | { type: "final"; response: AgentOutput }
  | { type: "error"; message: string };

type ConnectionSummary = {
  connected: boolean;
  email?: string;
  providerLogin?: string;
};

type RuntimeAttachment = {
  id: string;
  kind: "file" | "image" | "audio" | "video";
  mimeType: string;
  source: "slack" | "burble" | "agent";
  name?: string;
  sizeBytes?: number;
  externalId?: string;
};

const maxRuntimeRecentMessages = 12;
const maxRuntimeRecentMessageChars = 300;
const runtimeCapabilityCacheTtlMs = 60_000;
const defaultMcpGwConnectionStatusCacheTtlMs = 30_000;
const defaultRunSnapshotTimeoutMs = 180_000;

type RuntimeCapabilityCacheEntry = {
  expiresAt: number;
  manifest: RuntimeCapabilityManifest | null;
};

type RuntimeCapabilityCache = Map<string, RuntimeCapabilityCacheEntry>;

type McpGwConnectionStatusCacheEntry = {
  expiresAt: number;
  statuses: McpGwRuntimeConnectionStatuses;
};

type RuntimeRunLease = {
  waitedMs: number;
  release: () => void;
};

export function createManagedRuntimeAgentRunner(
  deps: ManagedRuntimeAgentRunnerDeps,
): AgentRunner {
  return createAgentRunnerFromRuntimeAdapter(createManagedRuntimeAdapter(deps));
}

export async function validateManagedRuntimeAgentInput(
  deps: ManagedRuntimeAgentRunnerDeps,
  input: AgentInput,
): Promise<ManagedRuntimeAdmissionResult> {
  const runtime = buildManagedRuntimeAdmissionHandle(deps, input);
  if (!runtime) {
    return {
      checked: false,
      ok: true,
      reason: "Managed runtime endpoint is unavailable",
    };
  }

  const runId = crypto.randomUUID();
  const runBody = buildManagedRuntimeRunBody(input, {
    runtime,
    runId,
    config: deps.config,
  });

  try {
    parseRuntimeRunRequest(runBody);
  } catch (error) {
    return {
      checked: true,
      ok: false,
      runtimeId: runtime.id,
      runtimeType: runtime.engine,
      reason:
        error instanceof Error
          ? `Runtime run request is invalid: ${error.message}`
          : "Runtime run request is invalid",
    };
  }

  return {
    checked: true,
    ok: true,
    runtimeId: runtime.id,
    runtimeType: runtime.engine,
  };
}

export function createManagedRuntimeAdapter(
  deps: ManagedRuntimeAgentRunnerDeps,
): RuntimeAdapter {
  if (!deps.baseUrl && !deps.runtimeFactory) {
    throw new Error("managed runtime URL or runtimeFactory is required");
  }

  const fallbackBaseUrl = deps.baseUrl?.replace(/\/+$/, "");
  const routedFetch = routeRuntimeEndpointFetch(
    (url, init) => (deps.fetch ?? fetch)(url, init ?? {}),
    { openShellDialHost: deps.config?.agentRuntimeOpenShellDialHost },
  );
  const requestFetch: AgentRuntimeFetch = (url, init) => routedFetch(url, init);
  const routeOptions = {
    openShellDialHost: deps.config?.agentRuntimeOpenShellDialHost,
  };
  const createWebSocket: AgentRuntimeWebSocketFactory = deps.webSocketFactory
    ? (url, options) => {
        const routed = routeRuntimeEndpointWebSocket(
          url,
          options,
          routeOptions,
        );
        return deps.webSocketFactory!(routed.url, routed.options);
      }
    : createRoutedRuntimeWebSocketFactory(routeOptions);
  const logInfo = deps.logInfo ?? (() => undefined);
  const observability = deps.observability;
  const runSnapshotTimeoutMs =
    deps.runSnapshotTimeoutMs ?? defaultRunSnapshotTimeoutMs;
  const runtimeCapabilityCache: RuntimeCapabilityCache = new Map();
  const mcpGwConnectionStatusCache = new Map<
    string,
    McpGwConnectionStatusCacheEntry
  >();
  const runtimeRunLeases = new Map<string, Promise<void>>();

  return {
    name: "burble-runtime",
    capabilities: {
      streaming: true,
      remote: true,
      requiresToolGateway: true,
      toolEvents: true,
    },
    async *run(input: AgentInput): AsyncIterable<AgentRunEvent> {
      const runId = crypto.randomUUID();
      yield {
        type: "status",
        text: "Starting agent runtime...",
      };
      const principalId = `${input.principal.workspaceId}:${input.principal.slackUserId}`;
      let runLease: RuntimeRunLease | null = null;
      try {
        if (deps.runtimeFactory) {
          runLease = await acquireRuntimeRunLease(
            runtimeRunLeases,
            principalId,
          );
          if (runLease.waitedMs > 0) {
            logInfo(
              [
                "Managed runtime run lease acquired",
                `principal=${principalId}`,
                `waitedMs=${runLease.waitedMs}`,
              ].join(" "),
            );
          }
        }
      const runtime = await getManagedRuntimeForInput(deps, input);
      const baseUrl =
        runtime?.endpointUrl.replace(/\/+$/, "") ?? fallbackBaseUrl;
      if (!baseUrl) {
        throw new Error("Managed runtime endpoint is unavailable");
      }

      yield { type: "status", text: "Agent is thinking..." };

      const runStartedAt = Date.now();
      const runtimeId = runtime?.id ?? "static";
      const runtimeType = runtime?.engine ?? "static";
      const mcpGwConnectionStatuses = await resolveRuntimeMcpGwConnectionStatuses({
        deps,
        principal: input.principal,
        principalId,
        cache: mcpGwConnectionStatusCache,
        logInfo,
      });
      const githubConnected =
        mcpGwConnectionStatuses.github?.connected ??
        Boolean(input.connections.github);
      const googleConnected =
        mcpGwConnectionStatuses.google?.connected ??
        Boolean(input.connections.google);
      const scheduledJobSummary = summarizeScheduledJob(input);
      const capabilityManifest = await discoverRuntimeCapabilityManifest({
        baseUrl,
        requestFetch,
        runtime,
        runtimeId,
        runtimeType,
        principalId,
        workspaceId: input.principal.workspaceId,
        logInfo,
        observability,
        cache: runtimeCapabilityCache,
      });
      const capabilitySummary = capabilityManifest
        ? summarizeCapabilityManifest(capabilityManifest)
        : null;
      logInfo(
        [
          "Managed runtime run start",
          `runId=${runId}`,
          `url=${baseUrl}/runs`,
          `runtimeId=${runtimeId}`,
          `principal=${principalId}`,
          `conversationRoot=${input.conversation?.rootId ?? "unknown"}`,
          `textLength=${input.text.length}`,
          `githubConnected=${githubConnected}`,
          `googleConnected=${googleConnected}`,
          `jiraConnected=${Boolean(input.connections.jira)}`,
          `slackConnected=${Boolean(input.connections.slack)}`,
        ].join(" "),
      );
      observability?.emit({
        name: "runtime.run.started",
        runId,
        workspaceId: input.principal.workspaceId,
        principalId,
        runtimeId,
        runtimeType,
        attributes: {
          conversationRoot: input.conversation?.rootId ?? "unknown",
          textLength: input.text.length,
          githubConnected,
          googleConnected,
          jiraConnected: Boolean(input.connections.jira),
          slackConnected: Boolean(input.connections.slack),
          ...(scheduledJobSummary ? { scheduledJob: scheduledJobSummary } : {}),
          ...(capabilitySummary
            ? { runtimeCapabilities: capabilitySummary }
            : {}),
          ...(runtime?.manifest
            ? { policyHash: runtime.manifest.policyHash }
            : {}),
        },
      });
      if (runtime) {
        deps.runtimeFactory?.recordRuntimeEvent?.(runtime.id, {
          eventType: "runtime_run_started",
          summary: {
            conversationRoot: input.conversation?.rootId ?? "unknown",
            textLength: input.text.length,
            githubConnected,
            googleConnected,
            jiraConnected: Boolean(input.connections.jira),
            slackConnected: Boolean(input.connections.slack),
            ...(scheduledJobSummary
              ? { scheduledJob: scheduledJobSummary }
              : {}),
            ...(capabilitySummary
              ? { runtimeCapabilities: capabilitySummary }
              : {}),
            ...(runtime.manifest
              ? { policyHash: runtime.manifest.policyHash }
              : {}),
          },
        });
      }

      const runBody = buildManagedRuntimeRunBody(input, {
        runtime,
        runId,
        config: deps.config,
        mcpGwConnectionStatuses,
      });
      const runUrl = `${baseUrl}/runs`;
      let agentResponse: AgentOutput | null;
      try {
        const postStartedAt = Date.now();
        const preferredStreamingAccept =
          selectHttpStreamingAccept(capabilityManifest);
        const response = await postRuntimeRun(
          requestFetch,
          runUrl,
          runtime,
          runBody,
          preferredStreamingAccept ?? "application/json",
          preferredStreamingAccept ? undefined : "respond-async",
        );

        if (!response.ok) {
          throw new Error(await managedRuntimeHttpErrorMessage(response));
        }
        logInfo(
          [
            "Managed runtime run accepted",
            `runId=${runId}`,
            `runtimeId=${runtimeId}`,
            `elapsedMs=${Date.now() - postStartedAt}`,
            `status=${response.status}`,
          ].join(" "),
        );
        observability?.emit({
          name: "runtime.run.accepted",
          runId,
          workspaceId: input.principal.workspaceId,
          principalId,
          runtimeId,
          runtimeType,
          durationMs: Date.now() - postStartedAt,
          status: "ok",
          attributes: {
            httpStatus: response.status,
          },
        });

        const observedToolEventKeys = new Set<string>();
        const observeEvent = (event: AgentRunEvent) => {
          const eventKey = runtimeToolEventKey(event);
          if (eventKey) {
            observedToolEventKeys.add(eventKey);
          }
          const eventDetails =
            event.type === "tool_call"
              ? [
                  `toolName=${event.toolName}`,
                  `callId=${event.callId}`,
                  `inputKeys=${Object.keys(event.input ?? {}).join(",") || "-"}`,
                ]
              : event.type === "tool_result"
                ? [`toolName=${event.toolName}`, `callId=${event.callId}`]
                : [];
          logInfo(
            [
              "Managed runtime stream event",
              `runId=${runId}`,
              `runtimeId=${runtime?.id ?? "static"}`,
              `elapsedMs=${Date.now() - runStartedAt}`,
              `type=${event.type}`,
              ...eventDetails,
            ].join(" "),
          );
          observeRuntimeStreamEvent(event, {
            observability,
            runtimeFactory: deps.runtimeFactory,
            workspaceId: input.principal.workspaceId,
            principalId,
            runId,
            runtimeId,
            runtimeType,
            runtime,
            elapsedMs: Date.now() - runStartedAt,
          });
        };

        if (isStreamingResponse(response)) {
          try {
            agentResponse = yield* readStreamingRunResponse(
              response,
              runtimeMessageDeltasEnabled(runtime),
              observeEvent,
              runSnapshotTimeoutMs,
            );
          } catch (error) {
            if (!isManagedRuntimeFinalResponseTimeout(error)) {
              throw error;
            }
            const recovered = await recoverRuntimeSnapshotAfterStreamTimeout({
              requestFetch,
              baseUrl,
              runtime,
              runId,
              timeoutMs: Math.min(runSnapshotTimeoutMs, 5_000),
              logInfo,
            });
            if (!recovered) {
              throw error;
            }
            for (const event of recovered.toolEvents) {
              const eventKey = runtimeToolEventKey(event);
              if (eventKey && observedToolEventKeys.has(eventKey)) {
                continue;
              }
              observeEvent(event);
              yield event;
            }
            agentResponse = recovered.output;
          }
        } else {
          const startPayload = (await response.json()) as RemoteRunResponse &
            RemoteRunStartResponse;
          const legacyResponse = validateRemoteRunResponse(startPayload);
          if (legacyResponse) {
            agentResponse = legacyResponse;
          } else {
            const startedRunId = validateRemoteRunStartResponse(startPayload);
            if (!startedRunId) {
              throw new Error("Managed runtime returned an invalid response");
            }

            const eventsUrl = toWebSocketUrl(
              new URL(
                startPayload.eventsUrl ??
                  `/runs/${encodeURIComponent(startedRunId)}/events`,
                `${baseUrl}/`,
              ).toString(),
            );

            try {
              agentResponse = yield* readWebSocketRunResponse(
                createWebSocket(eventsUrl, runtimeWebSocketOptions(runtime)),
                runtimeMessageDeltasEnabled(runtime),
                observeEvent,
                runSnapshotTimeoutMs,
              );
            } catch (error) {
              if (!isRuntimeStreamClosedError(error)) {
                throw error;
              }

              logInfo(
                [
                  "Managed runtime event socket closed before final",
                  `runId=${startedRunId}`,
                  `runtimeId=${runtime?.id ?? "static"}`,
                  "fallback=json",
                ].join(" "),
              );
              const fallbackResponse = await getRuntimeRunWithTimeout(
                requestFetch,
                `${baseUrl}/runs/${encodeURIComponent(startedRunId)}`,
                runtime,
                runSnapshotTimeoutMs,
              );
              if (!fallbackResponse.ok) {
                throw new Error(
                  await managedRuntimeHttpErrorMessage(fallbackResponse),
                );
              }
              agentResponse = await readJsonRunResponse(fallbackResponse);
            }
          }
        }
        if (!agentResponse) {
          throw new Error("Managed runtime returned an invalid response");
        }
        assertManagedRuntimeFinalResponse(agentResponse);
      } catch (error) {
        recordRuntimeRunFailed({
          observability,
          runtimeFactory: deps.runtimeFactory,
          workspaceId: input.principal.workspaceId,
          principalId,
          runId,
          runtimeId,
          runtimeType,
          runtime,
          durationMs: Date.now() - runStartedAt,
          error,
        });
        if (runtime && isManagedRuntimeFinalResponseTimeout(error)) {
          await captureRuntimeTimeoutDiagnostics({
            runtimeFactory: deps.runtimeFactory,
            runtime,
            runId,
            error,
            logInfo,
          });
          try {
            await deps.runtimeFactory?.stopRuntime(runtime.id);
            logInfo(
              [
                "Managed runtime stopped after final response timeout",
                `runId=${runId}`,
                `runtimeId=${runtime.id}`,
              ].join(" "),
            );
          } catch (stopError) {
            logInfo(
              [
                "Managed runtime stop after timeout failed",
                `runId=${runId}`,
                `runtimeId=${runtime.id}`,
                `error=${formatRuntimeStopError(stopError)}`,
              ].join(" "),
            );
          }
        }
        throw error;
      }

      logInfo(
        [
          "Managed runtime run finish",
          `runId=${runId}`,
          `runtimeId=${runtimeId}`,
          `classification=${agentResponse.classification}`,
          `textLength=${agentResponse.text.length}`,
          `elapsedMs=${Date.now() - runStartedAt}`,
        ].join(" "),
      );
      observability?.emit({
        name: "runtime.run.completed",
        runId,
        workspaceId: input.principal.workspaceId,
        principalId,
        runtimeId,
        runtimeType,
        classification: agentResponse.classification,
        durationMs: Date.now() - runStartedAt,
        status: "ok",
        usage: agentResponse.usage,
        attributes: {
          textLength: agentResponse.text.length,
          ...(agentResponse.telemetry
            ? { telemetry: agentResponse.telemetry }
            : {}),
        },
      });
      if (runtime) {
        deps.runtimeFactory?.recordRuntimeEvent?.(runtime.id, {
          eventType: "runtime_run_finished",
          summary: {
            classification: agentResponse.classification,
            textLength: agentResponse.text.length,
            ...(agentResponse.usage ? { usage: agentResponse.usage } : {}),
            ...(agentResponse.telemetry
              ? { telemetry: agentResponse.telemetry }
              : {}),
          },
        });
      }

      yield { type: "final", response: agentResponse };
      } finally {
        runLease?.release();
      }
    },
  };
}

async function captureRuntimeTimeoutDiagnostics(input: {
  runtimeFactory?: RuntimeFactory;
  runtime: RuntimeHandle;
  runId: string;
  error: unknown;
  logInfo: (message: string) => void;
}): Promise<void> {
  const capture = input.runtimeFactory?.captureRuntimeDiagnostics;
  if (!capture) {
    return;
  }

  const diagnosticsInput: RuntimeDiagnosticsInput = {
    reason: "final_response_timeout",
    runId: input.runId,
    errorMessage:
      input.error instanceof Error ? input.error.message : String(input.error),
  };

  try {
    const summary = await capture(input.runtime.id, diagnosticsInput);
    input.logInfo(
      [
        "Managed runtime diagnostics captured",
        `runId=${input.runId}`,
        `runtimeId=${input.runtime.id}`,
        `summaryKeys=${summary ? Object.keys(summary).join(",") || "-" : "-"}`,
      ].join(" "),
    );
  } catch (diagnosticError) {
    input.logInfo(
      [
        "Managed runtime diagnostics capture failed",
        `runId=${input.runId}`,
        `runtimeId=${input.runtime.id}`,
        `error=${formatRuntimeStopError(diagnosticError)}`,
      ].join(" "),
    );
  }
}

async function acquireRuntimeRunLease(
  leases: Map<string, Promise<void>>,
  key: string,
): Promise<RuntimeRunLease> {
  const previous = leases.get(key) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const chained = previous.catch(() => undefined).then(() => current);
  leases.set(key, chained);

  const startedAt = Date.now();
  await previous.catch(() => undefined);
  let released = false;

  return {
    waitedMs: Date.now() - startedAt,
    release() {
      if (released) {
        return;
      }
      released = true;
      releaseCurrent();
      if (leases.get(key) === chained) {
        leases.delete(key);
      }
    },
  };
}

async function discoverRuntimeCapabilityManifest(input: {
  baseUrl: string;
  requestFetch: AgentRuntimeFetch;
  runtime: RuntimeHandle | null;
  runtimeId: string;
  runtimeType: string;
  principalId: string;
  workspaceId: string;
  logInfo: (message: string) => void;
  observability?: ObservabilitySink;
  cache: RuntimeCapabilityCache;
}): Promise<RuntimeCapabilityManifest | null> {
  if (!input.runtime) {
    return null;
  }

  const cacheKey = runtimeCapabilityCacheKey(input.runtime, input.baseUrl);
  const cached = input.cache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    if (cached.manifest) {
      assertRuntimeCapabilityManifestMatchesRuntime(
        cached.manifest,
        input.runtime,
      );
    }
    return cached.manifest;
  }
  if (cached) {
    input.cache.delete(cacheKey);
  }

  const startedAt = Date.now();
  let manifest: RuntimeCapabilityManifest;
  try {
    manifest = await createRuntimeContractHttpClient({
      baseUrl: input.baseUrl,
      fetch: (url, init) => input.requestFetch(url, init ?? {}),
      headers: runtimeHeaders(input.runtime),
    }).getCapabilityManifest();
  } catch (error) {
    recordRuntimeCapabilitiesUnavailable(input, startedAt, error);
    if (isRuntimeCapabilitiesNotImplementedError(error)) {
      input.cache.set(cacheKey, {
        expiresAt: Date.now() + runtimeCapabilityCacheTtlMs,
        manifest: null,
      });
    }
    return null;
  }

  assertRuntimeCapabilityManifestMatchesRuntime(manifest, input.runtime);

  input.cache.set(cacheKey, {
    expiresAt: Date.now() + runtimeCapabilityCacheTtlMs,
    manifest,
  });
  input.logInfo(
    [
      "Managed runtime capabilities discovered",
      `runtimeId=${input.runtimeId}`,
      `runtimeType=${manifest.runtimeType}`,
      `transports=${manifest.transports.join(",")}`,
      `toolBridgeModes=${manifest.toolBridgeModes.join(",")}`,
    ].join(" "),
  );
  input.observability?.emit({
    name: "runtime.capabilities.discovered",
    workspaceId: input.workspaceId,
    principalId: input.principalId,
    runtimeId: input.runtimeId,
    runtimeType: manifest.runtimeType,
    durationMs: Date.now() - startedAt,
    status: "ok",
    attributes: {
      transports: manifest.transports,
      streaming: manifest.streaming,
      nativeScheduler: manifest.nativeScheduler,
      scheduledProviderCalls: manifest.scheduledProviderCalls,
      toolCalls: manifest.toolCalls,
      toolBridgeModes: manifest.toolBridgeModes,
      usageReporting: manifest.usageReporting,
      multimodalInput: manifest.multimodalInput,
      attachments: manifest.attachments,
      jobScopedAuth: manifest.jobScopedAuth,
    },
  });
  return manifest;
}

function runtimeCapabilityCacheKey(
  runtime: RuntimeHandle,
  baseUrl: string,
): string {
  return `${runtime.id}:${baseUrl}`;
}

function assertRuntimeCapabilityManifestMatchesRuntime(
  manifest: RuntimeCapabilityManifest,
  runtime: RuntimeHandle,
): void {
  if (
    runtimeCompatibilityFamily(manifest.runtimeType) !==
    runtimeCompatibilityFamily(runtime.engine)
  ) {
    throw new Error(
      `Runtime capability manifest type ${manifest.runtimeType} does not match runtime engine ${runtime.engine}`,
    );
  }
}

function recordRuntimeCapabilitiesUnavailable(
  input: {
    runtimeId: string;
    runtimeType: string;
    principalId: string;
    workspaceId: string;
    logInfo: (message: string) => void;
    observability?: ObservabilitySink;
  },
  startedAt: number,
  error: unknown,
): void {
  input.logInfo(
    [
      "Managed runtime capabilities unavailable",
      `runtimeId=${input.runtimeId}`,
      `runtimeType=${input.runtimeType}`,
      `reason=${error instanceof Error ? error.message : String(error)}`,
    ].join(" "),
  );
  input.observability?.emit({
    name: "runtime.capabilities.unavailable",
    workspaceId: input.workspaceId,
    principalId: input.principalId,
    runtimeId: input.runtimeId,
    runtimeType: input.runtimeType,
    durationMs: Date.now() - startedAt,
    status: "error",
    attributes: {
      reason: error instanceof Error ? error.message : String(error),
    },
  });
}

function observeRuntimeStreamEvent(
  event: AgentRunEvent,
  input: {
    observability?: ObservabilitySink;
    runtimeFactory?: RuntimeFactory;
    workspaceId: string;
    principalId: string;
    runId: string;
    runtimeId: string;
    runtimeType: string;
    runtime: RuntimeHandle | null;
    elapsedMs: number;
  },
): void {
  const common = {
    runId: input.runId,
    workspaceId: input.workspaceId,
    principalId: input.principalId,
    runtimeId: input.runtimeId,
    runtimeType: input.runtimeType,
    durationMs: input.elapsedMs,
  };

  if (event.type === "status") {
    input.observability?.emit({
      ...common,
      name: "runtime.status",
      attributes: {
        text: event.text,
      },
    });
    return;
  }

  if (event.type === "message_delta" || event.type === "message_replace") {
    input.observability?.emit({
      ...common,
      name:
        event.type === "message_replace"
          ? "runtime.message.replace"
          : "runtime.message.delta",
      attributes: {
        textLength: event.text.length,
      },
      content: {
        text: event.text,
      },
    });
    return;
  }

  if (event.type === "tool_call") {
    input.observability?.emit({
      ...common,
      name: "runtime.tool.call.started",
      toolName: event.toolName,
      callId: event.callId,
    });
    if (input.runtime) {
      input.runtimeFactory?.recordRuntimeEvent?.(input.runtime.id, {
        eventType: "runtime_tool_called",
        summary: {
          phase: "started",
          toolName: event.toolName,
          callId: event.callId,
        },
      });
    }
    return;
  }

  if (event.type === "tool_result") {
    const status = event.status ?? "ok";
    input.observability?.emit({
      ...common,
      name: "runtime.tool.call.completed",
      toolName: event.toolName,
      callId: event.callId,
      classification: event.classification,
      status,
      ...(status === "error" && event.errorMessage
        ? {
            error: {
              message: event.errorMessage,
              ...(event.errorCode ? { code: event.errorCode } : {}),
            },
          }
        : {}),
    });
    if (input.runtime) {
      input.runtimeFactory?.recordRuntimeEvent?.(input.runtime.id, {
        eventType: "runtime_tool_called",
        summary: {
          phase: "completed",
          toolName: event.toolName,
          callId: event.callId,
          classification: event.classification,
          ...(event.status ? { status: event.status } : {}),
          ...(event.errorCode ? { errorCode: event.errorCode } : {}),
          ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
          ...(event.operation ? { operation: event.operation } : {}),
        },
      });
    }
    return;
  }

  if (event.type === "error") {
    return;
  }
}

function recordRuntimeRunFailed(input: {
  observability?: ObservabilitySink;
  runtimeFactory?: RuntimeFactory;
  workspaceId: string;
  principalId: string;
  runId: string;
  runtimeId: string;
  runtimeType: string;
  runtime: RuntimeHandle | null;
  durationMs: number;
  error: unknown;
}): void {
  const error = toRuntimeObservabilityError(input.error);
  input.observability?.emit({
    name: "runtime.run.failed",
    runId: input.runId,
    workspaceId: input.workspaceId,
    principalId: input.principalId,
    runtimeId: input.runtimeId,
    runtimeType: input.runtimeType,
    durationMs: input.durationMs,
    status: "error",
    error,
  });
  if (input.runtime) {
    input.runtimeFactory?.recordRuntimeEvent?.(input.runtime.id, {
      eventType: "runtime_run_finished",
      summary: {
        status: "error",
        error,
      },
    });
  }
}

function toRuntimeObservabilityError(error: unknown): {
  name?: string;
  message: string;
} {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }
  return {
    message: String(error),
  };
}

function isManagedRuntimeFinalResponseTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    /Managed runtime did not produce a final response within \d+ms/.test(
      error.message,
    )
  );
}

async function recoverRuntimeSnapshotAfterStreamTimeout(input: {
  requestFetch: AgentRuntimeFetch;
  baseUrl: string;
  runtime: RuntimeHandle | null;
  runId: string;
  timeoutMs: number;
  logInfo: (message: string) => void;
}): Promise<RecoveredRuntimeSnapshot | null> {
  const controller = new AbortController();
  let response: Response | null = null;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const recovery = (async (): Promise<{
      status: number;
      snapshot: RecoveredRuntimeSnapshot | null;
    }> => {
      response = await getRuntimeRun(
        input.requestFetch,
        `${input.baseUrl}/runs/${encodeURIComponent(input.runId)}`,
        input.runtime,
        controller.signal,
      );
      if (!response.ok) {
        return { status: response.status, snapshot: null };
      }
      return {
        status: response.status,
        snapshot: await readJsonRunSnapshot(response),
      };
    })();
    recovery.catch(() => undefined);
    const timedOut = new Promise<{
      status: number;
      snapshot: RecoveredRuntimeSnapshot | null;
    }>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        void response?.body?.cancel().catch(() => undefined);
        reject(
          new Error(
            `Managed runtime snapshot recovery timed out after ${input.timeoutMs}ms`,
          ),
        );
      }, input.timeoutMs);
    });
    const snapshot = await Promise.race([recovery, timedOut]);
    if (snapshot.status < 200 || snapshot.status >= 300) {
      input.logInfo(
        [
          "Managed runtime final snapshot unavailable",
          `runId=${input.runId}`,
          `runtimeId=${input.runtime?.id ?? "static"}`,
          `status=${snapshot.status}`,
        ].join(" "),
      );
      return null;
    }
    const recovered = snapshot.snapshot;
    if (!recovered) {
      input.logInfo(
        [
          "Managed runtime final snapshot incomplete",
          `runId=${input.runId}`,
          `runtimeId=${input.runtime?.id ?? "static"}`,
        ].join(" "),
      );
      return null;
    }
    input.logInfo(
      [
        "Managed runtime final snapshot recovered",
        `runId=${input.runId}`,
        `runtimeId=${input.runtime?.id ?? "static"}`,
      ].join(" "),
    );
    return recovered;
  } catch (error) {
    input.logInfo(
      [
        "Managed runtime final snapshot recovery failed",
        `runId=${input.runId}`,
        `runtimeId=${input.runtime?.id ?? "static"}`,
        `error=${formatRuntimeStopError(error)}`,
      ].join(" "),
    );
    return null;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    controller.abort();
  }
}

function formatRuntimeStopError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function getManagedRuntimeForInput(
  deps: ManagedRuntimeAgentRunnerDeps,
  input: AgentInput,
): Promise<RuntimeHandle | null> {
  return deps.runtimeFactory
    ? await deps.runtimeFactory.getOrCreateRuntime(input.principal, {
        ...(input.attachments && input.attachments.length > 0
          ? { attachments: true }
          : {}),
        ...(input.scheduledJob?.runtimeType
          ? { engine: input.scheduledJob.runtimeType }
          : {}),
      })
    : null;
}

function buildManagedRuntimeAdmissionHandle(
  deps: ManagedRuntimeAgentRunnerDeps,
  input: AgentInput,
): RuntimeHandle | null {
  const engine =
    input.scheduledJob?.runtimeType ?? deps.config?.agentRuntimeEngine;
  if (!engine) {
    return null;
  }
  return {
    id: `admission:${engine}`,
    engine,
    endpointUrl: deps.baseUrl ?? "",
    authToken: "",
    status: "ready",
    statePath: "",
    configPath: "",
    workspacePath: "",
  };
}

function buildManagedRuntimeRunBody(
  input: AgentInput,
  options: {
    runtime: RuntimeHandle | null;
    runId: string;
    config?: Config;
    mcpGwConnectionStatuses?: McpGwRuntimeConnectionStatuses;
  },
): unknown {
  return {
    runId: options.runId,
    principal: input.principal,
    ...(input.executionMode ? { executionMode: input.executionMode } : {}),
    ...(options.runtime
      ? { runtime: sanitizeRuntimeHandle(options.runtime) }
      : {}),
    input: sanitizeAgentInput(input, {
      ...(options.config ? { config: options.config } : {}),
      ...(options.mcpGwConnectionStatuses
        ? { mcpGwConnectionStatuses: options.mcpGwConnectionStatuses }
        : {}),
      ...(options.runtime?.id ? { runtimeId: options.runtime.id } : {}),
      runId: options.runId,
    }),
  };
}

async function managedRuntimeHttpErrorMessage(
  response: Response,
): Promise<string> {
  const base = `Managed runtime returned HTTP ${response.status}`;
  let body = "";
  try {
    body = await response.text();
  } catch {
    return base;
  }
  const safeBody = safeRuntimeHttpErrorBody(body);
  return safeBody ? `${base}: ${safeBody}` : base;
}

function safeRuntimeHttpErrorBody(body: string): string | null {
  const normalized = body.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }

  const redacted = normalized
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted-openai-key]");
  if (
    /\b(token|secret|api[_-]?key|private[_-]?key|password)\b/i.test(redacted)
  ) {
    return null;
  }
  return redacted.slice(0, 240);
}

function isRuntimeCapabilitiesNotImplementedError(error: unknown): boolean {
  return (
    error instanceof RuntimeCapabilityDiscoveryError &&
    (error.status === 404 || error.status === 405)
  );
}

function summarizeCapabilityManifest(
  manifest: RuntimeCapabilityManifest,
): Record<string, unknown> {
  return {
    runtimeType: manifest.runtimeType,
    transports: manifest.transports,
    streaming: manifest.streaming,
    nativeScheduler: manifest.nativeScheduler,
    scheduledProviderCalls: manifest.scheduledProviderCalls,
    toolCalls: manifest.toolCalls,
    toolBridgeModes: manifest.toolBridgeModes,
    usageReporting: manifest.usageReporting,
    multimodalInput: manifest.multimodalInput,
    attachments: manifest.attachments,
    jobScopedAuth: manifest.jobScopedAuth,
  };
}

function postRuntimeRun(
  requestFetch: AgentRuntimeFetch,
  url: string,
  runtime: RuntimeHandle | null,
  body: unknown,
  accept: string,
  prefer?: string,
): Promise<Response> {
  return requestFetch(url, {
    method: "POST",
    headers: {
      accept,
      "content-type": "application/json",
      ...(prefer ? { prefer } : {}),
      ...runtimeHeaders(runtime),
    },
    body: JSON.stringify(body),
  });
}

function selectHttpStreamingAccept(
  manifest: RuntimeCapabilityManifest | null,
): string | null {
  if (manifest?.transports.includes("ndjson")) {
    return "application/x-ndjson";
  }
  if (manifest?.transports.includes("sse")) {
    return "text/event-stream";
  }
  return null;
}

function getRuntimeRun(
  requestFetch: AgentRuntimeFetch,
  url: string,
  runtime: RuntimeHandle | null,
  signal?: AbortSignal,
): Promise<Response> {
  return requestFetch(url, {
    method: "GET",
    ...(signal ? { signal } : {}),
    headers: {
      accept: "application/json",
      ...runtimeHeaders(runtime),
    },
  });
}

async function getRuntimeRunWithTimeout(
  requestFetch: AgentRuntimeFetch,
  url: string,
  runtime: RuntimeHandle | null,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const request = getRuntimeRun(requestFetch, url, runtime, controller.signal);
  request.catch(() => undefined);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<Response>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(
        new Error(
          `Managed runtime did not produce a final response within ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([request, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function readJsonRunResponse(
  response: Response,
): Promise<AgentOutput | null> {
  const payload = (await response.json()) as RemoteRunResponse;
  return validateRemoteRunResponse(payload);
}

async function readJsonRunSnapshot(
  response: Response,
): Promise<RecoveredRuntimeSnapshot | null> {
  const payload = (await response.json()) as RemoteRunResponse & {
    events?: unknown;
  };
  const output = validateRemoteRunResponse(payload);
  if (!output) {
    return null;
  }
  const toolEvents = Array.isArray(payload.events)
    ? payload.events
        .map(validateRemoteRunEvent)
        .filter(
          (event): event is AgentRunEvent =>
            event?.type === "tool_call" || event?.type === "tool_result",
        )
    : [];
  return { output, toolEvents };
}

function runtimeToolEventKey(event: AgentRunEvent): string | null {
  return event.type === "tool_call" || event.type === "tool_result"
    ? `${event.type}:${event.toolName}:${event.callId}`
    : null;
}

function assertManagedRuntimeFinalResponse(response: AgentOutput): void {
  if (
    !response.text.trim() &&
    (!response.attachments || response.attachments.length === 0)
  ) {
    throw new Error("Managed runtime did not produce a final response");
  }
  if (containsRuntimeToolCallProtocolFragments(response.text)) {
    throw new Error(
      "Managed runtime final response leaked tool-call protocol text",
    );
  }
  if (isRuntimeProgressOnlyResponseText(response.text)) {
    throw new Error(
      "Managed runtime final response contained only runtime-control/progress text",
    );
  }
}

async function* readWebSocketRunResponse(
  socket: AgentRuntimeWebSocket,
  emitMessageDeltas: boolean,
  onEvent?: (event: AgentRunEvent) => void,
  finalTimeoutMs = defaultRunSnapshotTimeoutMs,
): AsyncIterable<AgentRunEvent, AgentOutput | null> {
  const queue: unknown[] = [];
  let closed = false;
  let failed: Error | null = null;
  let wake: (() => void) | undefined;

  const wakeReader = () => {
    wake?.();
    wake = undefined;
  };

  socket.addEventListener("message", (event) => {
    try {
      queue.push(JSON.parse(String(event.data ?? "")));
    } catch (error) {
      failed =
        error instanceof Error ? error : new Error("Invalid runtime event");
    }
    wakeReader();
  });
  socket.addEventListener("error", () => {
    failed = new Error("Runtime event socket errored");
    wakeReader();
  });
  socket.addEventListener("close", () => {
    closed = true;
    wakeReader();
  });
  const timeout = setTimeout(() => {
    failed = new Error(
      `Managed runtime did not produce a final response within ${finalTimeoutMs}ms`,
    );
    socket.close();
    wakeReader();
  }, finalTimeoutMs);

  try {
    while (true) {
      while (queue.length > 0) {
        const event = validateRemoteRunEvent(queue.shift());
        if (!event) {
          throw new Error("Managed runtime returned an invalid stream event");
        }

        if (event.type === "error") {
          throw new Error(event.message);
        }

        if (event.type === "final") {
          onEvent?.(event);
          socket.close();
          return event.response;
        }

        if (
          (event.type === "message_delta" ||
            event.type === "message_replace") &&
          !emitMessageDeltas
        ) {
          continue;
        }

        onEvent?.(event);
        yield event;
      }

      if (failed) {
        throw failed;
      }
      if (closed) {
        throw new Error("Runtime event socket closed before final");
      }

      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    clearTimeout(timeout);
    socket.close();
  }
}

function runtimeMessageDeltasEnabled(runtime: RuntimeHandle | null): boolean {
  return runtime?.manifest?.streaming.messageDeltasEnabled !== false;
}

async function* readStreamingRunResponse(
  response: Response,
  emitMessageDeltas = true,
  onEvent?: (event: AgentRunEvent) => void,
  finalTimeoutMs = defaultRunSnapshotTimeoutMs,
): AsyncIterable<AgentRunEvent, AgentOutput | null> {
  if (!response.body) {
    return null;
  }

  let streamedText = "";
  const events = readRuntimeEventStream(response);
  const iterator = events[Symbol.asyncIterator]();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<IteratorResult<unknown>>((_, reject) => {
    timeout = setTimeout(() => {
      reject(
        new Error(
          `Managed runtime did not produce a final response within ${finalTimeoutMs}ms`,
        ),
      );
    }, finalTimeoutMs);
  });

  try {
    while (true) {
      const result = await Promise.race([iterator.next(), timeoutPromise]);
      if (result.done) {
        break;
      }
      const payload = result.value;
      const event = validateRemoteRunEvent(payload);
      if (!event) {
        throw new Error("Managed runtime returned an invalid stream event");
      }

      if (event.type === "error") {
        throw new Error(event.message);
      }

      if (event.type === "final") {
        onEvent?.(event);
        return event.response;
      }

      if (event.type === "message_delta") {
        streamedText = appendStreamedText(streamedText, event.text);
      } else if (event.type === "message_replace") {
        streamedText = event.text;
      }

      if (
        (event.type === "message_delta" || event.type === "message_replace") &&
        !emitMessageDeltas
      ) {
        continue;
      }

      onEvent?.(event);
      yield event;
    }
  } catch (error) {
    if (streamedText.trim() && isRuntimeStreamClosedError(error)) {
      return {
        classification: "user_private",
        text: streamedText.trim(),
      };
    }

    throw error;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    iterator.return?.().catch(() => undefined);
  }

  if (streamedText.trim()) {
    return {
      classification: "user_private",
      text: streamedText.trim(),
    };
  }
  return null;
}

function readRuntimeEventStream(response: Response): AsyncIterable<unknown> {
  return isSseResponse(response)
    ? readSse(response.body!)
    : readNdjson(response.body!);
}

function appendStreamedText(currentText: string, delta: string): string {
  if (!delta.trim()) {
    return currentText;
  }

  return currentText && !currentText.endsWith("...")
    ? `${currentText}${delta}`
    : delta.trimStart();
}

function isRuntimeStreamClosedError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return /socket connection was closed|event socket closed before final|connection.*closed|stream.*closed|terminated|econnreset/i.test(
    error.message,
  );
}

async function* readNdjson(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }

      buffer += decoder.decode(result.value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          const parsed = parseNdjsonRuntimeEvent(trimmed);
          if (parsed !== null) {
            yield parsed;
          }
        }
      }
    }

    buffer += decoder.decode();
    const trimmed = buffer.trim();
    if (trimmed) {
      const parsed = parseNdjsonRuntimeEvent(trimmed);
      if (parsed !== null) {
        yield parsed;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseNdjsonRuntimeEvent(line: string): unknown | null {
  if (!line.startsWith("{") && !line.startsWith("[")) {
    return null;
  }
  return JSON.parse(line);
}

async function* readSse(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const events: unknown[] = [];
  let parseError: Error | null = null;
  const parser = createParser({
    onEvent(event) {
      events.push(JSON.parse(event.data));
    },
    onError(error) {
      parseError = error;
    },
  });

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }

      parser.feed(decoder.decode(result.value, { stream: true }));
      if (parseError) {
        throw parseError;
      }

      while (events.length > 0) {
        yield events.shift();
      }
    }

    const remaining = decoder.decode();
    if (remaining) {
      parser.feed(remaining);
    }
    parser.reset({ consume: true });
    if (parseError) {
      throw parseError;
    }

    while (events.length > 0) {
      yield events.shift();
    }
  } finally {
    reader.releaseLock();
  }
}

function isStreamingResponse(response: Response): boolean {
  return isSseResponse(response) || isNdjsonResponse(response);
}

function isSseResponse(response: Response): boolean {
  return (response.headers.get("content-type") ?? "")
    .toLowerCase()
    .startsWith("text/event-stream");
}

function isNdjsonResponse(response: Response): boolean {
  return (response.headers.get("content-type") ?? "")
    .toLowerCase()
    .startsWith("application/x-ndjson");
}

function runtimeHeaders(runtime: RuntimeHandle | null): Record<string, string> {
  if (!runtime) {
    return {};
  }

  return {
    authorization: `Bearer ${runtime.authToken}`,
    "x-burble-runtime-token": runtime.authToken,
    "x-burble-runtime-id": runtime.id,
  };
}

function runtimeWebSocketOptions(
  runtime: RuntimeHandle | null,
): AgentRuntimeWebSocketOptions | undefined {
  if (!runtime) {
    return undefined;
  }
  return {
    headers: runtimeHeaders(runtime),
  };
}

function summarizeScheduledJob(input: AgentInput):
  | {
      jobId: string;
      capabilityProfile: string;
      allowedToolCount: number;
      routeId?: string;
      runtimeType?: string;
      stateRefCount: number;
      maxOutputVisibility: ToolClassification | "user_private";
      allowPrivateToolDeclassification: boolean;
    }
  | undefined {
  const scheduledJob = input.scheduledJob;
  if (!scheduledJob) {
    return undefined;
  }

  return {
    jobId: scheduledJob.jobId,
    capabilityProfile: scheduledJob.capabilityProfile,
    allowedToolCount: scheduledJob.allowedTools.length,
    ...(scheduledJob.routeId ? { routeId: scheduledJob.routeId } : {}),
    ...(scheduledJob.runtimeType
      ? { runtimeType: scheduledJob.runtimeType }
      : {}),
    stateRefCount: scheduledJob.stateRefs.length,
    maxOutputVisibility:
      scheduledJob.visibilityPolicy.maxOutputVisibility ?? "user_private",
    allowPrivateToolDeclassification:
      scheduledJob.visibilityPolicy.allowPrivateToolDeclassification === true,
  };
}

function sanitizeRuntimeHandle(runtime: RuntimeHandle): {
  id: string;
  engine: RuntimeHandle["engine"];
  status: RuntimeHandle["status"];
  policyHash?: string;
  manifest?: {
    version: string;
    policyHash: string;
    skills: Array<{ id: string; version: string; enabled: boolean }>;
    tools?: Array<{
      name: string;
      alias: string;
      provider: string;
      title: string;
      description: string;
      enabled: boolean;
      risk: "read" | "low_write" | "moderate_write" | "high_write";
      routeRequired: boolean;
      confirmation: "none" | "explicit" | "strong";
      input: Array<{
        name: string;
        type: string;
        required: boolean;
        nullable?: boolean;
        description?: string;
        values?: string[];
        aliases?: string[];
      }>;
    }>;
    memory: {
      userMemoryEnabled: boolean;
      workspaceMemoryEnabled: boolean;
      jobMemoryEnabled: boolean;
    };
    streaming: {
      messageDeltasEnabled: boolean;
    };
    memoryContext: Array<{
      scope: "user" | "workspace" | "job";
      ownerId: string;
      key: string;
      valuePreview: string;
      updatedAt: string;
    }>;
  };
} {
  return {
    id: runtime.id,
    engine: runtime.engine,
    status: runtime.status,
    ...(runtime.manifest
      ? {
          policyHash: runtime.manifest.policyHash,
          manifest: {
            version: runtime.manifest.version,
            policyHash: runtime.manifest.policyHash,
            skills: runtime.manifest.skills,
            tools: runtime.manifest.tools,
            memory: runtime.manifest.memory,
            streaming: runtime.manifest.streaming,
            memoryContext: runtime.manifest.memoryContext,
          },
        }
      : {}),
  };
}

const classifications: ReadonlySet<ToolClassification> = new Set([
  "public",
  "user_private",
  "restricted",
]);

function isRuntimeProviderProgressMarker(text: string): boolean {
  const normalized = text.trim().replace(/\s+/g, " ");
  return /^(?::gear:|⚙️?|gear:)?\s*(?:burble_provider_call|(?:github|google|gmail|hubspot|jira|slack|atlassian|scheduled_job|conversation)_[a-z0-9_]+)(?:\.{3}|…)?$/i.test(
    normalized,
  );
}

function validateRemoteRunResponse(
  payload: RemoteRunResponse,
): AgentOutput | null {
  const response = payload.response;
  if (!response) {
    return null;
  }

  if (
    typeof response.text !== "string" ||
    isRuntimeProviderProgressMarker(response.text) ||
    !classifications.has(response.classification)
  ) {
    return null;
  }

  if (
    "attachments" in response &&
    response.attachments !== undefined &&
    !isRuntimeAttachmentArray(response.attachments)
  ) {
    return null;
  }

  return response;
}

function validateRemoteRunStartResponse(
  payload: RemoteRunStartResponse,
): string | null {
  return typeof payload.runId === "string" && payload.runId.trim().length > 0
    ? payload.runId
    : null;
}

function validateRemoteRunEvent(payload: unknown): RemoteRunEvent | null {
  if (typeof payload !== "object" || payload === null || !("type" in payload)) {
    return null;
  }

  const event = payload as RemoteRunEvent;
  switch (event.type) {
    case "status":
    case "message_delta":
    case "message_replace":
      return typeof event.text === "string" ? event : null;
    case "tool_call":
      if (
        typeof event.toolName !== "string" ||
        typeof event.callId !== "string"
      ) {
        return null;
      }
      if ("input" in event && event.input !== undefined) {
        return typeof event.input === "object" &&
          event.input !== null &&
          !Array.isArray(event.input)
          ? event
          : null;
      }
      return event;
    case "tool_result":
      return typeof event.toolName === "string" &&
        typeof event.callId === "string" &&
        classifications.has(event.classification) &&
        (event.status === undefined ||
          event.status === "ok" ||
          event.status === "error") &&
        optionalBoundedString(event.errorCode, 128) &&
        optionalBoundedString(event.errorMessage, 500) &&
        optionalBoundedString(event.operation, 256)
        ? event
        : null;
    case "error":
      return typeof event.message === "string" ? event : null;
    case "final":
      return validateRemoteRunResponse({ response: event.response })
        ? event
        : null;
    default:
      return null;
  }
}

function optionalBoundedString(value: unknown, maxLength: number): boolean {
  return (
    value === undefined ||
    (typeof value === "string" && value.length > 0 && value.length <= maxLength)
  );
}

function toWebSocketUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol === "https:") {
    parsed.protocol = "wss:";
  } else if (parsed.protocol === "http:") {
    parsed.protocol = "ws:";
  }
  return parsed.toString();
}

function sanitizeAgentInput(
  input: AgentInput,
  options?: {
    config?: Config;
    runtimeId?: string;
    runId?: string;
    mcpGwConnectionStatuses?: McpGwRuntimeConnectionStatuses;
  },
): {
  text: string;
  attachments?: RuntimeAttachment[];
  conversation?: NonNullable<AgentInput["conversation"]>;
  context?: NonNullable<AgentInput["context"]>;
  toolGroups?: NonNullable<AgentInput["toolGroups"]>;
  scheduledJob?: NonNullable<AgentInput["scheduledJob"]>;
  connections: {
    github: ConnectionSummary;
    google: ConnectionSummary;
    hubspot: ConnectionSummary;
    jira: ConnectionSummary;
    slack: ConnectionSummary;
  };
} {
  const github = input.connections.github;
  const google = input.connections.google;
  const hubspot = input.connections.hubspot;
  const jira = input.connections.jira;
  const slack = input.connections.slack;

  const attachments =
    input.attachments && options?.config && options.runtimeId && options.runId
      ? sealRuntimeConversationAttachments(options.config, {
          runtimeId: options.runtimeId,
          runId: options.runId,
          attachments: input.attachments,
        })
      : input.attachments;

  return {
    text: input.text,
    ...(attachments ? { attachments } : {}),
    ...(input.conversation ? { conversation: input.conversation } : {}),
    ...(input.context ? { context: compactRuntimeContext(input.context) } : {}),
    ...(input.toolGroups ? { toolGroups: input.toolGroups } : {}),
    ...(input.scheduledJob ? { scheduledJob: input.scheduledJob } : {}),
    connections: {
      github: options?.mcpGwConnectionStatuses?.github
        ? options.mcpGwConnectionStatuses.github
        : github
        ? {
            connected: true,
            email: github.email,
            providerLogin: github.providerLogin,
          }
        : {
            connected: false,
          },
      google: options?.mcpGwConnectionStatuses?.google
        ? options.mcpGwConnectionStatuses.google
        : google
        ? {
            connected: true,
            email: google.email,
            providerLogin: google.providerLogin,
          }
        : {
            connected: false,
          },
      hubspot: hubspot
        ? {
            connected: true,
            email: hubspot.email,
            providerLogin: hubspot.providerLogin,
          }
        : {
            connected: false,
          },
      jira: jira
        ? {
            connected: true,
            email: jira.email,
            providerLogin: jira.providerLogin,
          }
        : {
            connected: false,
          },
      slack: slack
        ? {
            connected: true,
            email: slack.email,
            providerLogin: slack.providerLogin,
          }
        : {
            connected: false,
          },
    },
  };
}

async function resolveRuntimeMcpGwConnectionStatuses(input: {
  deps: ManagedRuntimeAgentRunnerDeps;
  principal: McpGwConnectionStatusPrincipal;
  principalId: string;
  cache: Map<string, McpGwConnectionStatusCacheEntry>;
  logInfo: (message: string) => void;
}): Promise<McpGwRuntimeConnectionStatuses> {
  if (!input.deps.resolveMcpGwConnectionStatuses) {
    return {};
  }
  const now = Date.now();
  const cached = input.cache.get(input.principalId);
  if (cached && cached.expiresAt > now) {
    return cached.statuses;
  }
  try {
    const statuses = await input.deps.resolveMcpGwConnectionStatuses(
      input.principal,
    );
    input.cache.set(input.principalId, {
      expiresAt:
        now +
        (input.deps.mcpGwConnectionStatusCacheTtlMs ??
          defaultMcpGwConnectionStatusCacheTtlMs),
      statuses,
    });
    return statuses;
  } catch (error) {
    input.logInfo(
      `Could not resolve MCP-GW connection statuses principal=${input.principalId} error=${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return {};
  }
}

function compactRuntimeContext(
  context: NonNullable<AgentInput["context"]>,
): NonNullable<AgentInput["context"]> {
  return {
    currentChannel: context.currentChannel,
    recentMessages: context.recentMessages
      .slice(-maxRuntimeRecentMessages)
      .map((message) => ({
        ...message,
        text: truncateRuntimeText(message.text, maxRuntimeRecentMessageChars),
      })),
  };
}

function truncateRuntimeText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function isRuntimeAttachmentArray(
  value: unknown,
): value is RuntimeAttachment[] {
  return Array.isArray(value) && value.every(isRuntimeAttachment);
}

function isRuntimeAttachment(value: unknown): value is RuntimeAttachment {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    record.id.trim().length > 0 &&
    (record.kind === "file" ||
      record.kind === "image" ||
      record.kind === "audio" ||
      record.kind === "video") &&
    typeof record.mimeType === "string" &&
    record.mimeType.trim().length > 0 &&
    (record.source === "slack" ||
      record.source === "burble" ||
      record.source === "agent") &&
    optionalString(record.name) &&
    (record.sizeBytes === undefined ||
      (typeof record.sizeBytes === "number" &&
        Number.isFinite(record.sizeBytes) &&
        record.sizeBytes >= 0)) &&
    optionalString(record.externalId)
  );
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}
