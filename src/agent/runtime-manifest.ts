import { createHash } from "node:crypto";
import type {
  AgentMemoryRecord,
  AgentRuntimeEngine,
  UserPreferenceRecord,
  WorkspacePolicyRecord
} from "../db";
import type { AgentRuntimeFactory } from "../config";
import type { ProviderToolSpec } from "../providers/tool-specs";
import type { PrincipalId } from "./runtime-factory";

export type RuntimeToolRisk =
  | "read"
  | "low_write"
  | "moderate_write"
  | "high_write";

export type RuntimeToolConfirmation = "none" | "explicit" | "strong";

export type RuntimeManifestTool = {
  name: string;
  provider: string;
  enabled: boolean;
  risk: RuntimeToolRisk;
  routeRequired: boolean;
  confirmation: RuntimeToolConfirmation;
};

export type RuntimeManifestSkill = {
  id: string;
  version: string;
  enabled: boolean;
};

export type RuntimeMemoryContextEntry = {
  scope: "user" | "workspace" | "job";
  ownerId: string;
  key: string;
  valuePreview: string;
  updatedAt: string;
};

export type RuntimeManifest = {
  version: string;
  principal: PrincipalId;
  runtime: {
    engine: AgentRuntimeEngine;
    factory: AgentRuntimeFactory;
    ttlMs: number;
    reaperEnabled: boolean;
  };
  model: {
    provider: string;
    model: string;
  };
  tools: RuntimeManifestTool[];
  skills: RuntimeManifestSkill[];
  memory: {
    userMemoryEnabled: boolean;
    workspaceMemoryEnabled: boolean;
    jobMemoryEnabled: boolean;
  };
  streaming: {
    messageDeltasEnabled: boolean;
  };
  memoryContext: RuntimeMemoryContextEntry[];
  disabledTools: string[];
  policyHash: string;
};

type ModelChoice = {
  provider: string;
  model: string;
};

type ToolPolicyRecord = {
  provider?: string;
  tool?: string;
  effect?: "allow" | "deny";
  risk?: RuntimeToolRisk;
  routeRequired?: boolean;
  confirmation?: RuntimeToolConfirmation;
};

type SkillVersionRecord = {
  id: string;
  version?: string;
  versions?: string[];
};

const defaultRuntimeSkills: SkillVersionRecord[] = [
  { id: "core", version: "1" },
  { id: "github", version: "1" },
  { id: "atlassian-jira", version: "1" }
];

export function buildRuntimeManifest(input: {
  version?: string;
  principal: PrincipalId;
  runtime: RuntimeManifest["runtime"];
  defaultModel: string;
  defaultStreaming: boolean;
  workspacePolicy: WorkspacePolicyRecord[];
  userPreferences: UserPreferenceRecord[];
  memoryRecords?: AgentMemoryRecord[];
  toolCatalog: ProviderToolSpec[];
}): RuntimeManifest {
  const workspacePolicy = keyedValues(input.workspacePolicy);
  const userPreferences = keyedValues(input.userPreferences);
  const allowedProviders = stringSet(workspacePolicy.get("providers.allowed"));
  const allowedModels = modelChoices(workspacePolicy.get("models.allowed"));
  const preferredModel = modelChoice(
    userPreferences.get("runtime.model"),
    parseModelId(input.defaultModel)
  );
  const selectedModel = selectModel(preferredModel, allowedModels);
  const toolPolicies = toolPolicyRecords(workspacePolicy.get("tools.policy"));
  const disabledTools =
    stringSet(userPreferences.get("tools.disabled")) ?? new Set<string>();
  const allowedSkills = workspacePolicy.has("skills.allowed")
    ? skillVersionRecords(workspacePolicy.get("skills.allowed"))
    : defaultRuntimeSkills;
  const enabledSkills = userPreferences.has("skills.enabled")
    ? skillVersionRecords(userPreferences.get("skills.enabled"))
    : defaultRuntimeSkills;

  const memory = {
    userMemoryEnabled: memoryEnabled(userPreferences.get("memory.user")),
    workspaceMemoryEnabled: memoryEnabled(workspacePolicy.get("memory.workspace")),
    jobMemoryEnabled: memoryEnabled(workspacePolicy.get("memory.jobs"), true)
  };
  const streaming = {
    messageDeltasEnabled: memoryEnabled(
      userPreferences.get("runtime.streaming"),
      input.defaultStreaming
    )
  };
  const manifest: Omit<RuntimeManifest, "policyHash" | "memoryContext"> = {
    version: input.version ?? "1",
    principal: input.principal,
    runtime: input.runtime,
    model: selectedModel,
    tools: input.toolCatalog
      .map((tool) =>
        manifestTool({
          tool,
          allowedProviders,
          toolPolicies,
          disabledTools
        })
      )
      .sort((left, right) => left.name.localeCompare(right.name)),
    skills: effectiveSkills(allowedSkills, enabledSkills),
    memory,
    streaming,
    disabledTools: [...disabledTools].sort()
  };

  return {
    ...manifest,
    memoryContext: runtimeMemoryContext(input.memoryRecords ?? [], memory),
    policyHash: hashStableJson(manifest)
  };
}

