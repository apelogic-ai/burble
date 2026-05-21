import type { RuntimeConfig } from "./config";
import { createBurbleToolExecutor } from "./burble-tools";
import { runOpenClawCliRequest } from "./openclaw-cli";
import { runBurbleRequest } from "./runner";
import type { RunRequest, RunResponse, ToolExecutor } from "./types";

export function createRuntimeRunner(config: RuntimeConfig): {
  run: (request: RunRequest, executeTool?: ToolExecutor) => Promise<RunResponse>;
} {
  return {
    run: (request, executeTool = createBurbleToolExecutor(config)) => {
      switch (config.engine) {
        case "deterministic":
          return runBurbleRequest(request, config, executeTool);
        case "openclaw":
          return runOpenClawCliRequest(request, config, executeTool);
      }
    }
  };
}
