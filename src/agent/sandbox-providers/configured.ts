import type { Config } from "../../config";
import type { SandboxProvider } from "../sandbox-provider";
import { createOpenShellSandboxProvider } from "./openshell";
import { createOpenShellCliSandboxClient } from "./openshell-cli-client";
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
        : config.agentRuntimeSandboxTransport === "cli"
          ? createOpenShellCliSandboxClient({
              gatewayEndpoint: config.agentRuntimeSandboxUrl,
              openshellBin: config.agentRuntimeOpenShellCliBin,
              token: config.agentRuntimeSandboxToken
            })
        : createOpenShellGrpcSandboxClient({
            endpoint: config.agentRuntimeSandboxUrl,
            token: config.agentRuntimeSandboxToken
          })
  });
}
