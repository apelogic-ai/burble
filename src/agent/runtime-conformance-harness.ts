import type { AgentRuntimeEngine } from "../db";
import {
  createRuntimeContractHttpClient,
  type RuntimeContractFetch,
  type RuntimeContractWebSocketFactory
} from "./runtime-contract-http-client";
import {
  runRuntimeContractSmokeTest,
  type RuntimeContractSmokeTestReport
} from "./runtime-contract-harness";
import type { PrincipalId, RuntimeFactory, RuntimeHandle } from "./runtime-factory";

export type RuntimeConformanceReport = RuntimeContractSmokeTestReport & {
  engine: AgentRuntimeEngine;
  runtimeId: string;
  endpointUrl: string;
};

export async function runRuntimeConformanceCheck(input: {
  engine: AgentRuntimeEngine;
  principal: PrincipalId;
  runtimeFactory: RuntimeFactory;
  resolveBaseUrl?: (runtime: RuntimeHandle) => string | Promise<string>;
  fetch?: RuntimeContractFetch;
  webSocketFactory?: RuntimeContractWebSocketFactory;
}): Promise<RuntimeConformanceReport> {
  const runtime = await input.runtimeFactory.getOrCreateRuntime(input.principal);
  const baseUrl =
    (await input.resolveBaseUrl?.(runtime)) ?? runtime.endpointUrl;
  const report = await runRuntimeContractSmokeTest({
    client: createRuntimeContractHttpClient({
      baseUrl,
      fetch: input.fetch,
      webSocketFactory: input.webSocketFactory,
      headers: {
        "x-burble-runtime-id": runtime.id
      }
    }),
    request: {
      runId: `contract-${runtime.id}`,
      principal: input.principal,
      runtime: {
        id: runtime.id,
        engine: input.engine
      },
      input: {
        text: "runtime contract probe",
        conversation: {
          routeId: "convrt_contract_probe",
          source: "slack",
          workspaceId: input.principal.workspaceId,
          channelId: "D_CONTRACT_PROBE",
          rootId: "dm:D_CONTRACT_PROBE",
          isDirectMessage: true
        },
        connections: {
          github: { connected: false }
        }
      }
    }
  });

  return {
    ...report,
    engine: input.engine,
    runtimeId: runtime.id,
    endpointUrl: runtime.endpointUrl
  };
}
