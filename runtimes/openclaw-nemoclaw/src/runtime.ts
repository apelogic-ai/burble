import type { RuntimeConfig } from "./config";
import {
  createBurbleToolExecutor,
  probeBurbleProviderToolReachability
} from "./burble-tools";
import {
  runOpenClawCliRequest,
  runOpenClawCliRequestStream
} from "./openclaw-cli";
import { runBurbleRequest } from "./runner";
import type { RunEvent, RunRequest, RunResponse, ToolExecutor } from "./types";

const nativeExecutionTimeoutMs = 10 * 60 * 1000;

export type RuntimeAgentAdapter = {
  name: string;
  run: (request: RunRequest, executeTool: ToolExecutor) => Promise<RunResponse>;
  stream: (
    request: RunRequest,
    executeTool: ToolExecutor
  ) => AsyncIterable<RunEvent>;
};

export type RuntimeRunnerOptions = {
  prepareNativeOpenClaw?: (config: RuntimeConfig) => Promise<void>;
};

export function createRuntimeRunner(
  config: RuntimeConfig,
  options: RuntimeRunnerOptions = {}
): {
  run: (request: RunRequest, executeTool?: ToolExecutor) => Promise<RunResponse>;
  stream: (
    request: RunRequest,
    executeTool?: ToolExecutor
  ) => AsyncIterable<RunEvent>;
} {
  return {
    async run(
      request,
      executeTool = createBurbleToolExecutor(config, request.runtime?.id, request)
    ) {
      if (config.contractProbeMode) {
        return { response: runtimeContractProbeResponse(request) };
      }
      const effectiveConfig = resolveRuntimeConfigForRequest(config, request);
      await prepareNativeOpenClawIfNeeded(effectiveConfig, request, options);
      return createRuntimeAgentAdapter(effectiveConfig).run(request, executeTool);
    },
    async *stream(
      request,
      executeTool = createBurbleToolExecutor(config, request.runtime?.id, request)
    ) {
      if (config.contractProbeMode) {
        yield* streamRuntimeContractProbe(request, config);
        return;
      }
      const effectiveConfig = resolveRuntimeConfigForRequest(config, request);
      yield* prepareRuntimeConfigForRequest(effectiveConfig, request, options);
      yield* createRuntimeAgentAdapter(effectiveConfig).stream(request, executeTool);
    }
  };
}

function runtimeContractProbeResponse(
  request?: Pick<RunRequest, "input">
): RunResponse["response"] {
  const text = request?.input.scheduledJob
    ? "Runtime contract scheduled provider capability response."
    : request?.input.text === "runtime contract tool reachability probe"
      ? "Runtime contract tool reachability response."
    : request?.input.text === "runtime contract tool capability probe"
      ? "Runtime contract tool capability response."
      : "Runtime contract probe response.";
  return {
    classification: "user_private",
    text,
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      usageSource: "contract-probe"
    }
  };
}

async function* streamRuntimeContractProbe(
  request: Pick<RunRequest, "input" | "runtime">,
  config: RuntimeConfig
): AsyncIterable<RunEvent> {
  yield { type: "status", text: "Runtime contract probe accepted." };
  if (request.input.scheduledJob) {
    yield {
      type: "tool_call",
      toolName: "scheduledJob.registerCapability",
      callId: "contract-scheduled-provider-probe"
    };
    yield {
      type: "tool_result",
      toolName: "scheduledJob.registerCapability",
      callId: "contract-scheduled-provider-probe",
      classification: "user_private"
    };
    yield {
      type: "tool_call",
      toolName: "burble_provider_call",
      callId: "contract-scheduled-provider-bridge-probe",
      input: {
        toolName: "runtime.conformance.echo",
        input: {
          jobId: request.input.scheduledJob.jobId,
          message: "scheduled provider bridge probe"
        }
      }
    };
    const probed = await probeBurbleProviderToolReachability(
      "runtime.conformance.echo",
      request as RunRequest,
      config,
      {
        jobId: request.input.scheduledJob.jobId,
        message: "scheduled provider bridge probe"
      }
    );
    yield {
      type: "tool_result",
      toolName: "burble_provider_call",
      callId: "contract-scheduled-provider-bridge-probe",
      classification: "user_private",
      content: probed.content
    };
  } else if (request.input.text === "runtime contract tool capability probe") {
    yield {
      type: "tool_call",
      toolName: "runtime.conformance.echo",
      callId: "contract-tool-probe"
    };
    yield {
      type: "tool_result",
      toolName: "runtime.conformance.echo",
      callId: "contract-tool-probe",
      classification: "user_private"
    };
  } else if (request.input.text === "runtime contract tool reachability probe") {
    for (const [index, tool] of reachableManifestTools(request).entries()) {
      const callId = `contract-tool-reachability-${index}`;
      const probed = await probeBurbleProviderToolReachability(
        tool.alias,
        request,
        config
      );
      yield {
        type: "tool_call",
        toolName: probed.toolName,
        callId,
        input: probed.input
      };
      yield {
        type: "tool_result",
        toolName: probed.toolName,
        callId,
        classification: "user_private",
        content: probed.content
      };
    }
  } else if (
    request.input.text === "runtime contract attachment capability probe"
  ) {
    yield {
      type: "tool_call",
      toolName: "conversation.getAttachment",
      callId: "contract-attachment-probe",
      input: {
        attachmentId:
          request.input.attachments?.[0]?.id ?? "attcap_contract_probe"
      }
    };
    yield {
      type: "tool_result",
      toolName: "conversation.getAttachment",
      callId: "contract-attachment-probe",
      classification: "user_private",
      content: { text: "contract attachment content" }
    };
  }
  const response = runtimeContractProbeResponse(request);
  yield { type: "message_delta", text: response.text };
  yield { type: "final", response };
}

