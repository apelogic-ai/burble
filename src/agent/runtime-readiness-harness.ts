import type { AgentRuntimeEngine, TokenStore } from "../db";
import {
  createRuntimeContractHttpClient,
  type RuntimeContractFetch
} from "./runtime-contract-http-client";
import type { PrincipalId, RuntimeFactory } from "./runtime-factory";
import { runtimeCompatibilityFamily } from "./runtime-descriptors";
import { runtimeCapabilityManifestCompatibility } from "./runtime-policy";

export type RuntimeReadinessSignalName =
  | "runtime.created"
  | "runtime.container_started"
  | "runtime.healthz_ok"
  | "runtime.capabilities_ok"
  | "runtime.ready_recorded";

export type RuntimeReadinessSignal = {
  name: RuntimeReadinessSignalName;
  status: "ok";
};

export type RuntimeReadinessReport = {
  engine: AgentRuntimeEngine;
  runtimeId: string;
  endpointUrl: string;
  signals: RuntimeReadinessSignal[];
};

export async function runRuntimeReadinessCheck(input: {
  engine: AgentRuntimeEngine;
  principal: PrincipalId;
  runtimeFactory: RuntimeFactory;
  store: TokenStore;
  fetch?: RuntimeContractFetch;
}): Promise<RuntimeReadinessReport> {
  const signals: RuntimeReadinessSignal[] = [];
  const runtime = await input.runtimeFactory.getOrCreateRuntime(input.principal);
  if (!runtime.id || !runtime.endpointUrl) {
    failSignal("runtime.created", "runtime factory did not return a runtime");
  }
  if (runtime.engine !== input.engine) {
    failSignal(
      "runtime.created",
      `factory returned ${runtime.engine}, expected ${input.engine}`
    );
  }
  signals.push({ name: "runtime.created", status: "ok" });

  const provisionEvents = input.store
    .listAgentRuntimeEvents(runtime.id)
    .map((event) => event.eventType);
  if (!provisionEvents.includes("runtime_provision_requested")) {
    failSignal(
      "runtime.container_started",
      "runtime provisioning was not recorded"
    );
  }
  signals.push({ name: "runtime.container_started", status: "ok" });

  const client = createRuntimeContractHttpClient({
    baseUrl: runtime.endpointUrl,
    fetch: input.fetch,
    headers: {
      "x-burble-runtime-id": runtime.id
    }
  });
  const health = await client.health();
  if (!health.ok) {
    failSignal("runtime.healthz_ok", health.detail);
  }
  signals.push({ name: "runtime.healthz_ok", status: "ok" });

  const manifest = await client.getCapabilityManifest();
  if (
    runtimeCompatibilityFamily(manifest.runtimeType) !==
    runtimeCompatibilityFamily(input.engine)
  ) {
    failSignal(
      "runtime.capabilities_ok",
      `manifest reported ${manifest.runtimeType}, expected ${input.engine}`
    );
  }
  const compatibility = runtimeCapabilityManifestCompatibility(
    input.engine,
    manifest
  );
  if (!compatibility.selectable) {
    failSignal(
      "runtime.capabilities_ok",
      `manifest is missing required capabilities: ${compatibility.reasons.join(", ")}`
    );
  }
  signals.push({ name: "runtime.capabilities_ok", status: "ok" });

  const record = input.store.getAgentRuntime(runtime.id);
  if (record?.status !== "ready") {
    failSignal(
      "runtime.ready_recorded",
      `runtime status is ${record?.status ?? "missing"}`
    );
  }
  signals.push({ name: "runtime.ready_recorded", status: "ok" });

  return {
    engine: input.engine,
    runtimeId: runtime.id,
    endpointUrl: runtime.endpointUrl,
    signals
  };
}

function failSignal(name: RuntimeReadinessSignalName, detail?: string): never {
  throw new Error(
    `Runtime readiness check failed: ${name}${detail ? `: ${detail}` : ""}`
  );
}
