import {
  isAgentRuntimeEngine,
  runtimeEngines,
  type AgentRuntimeEngine
} from "../runtime-engines";
import type { RuntimeCapabilityManifest } from "./runtime-contract";

export { runtimeEngines };

export type RuntimeContainerProfile = {
  dataRootTarget: string;
  configFileName: string;
  stateDir: string;
  workspaceDir: string;
  openClawCompatEnv: boolean;
  openClawConfigPatch: boolean;
  modelEnv: "generic" | "hermes";
  hermesHome?: string;
};

export type RuntimeDescriptor = {
  engine: AgentRuntimeEngine;
  family: string;
  defaultImages: readonly string[];
  healthCheckAttempts: number;
  capabilities: RuntimeCapabilityManifest;
  container: RuntimeContainerProfile;
};

const openClawDefaultImages = [
  "burble-openclaw-nemoclaw-openclaw-cli:dev",
  "burble-openclaw-nemoclaw:dev"
] as const;

const directRuntimeDefaultImages = [
  "burble-openclaw-nemoclaw:dev",
  "burble-openclaw-nemoclaw-openclaw-cli:dev"
] as const;

const openClawContainerProfile: RuntimeContainerProfile = {
  dataRootTarget: "/data/openclaw",
  configFileName: "openclaw.json",
  stateDir: "/data/openclaw/state",
  workspaceDir: "/data/openclaw/workspace",
  openClawCompatEnv: true,
  openClawConfigPatch: true,
  modelEnv: "generic"
};

const hermesContainerProfile: RuntimeContainerProfile = {
  dataRootTarget: "/data/openclaw",
  configFileName: "hermes.json",
  stateDir: "/data/openclaw/state",
  workspaceDir: "/data/openclaw/workspace",
  openClawCompatEnv: false,
  openClawConfigPatch: false,
  modelEnv: "hermes",
  hermesHome: "/data/openclaw/hermes"
};

function openClawCapabilityManifest(
  engine: AgentRuntimeEngine
): RuntimeCapabilityManifest {
  return {
    runtimeType: engine,
    version: "known",
    transports: ["http", "sse", "ndjson", "websocket"],
    streaming: true,
    cancellation: false,
    nativeScheduler: true,
    scheduledProviderCalls: true,
    toolCalls: true,
    toolBridgeModes: ["tool_gateway", "mcp"],
    usageReporting: engine === "deterministic" ? "none" : "exact",
    multimodalInput: true,
    multimodalOutput: false,
    memory: true,
    durableWorkflowState: true,
    attachments: true,
    conversationSend: true,
    jobScopedAuth: true
  };
}

const hermesCapabilityManifest: RuntimeCapabilityManifest = {
  runtimeType: "hermes",
  version: "known",
  transports: ["http", "websocket"],
  streaming: true,
  cancellation: false,
  nativeScheduler: true,
  scheduledProviderCalls: true,
  toolCalls: true,
  toolBridgeModes: ["tool_gateway", "mcp"],
  usageReporting: "exact",
  multimodalInput: false,
  multimodalOutput: false,
  memory: false,
  durableWorkflowState: true,
  attachments: false,
  conversationSend: true,
  jobScopedAuth: true
};

const runtimeDescriptors = {
  deterministic: {
    engine: "deterministic",
    family: "deterministic",
    defaultImages: directRuntimeDefaultImages,
    healthCheckAttempts: 30,
    capabilities: openClawCapabilityManifest("deterministic"),
    container: openClawContainerProfile
  },
  openclaw: {
    engine: "openclaw",
    family: "openclaw",
    defaultImages: openClawDefaultImages,
    healthCheckAttempts: 90,
    capabilities: openClawCapabilityManifest("openclaw"),
    container: openClawContainerProfile
  },
  "openclaw-gateway": {
    engine: "openclaw-gateway",
    family: "openclaw",
    defaultImages: openClawDefaultImages,
    healthCheckAttempts: 90,
    capabilities: openClawCapabilityManifest("openclaw-gateway"),
    container: openClawContainerProfile
  },
  "burble-direct": {
    engine: "burble-direct",
    family: "burble-direct",
    defaultImages: directRuntimeDefaultImages,
    healthCheckAttempts: 30,
    capabilities: openClawCapabilityManifest("burble-direct"),
    container: openClawContainerProfile
  },
  hermes: {
    engine: "hermes",
    family: "hermes",
    defaultImages: ["burble-nemo-hermes:dev"],
    healthCheckAttempts: 30,
    capabilities: hermesCapabilityManifest,
    container: hermesContainerProfile
  }
} as const satisfies Record<AgentRuntimeEngine, RuntimeDescriptor>;

export function runtimeDescriptor(engine: AgentRuntimeEngine): RuntimeDescriptor {
  return runtimeDescriptors[engine];
}

export function defaultRuntimeImageForEngine(
  engine: AgentRuntimeEngine
): string {
  return runtimeDescriptor(engine).defaultImages[0];
}

export function isKnownDefaultRuntimeImage(
  engine: AgentRuntimeEngine,
  image: string
): boolean {
  return runtimeDescriptor(engine).defaultImages.includes(image);
}

export function runtimeConfigFileName(engine: AgentRuntimeEngine): string {
  return runtimeDescriptor(engine).container.configFileName;
}

export function runtimeHealthCheckAttempts(engine: AgentRuntimeEngine): number {
  return runtimeDescriptor(engine).healthCheckAttempts;
}

export function runtimeCompatibilityFamily(engine: string): string {
  return isKnownRuntimeEngine(engine)
    ? runtimeDescriptor(engine).family
    : engine;
}

export function isKnownRuntimeEngine(
  value: string
): value is AgentRuntimeEngine {
  return isAgentRuntimeEngine(value);
}
