import type { RuntimeConfig } from "./config";
import { createBurbleToolExecutor } from "./burble-tools";
import {
  runOpenClawCliRequest,
  runOpenClawCliRequestStream
} from "./openclaw-cli";
import { runBurbleRequest } from "./runner";
import type { RunEvent, RunRequest, RunResponse, ToolExecutor } from "./types";

export type RuntimeAgentAdapter = {
  name: string;
  run: (request: RunRequest, executeTool: ToolExecutor) => Promise<RunResponse>;
  stream: (
    request: RunRequest,
    executeTool: ToolExecutor
  ) => AsyncIterable<RunEvent>;
};

export function createRuntimeRunner(config: RuntimeConfig): {
  run: (request: RunRequest, executeTool?: ToolExecutor) => Promise<RunResponse>;
  stream: (
    request: RunRequest,
    executeTool?: ToolExecutor
  ) => AsyncIterable<RunEvent>;
} {
  const adapter = createRuntimeAgentAdapter(config);

  return {
    run: (
      request,
      executeTool = createBurbleToolExecutor(config, request.runtime?.id)
    ) => adapter.run(request, executeTool),
    async *stream(
      request,
      executeTool = createBurbleToolExecutor(config, request.runtime?.id)
    ) {
      yield* adapter.stream(request, executeTool);
    }
  };
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
