import type { Config } from "../../config";
import type { SandboxProvider } from "../sandbox-provider";
import { createOpenShellSandboxProvider } from "./openshell";
import {
  createOpenShellHttpSandboxClient,
  type OpenShellHttpFetch
} from "./openshell-http-client";
import { createOpenShellGrpcSandboxClient } from "./openshell-grpc-client";

export type ConfiguredSandboxProviderOptions = {
  fetch?: OpenShellHttpFetch;
};

export function createConfiguredSandboxProvider(
  config: Config,
  options: ConfiguredSandboxProviderOptions = {}
): SandboxProvider {
  if (!config.agentRuntimeSandboxUrl) {
    throw new Error(
      "AGENT_RUNTIME_FACTORY=sandbox requires AGENT_RUNTIME_SANDBOX_URL"
    );
  }

  return createOpenShellSandboxProvider({
    client:
      config.agentRuntimeSandboxTransport === "http"
        ? createOpenShellHttpSandboxClient({
            baseUrl: config.agentRuntimeSandboxUrl,
            token: config.agentRuntimeSandboxToken,
            fetch: options.fetch
          })
        : createOpenShellGrpcSandboxClient({
            endpoint: config.agentRuntimeSandboxUrl,
            token: config.agentRuntimeSandboxToken
          })
  });
}
