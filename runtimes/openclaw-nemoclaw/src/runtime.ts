import type { RuntimeConfig } from "./config";
import { createBurbleToolExecutor } from "./burble-tools";
import {
  runOpenClawCliRequest,
  runOpenClawCliRequestStream
} from "./openclaw-cli";
import { runBurbleRequest } from "./runner";
import type { RunEvent, RunRequest, RunResponse, ToolExecutor } from "./types";

export function createRuntimeRunner(config: RuntimeConfig): {
  run: (request: RunRequest, executeTool?: ToolExecutor) => Promise<RunResponse>;
  stream: (
    request: RunRequest,
    executeTool?: ToolExecutor
  ) => AsyncIterable<RunEvent>;
} {
  return {
    run: (
      request,
      executeTool = createBurbleToolExecutor(config, request.runtime?.id)
    ) => {
      switch (config.engine) {
        case "deterministic":
          return runBurbleRequest(request, config, executeTool);
        case "openclaw":
          return runOpenClawCliRequest(request, config, executeTool);
      }
    },
    async *stream(
      request,
      executeTool = createBurbleToolExecutor(config, request.runtime?.id)
    ) {
      switch (config.engine) {
        case "deterministic": {
          yield { type: "status", text: "Loading Burble GitHub context..." };
          const result = await runBurbleRequest(request, config, executeTool);
          yield { type: "final", response: result.response };
          return;
        }
        case "openclaw":
          yield* runOpenClawCliRequestStream(request, config, executeTool);
          return;
      }
    }
  };
}
