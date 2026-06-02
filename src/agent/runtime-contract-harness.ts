import {
  parseRuntimeCapabilityManifest,
  parseRuntimeRunEvent,
  parseRuntimeRunRequest,
  type RuntimeCapabilityManifest,
  type RuntimeRunEvent,
  type RuntimeRunRequest,
  type RuntimeUsage
} from "./runtime-contract";

export type RuntimeContractClient = {
  getCapabilityManifest: () => Promise<unknown>;
  health: () => Promise<{ ok: boolean; detail?: string }>;
  startRun: (request: RuntimeRunRequest) => Promise<{ runId: string }>;
  streamRunEvents: (runId: string) => AsyncIterable<unknown>;
};

export type RuntimeContractCheckName =
  | "manifest"
  | "health"
  | "run_accepted"
  | "events_stream"
  | "final_response"
  | "usage";

export type RuntimeContractCheck = {
  name: RuntimeContractCheckName;
  status: "ok";
};

export type RuntimeContractSmokeTestReport = {
  runtimeType: RuntimeCapabilityManifest["runtimeType"];
  runId: string;
  checks: RuntimeContractCheck[];
};

export async function runRuntimeContractSmokeTest(input: {
  client: RuntimeContractClient;
  request: RuntimeRunRequest | unknown;
}): Promise<RuntimeContractSmokeTestReport> {
  const checks: RuntimeContractCheck[] = [];
  const manifest = parseRuntimeCapabilityManifest(
    await input.client.getCapabilityManifest()
  );
  checks.push({ name: "manifest", status: "ok" });

  const health = await input.client.health();
  if (!health.ok) {
    failCheck("health", health.detail);
  }
  checks.push({ name: "health", status: "ok" });

  const request = parseRuntimeRunRequest(input.request);
  const start = await input.client.startRun(request);
  if (!start.runId) {
    failCheck("run_accepted", "runtime did not return a run id");
  }
  checks.push({ name: "run_accepted", status: "ok" });

  let sawEvent = false;
  let finalEvent: Extract<RuntimeRunEvent, { type: "final" }> | null = null;
  let usage: RuntimeUsage | null = null;
  for await (const rawEvent of input.client.streamRunEvents(start.runId)) {
    sawEvent = true;
    const event = parseRuntimeRunEvent(rawEvent);
    if (event.type === "usage") {
      usage = event.usage;
    }
    if (event.type === "final") {
      finalEvent = event;
      usage ??= event.response.usage ?? null;
      break;
    }
  }

  if (!sawEvent) {
    failCheck("events_stream", "runtime event stream was empty");
  }
  checks.push({ name: "events_stream", status: "ok" });

  if (!finalEvent) {
    failCheck("final_response", "runtime did not emit a final event");
  }
  checks.push({ name: "final_response", status: "ok" });

  if (manifest.usageReporting === "exact" && !usage) {
    failCheck("usage", "runtime claims exact usage but emitted none");
  }
  checks.push({ name: "usage", status: "ok" });

  return {
    runtimeType: manifest.runtimeType,
    runId: start.runId,
    checks
  };
}

function failCheck(name: RuntimeContractCheckName, detail?: string): never {
  throw new Error(
    `Runtime contract check failed: ${name}${detail ? `: ${detail}` : ""}`
  );
}
