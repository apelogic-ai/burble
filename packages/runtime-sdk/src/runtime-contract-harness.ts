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
  getCapabilityManifest: () => Promise<RuntimeCapabilityManifest>;
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
  | "usage"
  | "tool_calls"
  | "tool_reachability"
  | "scheduled_provider_calls"
  | "attachments";

export type RuntimeContractCheck = {
  name: RuntimeContractCheckName;
  status: "ok";
};

export type RuntimeContractSmokeTestReport = {
  runtimeType: RuntimeCapabilityManifest["runtimeType"];
  manifest: RuntimeCapabilityManifest;
  runId: string;
  checks: RuntimeContractCheck[];
};

export async function runRuntimeContractSmokeTest(input: {
  client: RuntimeContractClient;
  request: RuntimeRunRequest | unknown;
  assertClaimedCapabilities?: boolean;
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

  if (input.assertClaimedCapabilities) {
    if (manifest.toolCalls) {
      await assertToolCallCapability(input.client, request);
      checks.push({ name: "tool_calls", status: "ok" });
      await assertToolReachability(input.client, request);
      checks.push({ name: "tool_reachability", status: "ok" });
    }
    if (manifest.scheduledProviderCalls) {
      await assertScheduledProviderCapability(input.client, request);
      checks.push({ name: "scheduled_provider_calls", status: "ok" });
    }
    if (manifest.attachments) {
      await assertAttachmentCapability(input.client, request);
      checks.push({ name: "attachments", status: "ok" });
    }
  }

  return {
    runtimeType: manifest.runtimeType,
    manifest,
    runId: start.runId,
    checks
  };
}

async function assertToolCallCapability(
  client: RuntimeContractClient,
  baseRequest: RuntimeRunRequest
): Promise<void> {
  const runId = `${baseRequest.runId ?? "contract"}-tool-capability`;
  const events = await runProbe(client, {
    ...baseRequest,
    runId,
    input: {
      ...baseRequest.input,
      text: "runtime contract tool capability probe",
      scheduledJob: undefined
    }
  });
  const toolCall = events.find(
    (event): event is Extract<RuntimeRunEvent, { type: "tool_call" }> =>
      event.type === "tool_call"
  );
  if (!toolCall) {
    failCheck(
      "tool_calls",
      "runtime claims toolCalls but emitted no tool_call event during probe"
    );
  }
  const toolResult = events.find(
    (event): event is Extract<RuntimeRunEvent, { type: "tool_result" }> =>
      event.type === "tool_result" &&
      event.toolName === toolCall.toolName &&
      event.callId === toolCall.callId
  );
  if (!toolResult) {
    failCheck(
      "tool_calls",
      `runtime claims toolCalls but emitted no matching tool_result for ${toolCall.toolName}`
    );
  }
}

async function assertScheduledProviderCapability(
  client: RuntimeContractClient,
  baseRequest: RuntimeRunRequest
): Promise<void> {
  const runId = `${baseRequest.runId ?? "contract"}-scheduled-provider`;
  const events = await runProbe(client, {
    ...baseRequest,
    runId,
    input: {
      ...baseRequest.input,
      text: "runtime contract scheduled provider capability probe",
      scheduledJob: {
        jobId: "contract-scheduled-job",
        capabilityProfile: "contract-probe",
        allowedTools: ["runtime.conformance.echo"],
        routeId:
          baseRequest.input.conversation?.routeId ?? "convrt_contract_probe",
        stateRefs: [],
        visibilityPolicy: {
          maxOutputVisibility: "user_private",
          allowPrivateToolDeclassification: false
        }
      }
    }
  });
  const registrationCall = events.find(
    (event): event is Extract<RuntimeRunEvent, { type: "tool_call" }> =>
      event.type === "tool_call" &&
      event.toolName === "scheduledJob.registerCapability"
  );
  if (!registrationCall) {
    failCheck(
      "scheduled_provider_calls",
      "runtime claims scheduledProviderCalls but emitted no scheduledJob.registerCapability tool_call during probe"
    );
  }
  const registrationResult = events.find(
    (event): event is Extract<RuntimeRunEvent, { type: "tool_result" }> =>
      event.type === "tool_result" &&
      event.toolName === registrationCall.toolName &&
      event.callId === registrationCall.callId
  );
  if (!registrationResult) {
    failCheck(
      "scheduled_provider_calls",
      "runtime claims scheduledProviderCalls but emitted no matching scheduledJob.registerCapability tool_result"
    );
  }
  const providerBridgeCall = events.find(
    (event): event is Extract<RuntimeRunEvent, { type: "tool_call" }> =>
      event.type === "tool_call" && event.toolName === "burble_provider_call"
  );
  if (!providerBridgeCall) {
    failCheck(
      "scheduled_provider_calls",
      "runtime claims scheduledProviderCalls but emitted no burble_provider_call tool_call during scheduled provider probe"
    );
  }
  assertScheduledProviderBridgeEnvelope(providerBridgeCall.input);
  const providerBridgeResult = events.find(
    (event): event is Extract<RuntimeRunEvent, { type: "tool_result" }> =>
      event.type === "tool_result" &&
      event.toolName === providerBridgeCall.toolName &&
      event.callId === providerBridgeCall.callId
  );
  if (!providerBridgeResult) {
    failCheck(
      "scheduled_provider_calls",
      "runtime claims scheduledProviderCalls but emitted no matching burble_provider_call tool_result"
    );
  }
}

function assertScheduledProviderBridgeEnvelope(input: unknown): void {
  if (!isRecord(input)) {
    failCheck(
      "scheduled_provider_calls",
      "runtime emitted burble_provider_call without an object input envelope"
    );
  }
  if (input.toolName !== "runtime.conformance.echo") {
    failCheck(
      "scheduled_provider_calls",
      "runtime emitted burble_provider_call with an unexpected toolName"
    );
  }
  if (!isRecord(input.input)) {
    failCheck(
      "scheduled_provider_calls",
      "runtime emitted burble_provider_call without inner input"
    );
  }
  if (input.input.jobId !== "contract-scheduled-job") {
    failCheck(
      "scheduled_provider_calls",
      "runtime emitted burble_provider_call without the trusted scheduled job id"
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function assertToolReachability(
  client: RuntimeContractClient,
  baseRequest: RuntimeRunRequest
): Promise<void> {
  const manifestTools = baseRequest.runtime.manifest?.tools?.filter(
    (tool) => tool.enabled
  );
  if (!manifestTools?.length) {
    return;
  }

  const runId = `${baseRequest.runId ?? "contract"}-tool-reachability`;
  const events = await runProbe(client, {
    ...baseRequest,
    runId,
    input: {
      ...baseRequest.input,
      text: "runtime contract tool reachability probe",
      scheduledJob: undefined
    }
  });

  for (const tool of manifestTools) {
    const names = new Set([tool.name, tool.alias]);
    const toolCall = events.find(
      (event): event is Extract<RuntimeRunEvent, { type: "tool_call" }> =>
        event.type === "tool_call" && names.has(event.toolName)
    );
    if (!toolCall) {
      failCheck(
        "tool_reachability",
        `runtime did not emit a tool_call for manifest tool ${tool.name}`
      );
    }
    const toolResult = events.find(
      (event): event is Extract<RuntimeRunEvent, { type: "tool_result" }> =>
        event.type === "tool_result" &&
        event.toolName === toolCall.toolName &&
        event.callId === toolCall.callId
    );
    if (!toolResult) {
      failCheck(
        "tool_reachability",
        `runtime did not emit a matching tool_result for manifest tool ${tool.name}`
      );
    }
  }
}

async function assertAttachmentCapability(
  client: RuntimeContractClient,
  baseRequest: RuntimeRunRequest
): Promise<void> {
  const runId = `${baseRequest.runId ?? "contract"}-attachment-capability`;
  const attachmentId = "attcap_contract_probe";
  const events = await runProbe(client, {
    ...baseRequest,
    runId,
    input: {
      ...baseRequest.input,
      text: "runtime contract attachment capability probe",
      scheduledJob: undefined,
      attachments: [
        {
          id: attachmentId,
          source: "slack",
          kind: "file",
          name: "contract-attachment.txt",
          mimeType: "text/plain",
          sizeBytes: 27
        }
      ]
    }
  });
  const attachmentCall = events.find(
    (event): event is Extract<RuntimeRunEvent, { type: "tool_call" }> =>
      event.type === "tool_call" &&
      event.toolName === "conversation.getAttachment"
  );
  if (!attachmentCall) {
    failCheck(
      "attachments",
      "runtime claims attachments but emitted no conversation.getAttachment tool_call during probe"
    );
  }
  const attachmentInput =
    attachmentCall.input && typeof attachmentCall.input === "object"
      ? (attachmentCall.input as { attachmentId?: unknown })
      : {};
  if (attachmentInput.attachmentId !== attachmentId) {
    failCheck(
      "attachments",
      "runtime claims attachments but did not request the current probe attachment id"
    );
  }
  const attachmentResult = events.find(
    (event): event is Extract<RuntimeRunEvent, { type: "tool_result" }> =>
      event.type === "tool_result" &&
      event.toolName === "conversation.getAttachment" &&
      event.callId === attachmentCall.callId
  );
  if (!attachmentResult) {
    failCheck(
      "attachments",
      "runtime claims attachments but emitted no matching conversation.getAttachment tool_result during probe"
    );
  }
}

async function runProbe(
  client: RuntimeContractClient,
  request: RuntimeRunRequest
): Promise<RuntimeRunEvent[]> {
  const start = await client.startRun(request);
  if (!start.runId) {
    failCheck("run_accepted", "runtime did not return a run id");
  }
  const events: RuntimeRunEvent[] = [];
  for await (const rawEvent of client.streamRunEvents(start.runId)) {
    const event = parseRuntimeRunEvent(rawEvent);
    events.push(event);
    if (event.type === "final") {
      break;
    }
  }
  if (!events.some((event) => event.type === "final")) {
    failCheck("final_response", "runtime did not emit a final event");
  }
  return events;
}

function failCheck(name: RuntimeContractCheckName, detail?: string): never {
  throw new Error(
    `Runtime contract check failed: ${name}${detail ? `: ${detail}` : ""}`
  );
}
