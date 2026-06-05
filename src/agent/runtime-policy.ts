import type { Config } from "../config";
import { agentRuntimeEngines } from "../config";
import type { AgentRuntimeRecord, TokenStore, WorkspacePolicyRecord } from "../db";
import { providerToolCatalog } from "../providers/catalog";
import { buildRuntimeManifest, type RuntimeManifest } from "./runtime-manifest";
import type { PrincipalId } from "./runtime-factory";
import type { RuntimeCapabilityManifest } from "./runtime-contract";

export const defaultWorkspaceRuntimePolicy = {
  memory: {
    user: { enabled: false },
    workspace: { enabled: false },
    jobs: { enabled: true }
  },
  skills: {
    allowed: [
      { id: "core", version: "1" },
      { id: "github", version: "1" },
      { id: "atlassian-jira", version: "1" }
    ]
  }
} as const;

const agentRuntimeEngineSet = new Set<string>(agentRuntimeEngines);

export type RuntimeEngineSelection = {
  configuredEngine: RuntimeManifest["runtime"]["engine"];
  effectiveEngine: RuntimeManifest["runtime"]["engine"];
  preferredEngine: RuntimeManifest["runtime"]["engine"] | null;
  allowedEngines: RuntimeManifest["runtime"]["engine"][];
  selectableEngines: RuntimeManifest["runtime"]["engine"][];
  compatibility: RuntimeEngineCompatibility[];
};

export type RuntimeEngineCompatibility = {
  engine: RuntimeManifest["runtime"]["engine"];
  selectable: boolean;
  reasons: string[];
};

export class RuntimeEngineSelectionError extends Error {
  constructor(
    message: string,
    readonly selection: Omit<RuntimeEngineSelection, "effectiveEngine">
  ) {
    super(message);
    this.name = "RuntimeEngineSelectionError";
  }
}

export function resolveRuntimeEngineForPrincipal(input: {
  config: Config;
  store: TokenStore;
  principal: PrincipalId;
}): RuntimeEngineSelection {
  const configuredEngine = input.config.agentRuntimeEngine;
  const allowedEngines = readAllowedRuntimeEngines({
    config: input.config,
    store: input.store,
    workspaceId: input.principal.workspaceId
  });
  const compatibility = allowedEngines.map((engine) =>
    runtimeEngineCompatibility(engine)
  );
  const selectableEngines = compatibility
    .filter((entry) => entry.selectable)
    .map((entry) => entry.engine);
  const preferredEngine = readUserRuntimeEnginePreference({
    store: input.store,
    principal: input.principal
  });
  const fallbackEngine = selectableEngines[0];
  if (!fallbackEngine) {
    throw new RuntimeEngineSelectionError(
      [
        "No selectable runtime engines are available for this workspace.",
        ...compatibility.map((entry) => {
          const reasons =
            entry.reasons.length > 0 ? entry.reasons.join(", ") : "unknown";
          return `${entry.engine}: ${reasons}`;
        })
      ].join(" "),
      {
        configuredEngine,
        preferredEngine,
        allowedEngines,
        selectableEngines,
        compatibility
      }
    );
  }
  const effectiveEngine =
    preferredEngine && selectableEngines.includes(preferredEngine)
      ? preferredEngine
      : selectableEngines.includes(configuredEngine)
        ? configuredEngine
        : fallbackEngine;

  return {
    configuredEngine,
    effectiveEngine,
    preferredEngine,
    allowedEngines,
    selectableEngines,
    compatibility
  };
}

export function runtimeEngineCompatibility(
  engine: RuntimeManifest["runtime"]["engine"]
): RuntimeEngineCompatibility {
  return runtimeCapabilityManifestCompatibility(
    engine,
    knownRuntimeCapabilityManifest(engine)
  );
}

export function runtimeCapabilityManifestCompatibility(
  engine: RuntimeManifest["runtime"]["engine"],
  manifest: RuntimeCapabilityManifest
): RuntimeEngineCompatibility {
  const reasons: string[] = [];
  if (!manifest.transports.includes("http")) {
    reasons.push("missing HTTP transport");
  }
  if (!manifest.transports.includes("websocket")) {
    reasons.push("missing WebSocket run events");
  }
  if (!manifest.toolCalls) {
    reasons.push("missing tool calls");
  }
  if (!manifest.toolBridgeModes.includes("tool_gateway")) {
    reasons.push("missing Burble tool gateway bridge");
  }
  if (!manifest.scheduledProviderCalls) {
    reasons.push("missing scheduled provider calls");
  }
  if (!manifest.conversationSend) {
    reasons.push("missing conversation delivery");
  }
  if (!manifest.jobScopedAuth) {
    reasons.push("missing job-scoped auth");
  }
  if (manifest.usageReporting === "none") {
    reasons.push("missing usage reporting");
  }

  return {
    engine,
    selectable: reasons.length === 0,
    reasons
  };
}