function reachableManifestTools(
  request: Pick<RunRequest, "runtime">
): Array<{ alias: string }> {
  return (request.runtime?.manifest?.tools ?? [])
    .filter((tool) => tool.enabled === true && tool.alias.length > 0)
    .map((tool) => ({ alias: tool.alias }));
}

export function resolveRuntimeConfigForRequest(
  config: RuntimeConfig,
  request: Pick<RunRequest, "executionMode">
): RuntimeConfig {
  if (!isNativeRuntimeExecutionMode(request)) {
    return config;
  }

  return {
    ...config,
    engine: "openclaw-gateway",
    openClawSetupOnStart: true,
    openClawTimeoutMs: Math.max(config.openClawTimeoutMs, nativeExecutionTimeoutMs)
  };
}

async function* prepareRuntimeConfigForRequest(
  config: RuntimeConfig,
  request: Pick<RunRequest, "executionMode">,
  options: RuntimeRunnerOptions
): AsyncIterable<RunEvent> {
  if (!isNativeRuntimeExecutionMode(request)) {
    return;
  }

  yield {
    type: "status",
    text: "Preparing native agent runtime..."
  };
  await options.prepareNativeOpenClaw?.(config);
}

async function prepareNativeOpenClawIfNeeded(
  config: RuntimeConfig,
  request: Pick<RunRequest, "executionMode">,
  options: RuntimeRunnerOptions
): Promise<void> {
  if (!isNativeRuntimeExecutionMode(request)) {
    return;
  }

  await options.prepareNativeOpenClaw?.(config);
}

function isNativeRuntimeExecutionMode(
  request: Pick<RunRequest, "executionMode">
): boolean {
  return request.executionMode === "native-runtime";
}

export function createRuntimeAgentAdapter(
  config: RuntimeConfig
): RuntimeAgentAdapter {
  switch (config.engine) {
    case "deterministic":
      return createDeterministicAdapter(config);
    case "openclaw":
      return createOpenClawCliAdapter(config, "openclaw-cli");
    case "openclaw-gateway":
      return createOpenClawCliAdapter(config, "openclaw-gateway");
    case "burble-direct":
      return createOpenClawCliAdapter(config, "burble-direct");
  }
}

function createDeterministicAdapter(config: RuntimeConfig): RuntimeAgentAdapter {
  return {
    name: "deterministic",
    run: (request, executeTool) => runBurbleRequest(request, config, executeTool),
    async *stream(request, executeTool) {
      yield { type: "status", text: "Loading Burble context..." };
      const result = await runBurbleRequest(request, config, executeTool);
      yield { type: "final", response: result.response };
    }
  };
}

function createOpenClawCliAdapter(
  config: RuntimeConfig,
  name: "openclaw-cli" | "openclaw-gateway" | "burble-direct"
): RuntimeAgentAdapter {
  return {
    name,
    run: (request, executeTool) =>
      runOpenClawCliRequest(request, config, executeTool),
    stream: (request, executeTool) =>
      runOpenClawCliRequestStream(request, config, executeTool)
  };
}
