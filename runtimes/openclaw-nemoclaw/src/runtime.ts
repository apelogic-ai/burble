import type { RuntimeConfig } from "./config";
import { createBurbleToolExecutor } from "./burble-tools";
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
      const effectiveConfig = resolveRuntimeConfigForRequest(config, request);
      await prepareNativeOpenClawIfNeeded(effectiveConfig, request, options);
      return createRuntimeAgentAdapter(effectiveConfig).run(request, executeTool);
    },
    async *stream(
      request,
      executeTool = createBurbleToolExecutor(config, request.runtime?.id, request)
    ) {
      const effectiveConfig = resolveRuntimeConfigForRequest(config, request);
      yield* prepareRuntimeConfigForRequest(effectiveConfig, request, options);
      yield* createRuntimeAgentAdapter(effectiveConfig).stream(request, executeTool);
    }
  };
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
  return (
    request.executionMode === "native-runtime" ||
    request.executionMode === "openclaw-native"
  );
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