export function knownRuntimeCapabilityManifest(
  engine: RuntimeManifest["runtime"]["engine"]
): RuntimeCapabilityManifest {
  const openClawFamily =
    engine === "deterministic" ||
    engine === "openclaw" ||
    engine === "openclaw-gateway" ||
    engine === "burble-direct";
  if (openClawFamily) {
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

  return {
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
}

export function buildRuntimeManifestForPrincipal(input: {
  config: Config;
  store: TokenStore;
  principal: PrincipalId;
  engine: RuntimeManifest["runtime"]["engine"];
}): RuntimeManifest {
  const workspaceSkills = input.store.listWorkspaceSkills(
    input.principal.workspaceId
  );
  const userSkills = input.store.listUserSkills(
    input.principal.workspaceId,
    input.principal.slackUserId
  );
  return buildRuntimeManifest({
    principal: input.principal,
    runtime: {
      engine: input.engine,
      factory: input.config.agentRuntimeFactory,
      ttlMs: input.config.agentRuntimeIdleTtlMs,
      reaperEnabled: input.config.agentRuntimeReaperEnabled
    },
    defaultModel: input.config.aiModel,
    defaultStreaming: input.config.agentRuntimeStreaming !== "off",
    workspacePolicy: [
      ...defaultWorkspacePolicyRecords(input.principal.workspaceId),
      ...input.store.listWorkspacePolicy(input.principal.workspaceId),
      ...workspaceSkillPolicyRecords(input.principal.workspaceId, workspaceSkills)
    ],
    userPreferences: input.store.listUserPreferences(
      input.principal.workspaceId,
      input.principal.slackUserId
    ).concat(
      userSkillPreferenceRecords(
        input.principal.workspaceId,
        input.principal.slackUserId,
        userSkills
      )
    ),
    memoryRecords: [
      ...input.store.listAgentMemory({
        workspaceId: input.principal.workspaceId,
        scope: "workspace"
      }),
      ...input.store.listAgentMemory({
        workspaceId: input.principal.workspaceId,
        scope: "user",
        ownerId: input.principal.slackUserId
      })
    ],
    toolCatalog: providerToolCatalog
  });
}

function workspaceSkillPolicyRecords(
  workspaceId: string,
  skills: ReturnType<TokenStore["listWorkspaceSkills"]>
): WorkspacePolicyRecord[] {
  if (skills.length === 0) {
    return [];
  }
  return [
    {
      workspaceId,
      key: "skills.allowed",
      value: skills
        .filter((skill) => skill.enabled)
        .map((skill) => ({ id: skill.skillId, version: skill.version })),
      updatedBySlackUserId: null,
      updatedAt: maxUpdatedAt(skills.map((skill) => skill.updatedAt))
    }
  ];
}

function userSkillPreferenceRecords(
  workspaceId: string,
  slackUserId: string,
  skills: ReturnType<TokenStore["listUserSkills"]>
) {
  if (skills.length === 0) {
    return [];
  }
  return [
    {
      workspaceId,
      slackUserId,
      key: "skills.enabled",
      value: skills
        .filter((skill) => skill.enabled)
        .map((skill) => ({ id: skill.skillId, version: skill.version })),
      updatedAt: maxUpdatedAt(skills.map((skill) => skill.updatedAt))
    }
  ];
}

function maxUpdatedAt(values: string[]): string {
  return values.sort().at(-1) ?? "1970-01-01T00:00:00.000Z";
}

function defaultWorkspacePolicyRecords(
  workspaceId: string
): WorkspacePolicyRecord[] {
  const updatedAt = "1970-01-01T00:00:00.000Z";
  return [
    {
      workspaceId,
      key: "memory.user",
      value: defaultWorkspaceRuntimePolicy.memory.user,
      updatedBySlackUserId: null,
      updatedAt
    },
    {
      workspaceId,
      key: "memory.workspace",
      value: defaultWorkspaceRuntimePolicy.memory.workspace,
      updatedBySlackUserId: null,
      updatedAt
    },
    {
      workspaceId,
      key: "memory.jobs",
      value: defaultWorkspaceRuntimePolicy.memory.jobs,
      updatedBySlackUserId: null,
      updatedAt
    },
    {
      workspaceId,
      key: "skills.allowed",
      value: defaultWorkspaceRuntimePolicy.skills.allowed,
      updatedBySlackUserId: null,
      updatedAt
    }
  ];
}

function readAllowedRuntimeEngines(input: {
  config: Config;
  store: TokenStore;
  workspaceId: string;
}): RuntimeManifest["runtime"]["engine"][] {
  const explicit = input.store
    .listWorkspacePolicy(input.workspaceId)
    .find((record) => record.key === "runtime.allowedEngines")?.value;
  const engines = normalizeRuntimeEngineList(explicit);
  return engines.length > 0 ? engines : [input.config.agentRuntimeEngine];
}

function readUserRuntimeEnginePreference(input: {
  store: TokenStore;
  principal: PrincipalId;
}): RuntimeManifest["runtime"]["engine"] | null {
  const value = input.store.getUserPreference(
    input.principal.workspaceId,
    input.principal.slackUserId,
    "runtime.engine"
  )?.value;
  return normalizeRuntimeEngine(value);
}

function normalizeRuntimeEngineList(
  value: unknown
): RuntimeManifest["runtime"]["engine"][] {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,\s]+/)
      : [];
  return [...new Set(rawValues.map(normalizeRuntimeEngine).filter(Boolean))] as RuntimeManifest["runtime"]["engine"][];
}

function normalizeRuntimeEngine(
  value: unknown
): RuntimeManifest["runtime"]["engine"] | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return agentRuntimeEngineSet.has(normalized)
    ? (normalized as RuntimeManifest["runtime"]["engine"])
    : null;
}

export function buildRuntimeManifestForRecord(input: {
  config: Config;
  store: TokenStore;
  runtime: AgentRuntimeRecord;
}): RuntimeManifest {
  return buildRuntimeManifestForPrincipal({
    config: input.config,
    store: input.store,
    principal: {
      workspaceId: input.runtime.workspaceId,
      slackUserId: input.runtime.slackUserId
    },
    engine: input.runtime.engine
  });
}

export function enabledManifestToolNames(
  manifest: RuntimeManifest
): ReadonlySet<string> {
  return new Set(
    manifest.tools.filter((tool) => tool.enabled).map((tool) => tool.name)
  );
}
