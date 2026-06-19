import type { AgentRuntimeEngine } from "../db";
import { providerToolCatalog } from "../providers/catalog";
import { buildRuntimeManifest } from "./runtime-manifest";
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
  assertClaimedCapabilities?: boolean;
}): Promise<RuntimeConformanceReport> {
  const runtime = await input.runtimeFactory.getOrCreateRuntime(input.principal);
  const baseUrl =
    (await input.resolveBaseUrl?.(runtime)) ?? runtime.endpointUrl;
  const runtimeManifest = buildRuntimeManifest({
    principal: input.principal,
    runtime: {
      engine: input.engine,
      factory: "static",
      ttlMs: 0,
      reaperEnabled: false
    },
    defaultModel: "openai:gpt-5.4",
    defaultStreaming: true,
    workspacePolicy: [],
    userPreferences: [],
    toolCatalog: providerToolCatalog
  });
  const report = await runRuntimeContractSmokeTest({
    client: createRuntimeContractHttpClient({
      baseUrl,
      fetch: input.fetch,
      webSocketFactory: input.webSocketFactory,
      headers: {
        authorization: `Bearer ${runtime.authToken}`,
        "x-burble-runtime-id": runtime.id
      }
    }),
    assertClaimedCapabilities: input.assertClaimedCapabilities ?? true,
    request: {
      runId: `contract-${runtime.id}`,
      principal: input.principal,
      runtime: {
        id: runtime.id,
        engine: input.engine,
        manifest: {
          version: runtimeManifest.version,
          policyHash: runtimeManifest.policyHash,
          skills: runtimeManifest.skills,
          tools: runtimeManifest.tools,
          memory: runtimeManifest.memory,
          streaming: runtimeManifest.streaming,
          memoryContext: runtimeManifest.memoryContext
        }
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
