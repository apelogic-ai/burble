import type { Config } from "../config";
import type { AgentRuntimeRecord, TokenStore, WorkspacePolicyRecord } from "../db";
import { providerToolCatalog } from "../providers/catalog";
import { buildRuntimeManifest, type RuntimeManifest } from "./runtime-manifest";
import type { PrincipalId } from "./runtime-factory";

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

export function buildRuntimeManifestForPrincipal(input: {
  config: Config;
  store: TokenStore;
  principal: PrincipalId;
  engine: RuntimeManifest["runtime"]["engine"];
}): RuntimeManifest {
  return buildRuntimeManifest({
    principal: input.principal,
    runtime: {
      engine: input.engine,
      factory: input.config.agentRuntimeFactory,
      ttlMs: input.config.agentRuntimeIdleTtlMs,
      reaperEnabled: input.config.agentRuntimeReaperEnabled
    },
    defaultModel: input.config.aiModel,
    workspacePolicy: [
      ...defaultWorkspacePolicyRecords(input.principal.workspaceId),
      ...input.store.listWorkspacePolicy(input.principal.workspaceId)
    ],
    userPreferences: input.store.listUserPreferences(
      input.principal.workspaceId,
      input.principal.slackUserId
    ),
    toolCatalog: providerToolCatalog
  });
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