function manifestTool(input: {
  tool: ProviderToolSpec;
  allowedProviders: Set<string> | null;
  toolPolicies: ToolPolicyRecord[];
  disabledTools: Set<string>;
}): RuntimeManifestTool {
  const matchingPolicies = input.toolPolicies.filter(
    (policy) =>
      (!policy.provider || policy.provider === input.tool.provider) &&
      (!policy.tool || policy.tool === input.tool.name)
  );
  const lastPolicy = matchingPolicies.at(-1);
  const denied = matchingPolicies.some((policy) => policy.effect === "deny");
  const providerAllowed =
    !input.allowedProviders || input.allowedProviders.has(input.tool.provider);

  return {
    name: input.tool.name,
    provider: input.tool.provider,
    enabled:
      providerAllowed && !denied && !input.disabledTools.has(input.tool.name),
    risk: lastPolicy?.risk ?? input.tool.risk ?? "read",
    routeRequired: lastPolicy?.routeRequired ?? true,
    confirmation: lastPolicy?.confirmation ?? input.tool.confirmation ?? "none"
  };
}

function effectiveSkills(
  allowed: SkillVersionRecord[],
  enabled: SkillVersionRecord[]
): RuntimeManifestSkill[] {
  const allowedVersions = new Map<string, Set<string> | null>();
  for (const skill of allowed) {
    allowedVersions.set(
      skill.id,
      skill.versions ? new Set(skill.versions) : skill.version ? new Set([skill.version]) : null
    );
  }

  return enabled
    .filter((skill) => {
      const allowedForSkill = allowedVersions.get(skill.id);
      if (allowedForSkill === undefined) {
        return false;
      }
      return !allowedForSkill || allowedForSkill.has(skill.version ?? "1");
    })
    .map((skill) => ({
      id: skill.id,
      version: skill.version ?? "1",
      enabled: true
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function selectModel(
  preferred: ModelChoice,
  allowed: ModelChoice[] | null
): ModelChoice {
  if (!allowed || allowed.length === 0) {
    return preferred;
  }

  return (
    allowed.find(
      (model) =>
        model.provider === preferred.provider && model.model === preferred.model
    ) ?? allowed[0]
  );
}

function keyedValues(
  records: Array<{ key: string; value: unknown }>
): Map<string, unknown> {
  return new Map(records.map((record) => [record.key, record.value]));
}

function stringSet(value: unknown): Set<string> | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const strings = value.filter((entry): entry is string => typeof entry === "string");
  return new Set(strings);
}

function toolPolicyRecords(value: unknown): ToolPolicyRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }
    return [
      {
        provider: optionalString(entry.provider),
        tool: optionalString(entry.tool),
        effect:
          entry.effect === "allow" || entry.effect === "deny"
            ? entry.effect
            : undefined,
        risk: runtimeToolRisk(entry.risk),
        routeRequired:
          typeof entry.routeRequired === "boolean"
            ? entry.routeRequired
            : undefined,
        confirmation: runtimeToolConfirmation(entry.confirmation)
      }
    ];
  });
}

function modelChoices(value: unknown): ModelChoice[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  return value.flatMap((entry) => {
    const choice = optionalModelChoice(entry);
    return choice ? [choice] : [];
  });
}

function modelChoice(value: unknown, fallback: ModelChoice | null): ModelChoice {
  return (
    optionalModelChoice(value) ??
    fallback ?? { provider: "openai", model: "gpt-5.4" }
  );
}

function optionalModelChoice(value: unknown): ModelChoice | null {
  if (typeof value === "string") {
    return parseModelId(value);
  }
  if (isRecord(value)) {
    const provider = optionalString(value.provider);
    const model = optionalString(value.model);
    if (provider && model) {
      return { provider, model };
    }
  }
  return null;
}

function parseModelId(modelId: string): ModelChoice {
  const [provider, ...modelParts] = modelId.split(":");
  if (!provider || modelParts.length === 0) {
    return { provider: "openai", model: modelId };
  }
  return { provider, model: modelParts.join(":") };
}

function skillVersionRecords(value: unknown): SkillVersionRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }
    const id = optionalString(entry.id);
    if (!id) {
      return [];
    }
    return [
      {
        id,
        version: optionalString(entry.version),
        versions: Array.isArray(entry.versions)
          ? entry.versions.filter(
              (version): version is string => typeof version === "string"
            )
          : undefined
      }
    ];
  });
}

function memoryEnabled(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (isRecord(value) && typeof value.enabled === "boolean") {
    return value.enabled;
  }
  return fallback;
}

function runtimeMemoryContext(
  records: AgentMemoryRecord[],
  memory: RuntimeManifest["memory"]
): RuntimeMemoryContextEntry[] {
  return records
    .filter((record) => {
      switch (record.scope) {
        case "user":
          return memory.userMemoryEnabled;
        case "workspace":
          return memory.workspaceMemoryEnabled;
        case "job":
          return memory.jobMemoryEnabled;
      }
    })
    .sort((left, right) =>
      `${left.scope}:${left.ownerId}:${left.key}`.localeCompare(
        `${right.scope}:${right.ownerId}:${right.key}`
      )
    )
    .slice(0, 20)
    .map((record) => ({
      scope: record.scope,
      ownerId: record.ownerId,
      key: record.key,
      valuePreview: memoryValuePreview(record.key, record.value),
      updatedAt: record.updatedAt
    }));
}

function memoryValuePreview(key: string, value: unknown): string {
  if (/token|secret|password|credential|apikey|api_key/i.test(key)) {
    return "[redacted]";
  }
  return truncate(JSON.stringify(sortJson(value)), 500);
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength - 3)}...`;
}

function runtimeToolRisk(value: unknown): RuntimeToolRisk | undefined {
  return value === "read" ||
    value === "low_write" ||
    value === "moderate_write" ||
    value === "high_write"
    ? value
    : undefined;
}

function runtimeToolConfirmation(
  value: unknown
): RuntimeToolConfirmation | undefined {
  return value === "none" || value === "explicit" || value === "strong"
    ? value
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hashStableJson(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(sortJson(value)))
    .digest("hex");
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)])
  );
}
