import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  isAgentRuntimeEngine,
  type AgentRuntimeEngine
} from "@burble/runtime-sdk/runtime-engines";
import type { ConnectedProviderId } from "./providers/descriptors";
export type { AgentRuntimeEngine } from "@burble/runtime-sdk/runtime-engines";

export type OAuthState = {
  state: string;
  slackUserId: string;
  expiresAt: string;
};

export type ConnectedUser = {
  email: string;
  slackUserId: string;
  githubLogin: string;
  githubToken: string;
  connectedAt: string;
};

export type Provider = ConnectedProviderId;

export type ProviderConnection = {
  provider: Provider;
  email: string;
  slackUserId: string;
  providerLogin: string;
  accessToken: string;
  refreshToken?: string | null;
  accessTokenExpiresAt?: string | null;
  connectedAt: string;
};

export type AgentRuntimeStatus =
  | "provisioning"
  | "ready"
  | "busy"
  | "idle"
  | "stopping"
  | "stopped"
  | "failed";

export type AgentRuntimeRecord = {
  id: string;
  workspaceId: string;
  slackUserId: string;
  engine: AgentRuntimeEngine;
  status: AgentRuntimeStatus;
  endpointUrl: string;
  authTokenHash: string;
  statePath: string;
  configPath: string;
  workspacePath: string;
  sandboxId: string | null;
  policyHash: string | null;
  createdAt: string;
  lastSeenAt: string;
  lastUsedAt: string;
  stoppedAt: string | null;
  failureReason: string | null;
};

export type AgentRuntimeEventType =
  | "runtime_provision_requested"
  | "runtime_provision_finished"
  | "runtime_provision_failed"
  | "runtime_policy_changed"
  | "runtime_stopped"
  | "runtime_run_started"
  | "runtime_run_finished"
  | "runtime_tool_called"
  | "runtime_tool_failed";

export type AgentRuntimeEventRecord = {
  id: string;
  runtimeId: string;
  workspaceId: string;
  slackUserId: string;
  eventType: AgentRuntimeEventType;
  summaryJson: string;
  createdAt: string;
};

export type ConversationTransport = "slack";
export type ConversationRouteKind = "origin" | "grant";

export type ConversationRouteRecord = {
  id: string;
  workspaceId: string;
  slackUserId: string;
  transport: ConversationTransport;
  destinationJson: string;
  kind?: ConversationRouteKind;
  grantedBySlackUserId?: string | null;
  expiresAt?: string | null;
  bindingJson?: string | null;
  lastDeliveryFailureAt?: string | null;
  lastDeliveryFailureCode?: string | null;
  lastDeliveryFailureNotifiedAt?: string | null;
  consecutiveDeliveryFailures?: number | null;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
};

export type WorkspacePolicyRecord = {
  workspaceId: string;
  key: string;
  value: unknown;
  updatedBySlackUserId: string | null;
  updatedAt: string;
};

export type UserPreferenceRecord = {
  workspaceId: string;
  slackUserId: string;
  key: string;
  value: unknown;
  updatedAt: string;
};

export type AgentMemoryScope = "user" | "workspace" | "job";

export type AgentMemoryRecord = {
  workspaceId: string;
  scope: AgentMemoryScope;
  ownerId: string;
  key: string;
  value: unknown;
  updatedAt: string;
};

export type AgentJobStateRecord = {
  jobId: string;
  workspaceId: string;
  slackUserId: string;
  state: unknown;
  updatedAt: string;
};

export type AgentJobCapabilityRecord = {
  jobId: string;
  workspaceId: string;
  slackUserId: string;
  requiredTools: string[];
  routeId: string | null;
  policyHash: string | null;
  capabilityProfile: string;
  runtimeType: AgentRuntimeEngine | null;
  stateRefs: unknown[];
  visibilityPolicy: unknown;
  createdAt: string;
  updatedAt: string;
};

export type SkillCatalogRecord = {
  id: string;
  version: string;
  title: string;
  description: string;
  metadata: unknown;
  contentRef: string;
  createdAt: string;
};

export type WorkspaceSkillRecord = {
  workspaceId: string;
  skillId: string;
  version: string;
  enabled: boolean;
  updatedBySlackUserId: string | null;
  updatedAt: string;
};

export type UserSkillRecord = {
  workspaceId: string;
  slackUserId: string;
  skillId: string;
  version: string;
  enabled: boolean;
  updatedAt: string;
};

type WorkspacePolicyRow = Omit<WorkspacePolicyRecord, "value"> & {
  valueJson: string;
};

type UserPreferenceRow = Omit<UserPreferenceRecord, "value"> & {
  valueJson: string;
};

type AgentMemoryRow = Omit<AgentMemoryRecord, "value"> & {
  valueJson: string;
};

type AgentJobStateRow = Omit<AgentJobStateRecord, "state"> & {
  stateJson: string;
};

type AgentJobCapabilityRow = Omit<
  AgentJobCapabilityRecord,
  "requiredTools" | "stateRefs" | "visibilityPolicy"
> & {
  requiredToolsJson: string;
  stateRefsJson: string;
  visibilityPolicyJson: string;
};

type SkillCatalogRow = Omit<SkillCatalogRecord, "metadata"> & {
  metadataJson: string;
};

export type TokenStore = ReturnType<typeof createTokenStore>;

export function createTokenStore(path: string) {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      email TEXT PRIMARY KEY,
      slack_user_id TEXT NOT NULL,
      github_login TEXT NOT NULL,
      github_token TEXT NOT NULL,
      connected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS provider_connections (
      provider TEXT NOT NULL,
      email TEXT NOT NULL,
      slack_user_id TEXT NOT NULL,
      provider_login TEXT NOT NULL,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      access_token_expires_at TEXT,
      connected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(provider, email)
    );

    CREATE INDEX IF NOT EXISTS idx_provider_connections_slack_user
      ON provider_connections (provider, slack_user_id);

    CREATE TABLE IF NOT EXISTS oauth_state (
      state TEXT PRIMARY KEY,
      slack_user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_oauth_state_expires_at
      ON oauth_state (expires_at);

    CREATE TABLE IF NOT EXISTS agent_runtimes (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      slack_user_id TEXT NOT NULL,
      engine TEXT NOT NULL,
      status TEXT NOT NULL,
      endpoint_url TEXT NOT NULL,
      auth_token_hash TEXT NOT NULL,
      state_path TEXT NOT NULL,
      config_path TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      sandbox_id TEXT,
      policy_hash TEXT,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      stopped_at TEXT,
      failure_reason TEXT,
      UNIQUE(workspace_id, slack_user_id, engine)
    );

    CREATE INDEX IF NOT EXISTS idx_agent_runtimes_principal
      ON agent_runtimes (workspace_id, slack_user_id, engine);

    CREATE INDEX IF NOT EXISTS idx_agent_runtimes_status_last_used
      ON agent_runtimes (status, last_used_at);

    CREATE TABLE IF NOT EXISTS agent_runtime_events (
      id TEXT PRIMARY KEY,
      runtime_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      slack_user_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_runtime_events_runtime_created
      ON agent_runtime_events (runtime_id, created_at);

    CREATE TABLE IF NOT EXISTS conversation_routes (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      slack_user_id TEXT NOT NULL,
      transport TEXT NOT NULL,
      destination_json TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'origin',
      granted_by_slack_user_id TEXT,
      expires_at TEXT,
      binding_json TEXT,
      last_delivery_failure_at TEXT,
      last_delivery_failure_code TEXT,
      last_delivery_failure_notified_at TEXT,
      consecutive_delivery_failures INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      revoked_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_conversation_routes_principal
      ON conversation_routes (workspace_id, slack_user_id, transport, updated_at);

    CREATE TABLE IF NOT EXISTS workspace_policy (
      workspace_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_by_slack_user_id TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id, key)
    );

    CREATE INDEX IF NOT EXISTS idx_workspace_policy_workspace
      ON workspace_policy (workspace_id, key);

    CREATE TABLE IF NOT EXISTS user_preferences (
      workspace_id TEXT NOT NULL,
      slack_user_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id, slack_user_id, key)
    );

    CREATE INDEX IF NOT EXISTS idx_user_preferences_principal
      ON user_preferences (workspace_id, slack_user_id, key);

    CREATE TABLE IF NOT EXISTS agent_memory (
      workspace_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id, scope, owner_id, key)
    );

    CREATE INDEX IF NOT EXISTS idx_agent_memory_owner
      ON agent_memory (workspace_id, scope, owner_id, key);

    CREATE TABLE IF NOT EXISTS agent_job_state (
      job_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      slack_user_id TEXT NOT NULL,
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_job_state_principal
      ON agent_job_state (workspace_id, slack_user_id, updated_at);

    CREATE TABLE IF NOT EXISTS agent_job_capabilities (
      job_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      slack_user_id TEXT NOT NULL,
      required_tools_json TEXT NOT NULL,
      route_id TEXT,
      policy_hash TEXT,
      capability_profile TEXT NOT NULL DEFAULT 'scheduled_job',
      runtime_type TEXT,
      state_refs_json TEXT NOT NULL DEFAULT '[]',
      visibility_policy_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_job_capabilities_principal
      ON agent_job_capabilities (workspace_id, slack_user_id, updated_at);

    CREATE TABLE IF NOT EXISTS skill_catalog (
      id TEXT NOT NULL,
      version TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      content_ref TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(id, version)
    );

    CREATE TABLE IF NOT EXISTS workspace_skills (
      workspace_id TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      version TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      updated_by_slack_user_id TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id, skill_id, version)
    );

    CREATE INDEX IF NOT EXISTS idx_workspace_skills_workspace
      ON workspace_skills (workspace_id, enabled, skill_id);

    CREATE TABLE IF NOT EXISTS user_skills (
      workspace_id TEXT NOT NULL,
      slack_user_id TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      version TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id, slack_user_id, skill_id, version)
    );

    CREATE INDEX IF NOT EXISTS idx_user_skills_principal
      ON user_skills (workspace_id, slack_user_id, enabled, skill_id);
  `);
  ensureProviderConnectionColumn(db, "refresh_token", "TEXT");
  ensureProviderConnectionColumn(db, "access_token_expires_at", "TEXT");
  ensureAgentRuntimeColumn(db, "sandbox_id", "TEXT");
  ensureAgentRuntimeColumn(db, "policy_hash", "TEXT");
  ensureAgentJobCapabilityColumn(
    db,
    "capability_profile",
    "TEXT NOT NULL DEFAULT 'scheduled_job'"
  );
  ensureAgentJobCapabilityColumn(db, "runtime_type", "TEXT");
  ensureAgentJobCapabilityColumn(
    db,
    "state_refs_json",
    "TEXT NOT NULL DEFAULT '[]'"
  );
  ensureAgentJobCapabilityColumn(
    db,
    "visibility_policy_json",
    "TEXT NOT NULL DEFAULT '{}'"
  );
  ensureConversationRouteColumn(
    db,
    "kind",
    "TEXT NOT NULL DEFAULT 'origin'"
  );
  ensureConversationRouteColumn(db, "granted_by_slack_user_id", "TEXT");
  ensureConversationRouteColumn(db, "expires_at", "TEXT");
  ensureConversationRouteColumn(db, "binding_json", "TEXT");
  ensureConversationRouteColumn(db, "last_delivery_failure_at", "TEXT");
  ensureConversationRouteColumn(db, "last_delivery_failure_code", "TEXT");
  ensureConversationRouteColumn(db, "last_delivery_failure_notified_at", "TEXT");
  ensureConversationRouteColumn(
    db,
    "consecutive_delivery_failures",
    "INTEGER NOT NULL DEFAULT 0"
  );

  const insertState = db.query(
    "INSERT INTO oauth_state (state, slack_user_id, expires_at) VALUES (?, ?, ?)"
  );
  const getState = db.query<OAuthState, [string]>(`
    SELECT
      state,
      slack_user_id AS slackUserId,
      expires_at AS expiresAt
    FROM oauth_state
    WHERE state = ?
  `);
  const deleteState = db.query("DELETE FROM oauth_state WHERE state = ?");
  const deleteExpiredStates = db.query(
    "DELETE FROM oauth_state WHERE expires_at <= ?"
  );
  const upsertUser = db.query(`
    INSERT INTO users (email, slack_user_id, github_login, github_token, connected_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(email) DO UPDATE SET
      slack_user_id = excluded.slack_user_id,
      github_login = excluded.github_login,
      github_token = excluded.github_token,
      connected_at = CURRENT_TIMESTAMP
  `);
  const upsertProviderConnection = db.query(`
    INSERT INTO provider_connections (
      provider,
      email,
      slack_user_id,
      provider_login,
      access_token,
      refresh_token,
      access_token_expires_at,
      connected_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(provider, email) DO UPDATE SET
      slack_user_id = excluded.slack_user_id,
      provider_login = excluded.provider_login,
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      access_token_expires_at = excluded.access_token_expires_at,
      connected_at = CURRENT_TIMESTAMP
  `);
  const getUserByEmail = db.query<ConnectedUser, [string]>(`
    SELECT
      email,
      slack_user_id AS slackUserId,
      github_login AS githubLogin,
      github_token AS githubToken,
      connected_at AS connectedAt
    FROM users
    WHERE email = ?
  `);
  const getProviderConnection = db.query<ProviderConnection, [Provider, string]>(`
    SELECT
      provider,
      email,
      slack_user_id AS slackUserId,
      provider_login AS providerLogin,
      access_token AS accessToken,
      refresh_token AS refreshToken,
      access_token_expires_at AS accessTokenExpiresAt,
      connected_at AS connectedAt
    FROM provider_connections
    WHERE provider = ? AND email = ?
  `);
  const getProviderConnectionBySlackUser = db.query<
    ProviderConnection,
    [Provider, string]
  >(`
    SELECT
      provider,
      email,
      slack_user_id AS slackUserId,
      provider_login AS providerLogin,
      access_token AS accessToken,
      refresh_token AS refreshToken,
      access_token_expires_at AS accessTokenExpiresAt,
      connected_at AS connectedAt
    FROM provider_connections
    WHERE provider = ? AND slack_user_id = ?
    ORDER BY connected_at DESC
    LIMIT 1
  `);
  const deleteProviderConnectionBySlackUser = db.query(`
    DELETE FROM provider_connections
    WHERE provider = ? AND slack_user_id = ?
  `);
  const deleteLegacyGitHubUserBySlackUser = db.query(`
    DELETE FROM users
    WHERE slack_user_id = ?
  `);
  const getUserBySlackUser = db.query<ConnectedUser, [string]>(`
    SELECT
      email,
      slack_user_id AS slackUserId,
      github_login AS githubLogin,
      github_token AS githubToken,
      connected_at AS connectedAt
    FROM users
    WHERE slack_user_id = ?
    ORDER BY connected_at DESC
    LIMIT 1
  `);
  const getAgentRuntimeById = db.query<AgentRuntimeRecord, [string]>(`
    SELECT
      id,
      workspace_id AS workspaceId,
      slack_user_id AS slackUserId,
      engine,
      status,
      endpoint_url AS endpointUrl,
      auth_token_hash AS authTokenHash,
      state_path AS statePath,
      config_path AS configPath,
      workspace_path AS workspacePath,
      sandbox_id AS sandboxId,
      policy_hash AS policyHash,
      created_at AS createdAt,
      last_seen_at AS lastSeenAt,
      last_used_at AS lastUsedAt,
      stopped_at AS stoppedAt,
      failure_reason AS failureReason
    FROM agent_runtimes
    WHERE id = ?
  `);
  const getAgentRuntimeByPrincipal = db.query<
    AgentRuntimeRecord,
    [string, string, AgentRuntimeEngine]
  >(`
    SELECT
      id,
      workspace_id AS workspaceId,
      slack_user_id AS slackUserId,
      engine,
      status,
      endpoint_url AS endpointUrl,
      auth_token_hash AS authTokenHash,
      state_path AS statePath,
      config_path AS configPath,
      workspace_path AS workspacePath,
      sandbox_id AS sandboxId,
      policy_hash AS policyHash,
      created_at AS createdAt,
      last_seen_at AS lastSeenAt,
      last_used_at AS lastUsedAt,
      stopped_at AS stoppedAt,
      failure_reason AS failureReason
    FROM agent_runtimes
    WHERE workspace_id = ? AND slack_user_id = ? AND engine = ?
  `);
  const listIdleAgentRuntimes = db.query<AgentRuntimeRecord, [string]>(`
    SELECT
      id,
      workspace_id AS workspaceId,
      slack_user_id AS slackUserId,
      engine,
      status,
      endpoint_url AS endpointUrl,
      auth_token_hash AS authTokenHash,
      state_path AS statePath,
      config_path AS configPath,
      workspace_path AS workspacePath,
      sandbox_id AS sandboxId,
      policy_hash AS policyHash,
      created_at AS createdAt,
      last_seen_at AS lastSeenAt,
      last_used_at AS lastUsedAt,
      stopped_at AS stoppedAt,
      failure_reason AS failureReason
    FROM agent_runtimes
    WHERE status IN ('ready', 'idle') AND last_used_at <= ?
    ORDER BY last_used_at ASC
  `);
  const insertAgentRuntime = db.query(`
    INSERT INTO agent_runtimes (
      id,
      workspace_id,
      slack_user_id,
      engine,
      status,
      endpoint_url,
      auth_token_hash,
      state_path,
      config_path,
      workspace_path,
      sandbox_id,
      policy_hash,
      created_at,
      last_seen_at,
      last_used_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateAgentRuntimePolicyHash = db.query(`
    UPDATE agent_runtimes
    SET policy_hash = ?, last_seen_at = ?
    WHERE id = ?
  `);
  const updateAgentRuntimeBinding = db.query(`
    UPDATE agent_runtimes
    SET
      endpoint_url = ?,
      auth_token_hash = ?,
      state_path = ?,
      config_path = ?,
      workspace_path = ?,
      sandbox_id = ?,
      last_seen_at = ?
    WHERE id = ?
  `);
  const updateAgentRuntimeStatus = db.query(`
    UPDATE agent_runtimes
    SET
      status = ?,
      last_seen_at = ?,
      stopped_at = ?,
      failure_reason = ?
    WHERE id = ?
  `);
  const touchAgentRuntime = db.query(`
    UPDATE agent_runtimes
    SET last_used_at = ?, last_seen_at = ?
    WHERE id = ?
  `);
  const insertAgentRuntimeEvent = db.query(`
    INSERT INTO agent_runtime_events (
      id,
      runtime_id,
      workspace_id,
      slack_user_id,
      event_type,
      summary_json,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const listAgentRuntimeEvents = db.query<AgentRuntimeEventRecord, [string]>(`
    SELECT
      id,
      runtime_id AS runtimeId,
      workspace_id AS workspaceId,
      slack_user_id AS slackUserId,
      event_type AS eventType,
      summary_json AS summaryJson,
      created_at AS createdAt
    FROM agent_runtime_events
    WHERE runtime_id = ?
    ORDER BY created_at ASC
  `);
  const upsertConversationRoute = db.query(`
    INSERT INTO conversation_routes (
      id,
      workspace_id,
      slack_user_id,
      transport,
      destination_json,
      kind,
      granted_by_slack_user_id,
      expires_at,
      binding_json,
      last_delivery_failure_at,
      last_delivery_failure_code,
      last_delivery_failure_notified_at,
      consecutive_delivery_failures,
      created_at,
      updated_at,
      revoked_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, ?, ?, NULL)
    ON CONFLICT(id) DO UPDATE SET
      destination_json = excluded.destination_json,
      kind = excluded.kind,
      granted_by_slack_user_id = excluded.granted_by_slack_user_id,
      expires_at = excluded.expires_at,
      binding_json = excluded.binding_json,
      last_delivery_failure_at =
        CASE WHEN excluded.binding_json IS NULL THEN NULL ELSE last_delivery_failure_at END,
      last_delivery_failure_code =
        CASE WHEN excluded.binding_json IS NULL THEN NULL ELSE last_delivery_failure_code END,
      last_delivery_failure_notified_at =
        CASE WHEN excluded.binding_json IS NULL THEN NULL ELSE last_delivery_failure_notified_at END,
      consecutive_delivery_failures =
        CASE WHEN excluded.binding_json IS NULL THEN 0 ELSE consecutive_delivery_failures END,
      updated_at = excluded.updated_at,
      revoked_at =
        CASE WHEN excluded.binding_json IS NULL THEN NULL ELSE revoked_at END
  `);
  const getConversationRouteById = db.query<ConversationRouteRecord, [string]>(`
    SELECT
      id,
      workspace_id AS workspaceId,
      slack_user_id AS slackUserId,
      transport,
      destination_json AS destinationJson,
      kind,
      granted_by_slack_user_id AS grantedBySlackUserId,
      expires_at AS expiresAt,
      binding_json AS bindingJson,
      last_delivery_failure_at AS lastDeliveryFailureAt,
      last_delivery_failure_code AS lastDeliveryFailureCode,
      last_delivery_failure_notified_at AS lastDeliveryFailureNotifiedAt,
      consecutive_delivery_failures AS consecutiveDeliveryFailures,
      created_at AS createdAt,
      updated_at AS updatedAt,
      revoked_at AS revokedAt
    FROM conversation_routes
    WHERE id = ?
  `);
  const revokeConversationRoutesByDestination = db.query(`
    UPDATE conversation_routes
    SET revoked_at = ?, updated_at = ?
    WHERE workspace_id = ?
      AND transport = ?
      AND destination_json = ?
      AND kind = ?
      AND revoked_at IS NULL
  `);
  const revokeConversationRouteById = db.query(`
    UPDATE conversation_routes
    SET revoked_at = ?, updated_at = ?
    WHERE id = ?
      AND revoked_at IS NULL
  `);
  const recordConversationRouteDeliveryFailure = db.query(`
    UPDATE conversation_routes
    SET
      last_delivery_failure_at = ?,
      last_delivery_failure_code = ?,
      last_delivery_failure_notified_at =
        CASE WHEN ? THEN ? ELSE last_delivery_failure_notified_at END,
      consecutive_delivery_failures = consecutive_delivery_failures + 1,
      updated_at = ?
    WHERE id = ?
      AND revoked_at IS NULL
  `);
  const resetConversationRouteDeliveryFailure = db.query(`
    UPDATE conversation_routes
    SET
      last_delivery_failure_at = NULL,
      last_delivery_failure_code = NULL,
      last_delivery_failure_notified_at = NULL,
      consecutive_delivery_failures = 0,
      updated_at = ?
    WHERE id = ?
      AND (
        last_delivery_failure_at IS NOT NULL
        OR last_delivery_failure_code IS NOT NULL
        OR last_delivery_failure_notified_at IS NOT NULL
        OR consecutive_delivery_failures <> 0
      )
  `);
  const upsertWorkspacePolicy = db.query(`
    INSERT INTO workspace_policy (
      workspace_id,
      key,
      value_json,
      updated_by_slack_user_id,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_by_slack_user_id = excluded.updated_by_slack_user_id,
      updated_at = excluded.updated_at
  `);
  const getWorkspacePolicy = db.query<WorkspacePolicyRow, [string, string]>(`
    SELECT
      workspace_id AS workspaceId,
      key,
      value_json AS valueJson,
      updated_by_slack_user_id AS updatedBySlackUserId,
      updated_at AS updatedAt
    FROM workspace_policy
    WHERE workspace_id = ? AND key = ?
  `);
  const listWorkspacePolicy = db.query<WorkspacePolicyRow, [string]>(`
    SELECT
      workspace_id AS workspaceId,
      key,
      value_json AS valueJson,
      updated_by_slack_user_id AS updatedBySlackUserId,
      updated_at AS updatedAt
    FROM workspace_policy
    WHERE workspace_id = ?
    ORDER BY key ASC
  `);
  const upsertUserPreference = db.query(`
    INSERT INTO user_preferences (
      workspace_id,
      slack_user_id,
      key,
      value_json,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, slack_user_id, key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `);
  const getUserPreference = db.query<UserPreferenceRow, [string, string, string]>(`
    SELECT
      workspace_id AS workspaceId,
      slack_user_id AS slackUserId,
      key,
      value_json AS valueJson,
      updated_at AS updatedAt
    FROM user_preferences
    WHERE workspace_id = ? AND slack_user_id = ? AND key = ?
  `);
  const listUserPreferences = db.query<UserPreferenceRow, [string, string]>(`
    SELECT
      workspace_id AS workspaceId,
      slack_user_id AS slackUserId,
      key,
      value_json AS valueJson,
      updated_at AS updatedAt
    FROM user_preferences
    WHERE workspace_id = ? AND slack_user_id = ?
    ORDER BY key ASC
  `);
  const upsertAgentMemory = db.query(`
    INSERT INTO agent_memory (
      workspace_id,
      scope,
      owner_id,
      key,
      value_json,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, scope, owner_id, key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `);
  const getAgentMemory = db.query<
    AgentMemoryRow,
    [string, AgentMemoryScope, string, string]
  >(`
    SELECT
      workspace_id AS workspaceId,
      scope,
      owner_id AS ownerId,
      key,
      value_json AS valueJson,
      updated_at AS updatedAt
    FROM agent_memory
    WHERE workspace_id = ? AND scope = ? AND owner_id = ? AND key = ?
  `);
  const listAgentMemory = db.query<
    AgentMemoryRow,
    [string, AgentMemoryScope, string]
  >(`
    SELECT
      workspace_id AS workspaceId,
      scope,
      owner_id AS ownerId,
      key,
      value_json AS valueJson,
      updated_at AS updatedAt
    FROM agent_memory
    WHERE workspace_id = ? AND scope = ? AND owner_id = ?
    ORDER BY key ASC
  `);
  const deleteAgentMemory = db.query(`
    DELETE FROM agent_memory
    WHERE workspace_id = ? AND scope = ? AND owner_id = ? AND key = ?
  `);
  const upsertAgentJobState = db.query(`
    INSERT INTO agent_job_state (
      job_id,
      workspace_id,
      slack_user_id,
      state_json,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(job_id) DO UPDATE SET
      workspace_id = excluded.workspace_id,
      slack_user_id = excluded.slack_user_id,
      state_json = excluded.state_json,
      updated_at = excluded.updated_at
  `);
  const getAgentJobState = db.query<AgentJobStateRow, [string]>(`
    SELECT
      job_id AS jobId,
      workspace_id AS workspaceId,
      slack_user_id AS slackUserId,
      state_json AS stateJson,
      updated_at AS updatedAt
    FROM agent_job_state
    WHERE job_id = ?
  `);
  const listAgentJobStatesForPrincipal = db.query<
    AgentJobStateRow,
    [string, string]
  >(`
    SELECT
      job_id AS jobId,
      workspace_id AS workspaceId,
      slack_user_id AS slackUserId,
      state_json AS stateJson,
      updated_at AS updatedAt
    FROM agent_job_state
    WHERE workspace_id = ? AND slack_user_id = ?
    ORDER BY updated_at DESC, job_id ASC
  `);
  const deleteAgentJobState = db.query(`
    DELETE FROM agent_job_state
    WHERE job_id = ?
  `);
  const upsertAgentJobCapability = db.query(`
    INSERT INTO agent_job_capabilities (
      job_id,
      workspace_id,
      slack_user_id,
      required_tools_json,
      route_id,
      policy_hash,
      capability_profile,
      runtime_type,
      state_refs_json,
      visibility_policy_json,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(job_id) DO UPDATE SET
      workspace_id = excluded.workspace_id,
      slack_user_id = excluded.slack_user_id,
      required_tools_json = excluded.required_tools_json,
      route_id = excluded.route_id,
      policy_hash = excluded.policy_hash,
      capability_profile = excluded.capability_profile,
      runtime_type = excluded.runtime_type,
      state_refs_json = excluded.state_refs_json,
      visibility_policy_json = excluded.visibility_policy_json,
      updated_at = excluded.updated_at
  `);
  const getAgentJobCapability = db.query<AgentJobCapabilityRow, [string]>(`
    SELECT
      job_id AS jobId,
      workspace_id AS workspaceId,
      slack_user_id AS slackUserId,
      required_tools_json AS requiredToolsJson,
      route_id AS routeId,
      policy_hash AS policyHash,
      capability_profile AS capabilityProfile,
      runtime_type AS runtimeType,
      state_refs_json AS stateRefsJson,
      visibility_policy_json AS visibilityPolicyJson,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM agent_job_capabilities
    WHERE job_id = ?
  `);
  const listAgentJobCapabilitiesForPrincipal = db.query<
    AgentJobCapabilityRow,
    [string, string]
  >(`
    SELECT
      job_id AS jobId,
      workspace_id AS workspaceId,
      slack_user_id AS slackUserId,
      required_tools_json AS requiredToolsJson,
      route_id AS routeId,
      policy_hash AS policyHash,
      capability_profile AS capabilityProfile,
      runtime_type AS runtimeType,
      state_refs_json AS stateRefsJson,
      visibility_policy_json AS visibilityPolicyJson,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM agent_job_capabilities
    WHERE workspace_id = ? AND slack_user_id = ?
    ORDER BY updated_at DESC, job_id ASC
  `);
  const deleteAgentJobCapability = db.query(`
    DELETE FROM agent_job_capabilities
    WHERE job_id = ?
  `);
  const upsertSkillCatalog = db.query(`
    INSERT INTO skill_catalog (
      id,
      version,
      title,
      description,
      metadata_json,
      content_ref,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id, version) DO UPDATE SET
      title = excluded.title,
      description = excluded.description,
      metadata_json = excluded.metadata_json,
      content_ref = excluded.content_ref
  `);
  const getSkillCatalog = db.query<SkillCatalogRow, [string, string]>(`
    SELECT
      id,
      version,
      title,
      description,
      metadata_json AS metadataJson,
      content_ref AS contentRef,
      created_at AS createdAt
    FROM skill_catalog
    WHERE id = ? AND version = ?
  `);
  const listSkillCatalog = db.query<SkillCatalogRow, []>(`
    SELECT
      id,
      version,
      title,
      description,
      metadata_json AS metadataJson,
      content_ref AS contentRef,
      created_at AS createdAt
    FROM skill_catalog
    ORDER BY id ASC, version ASC
  `);
  const upsertWorkspaceSkill = db.query(`
    INSERT INTO workspace_skills (
      workspace_id,
      skill_id,
      version,
      enabled,
      updated_by_slack_user_id,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, skill_id, version) DO UPDATE SET
      enabled = excluded.enabled,
      updated_by_slack_user_id = excluded.updated_by_slack_user_id,
      updated_at = excluded.updated_at
  `);
  const listWorkspaceSkills = db.query<WorkspaceSkillRecord, [string]>(`
    SELECT
      workspace_id AS workspaceId,
      skill_id AS skillId,
      version,
      enabled,
      updated_by_slack_user_id AS updatedBySlackUserId,
      updated_at AS updatedAt
    FROM workspace_skills
    WHERE workspace_id = ?
    ORDER BY skill_id ASC, version ASC
  `);
  const upsertUserSkill = db.query(`
    INSERT INTO user_skills (
      workspace_id,
      slack_user_id,
      skill_id,
      version,
      enabled,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, slack_user_id, skill_id, version) DO UPDATE SET
      enabled = excluded.enabled,
      updated_at = excluded.updated_at
  `);
  const listUserSkills = db.query<UserSkillRecord, [string, string]>(`
    SELECT
      workspace_id AS workspaceId,
      slack_user_id AS slackUserId,
      skill_id AS skillId,
      version,
      enabled,
      updated_at AS updatedAt
    FROM user_skills
    WHERE workspace_id = ? AND slack_user_id = ?
    ORDER BY skill_id ASC, version ASC
  `);

  return {
    createOAuthState(slackUserId: string, ttlMs = 10 * 60 * 1000): string {
      const state = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + ttlMs).toISOString();
      insertState.run(state, slackUserId, expiresAt);
      return state;
    },

    consumeOAuthState(state: string): OAuthState | null {
      deleteExpiredStates.run(new Date().toISOString());
      const row = getState.get(state);
      if (!row) {
        return null;
      }
      deleteState.run(state);
      return row;
    },

    upsertConnectedUser(input: {
      email: string;
      slackUserId: string;
      githubLogin: string;
      githubToken: string;
    }): void {
      upsertUser.run(
        input.email,
        input.slackUserId,
        input.githubLogin,
        input.githubToken
      );
      upsertProviderConnection.run(
        "github",
        input.email,
        input.slackUserId,
        input.githubLogin,
        input.githubToken,
        null,
        null
      );
    },

    upsertProviderConnection(input: {
      provider: Provider;
      email: string;
      slackUserId: string;
      providerLogin: string;
      accessToken: string;
      refreshToken?: string | null;
      accessTokenExpiresAt?: string | null;
    }): void {
      upsertProviderConnection.run(
        input.provider,
        input.email,
        input.slackUserId,
        input.providerLogin,
        input.accessToken,
        input.refreshToken ?? null,
        input.accessTokenExpiresAt ?? null
      );
    },

    getConnectedUserByEmail(email: string): ConnectedUser | null {
      return getUserByEmail.get(email);
    },

    getConnection(provider: Provider, email: string): ProviderConnection | null {
      const connection = getProviderConnection.get(provider, email);
      if (connection) {
        return connection;
      }

      if (provider !== "github") {
        return null;
      }

      const user = getUserByEmail.get(email);
      if (!user) {
        return null;
      }

      return {
        provider,
        email: user.email,
        slackUserId: user.slackUserId,
        providerLogin: user.githubLogin,
        accessToken: user.githubToken,
        refreshToken: null,
        accessTokenExpiresAt: null,
        connectedAt: user.connectedAt
      };
    },

    getConnectionForSlackUser(
      provider: Provider,
      slackUserId: string
    ): ProviderConnection | null {
      const connection = getProviderConnectionBySlackUser.get(
        provider,
        slackUserId
      );
      if (connection) {
        return connection;
      }

      if (provider !== "github") {
        return null;
      }

      const user = getUserBySlackUser.get(slackUserId);
      if (!user) {
        return null;
      }

      return {
        provider,
        email: user.email,
        slackUserId: user.slackUserId,
        providerLogin: user.githubLogin,
        accessToken: user.githubToken,
        refreshToken: null,
        accessTokenExpiresAt: null,
        connectedAt: user.connectedAt
      };
    },

    deleteConnectionForSlackUser(provider: Provider, slackUserId: string): boolean {
      const deleted = deleteProviderConnectionBySlackUser.run(
        provider,
        slackUserId
      ).changes;
      const legacyDeleted =
        provider === "github"
          ? deleteLegacyGitHubUserBySlackUser.run(slackUserId).changes
          : 0;
      return deleted > 0 || legacyDeleted > 0;
    },

    getOrCreateAgentRuntime(input: {
      workspaceId: string;
      slackUserId: string;
      engine: AgentRuntimeEngine;
      endpointUrl: string;
      authTokenHash: string;
      statePath: string;
      configPath: string;
      workspacePath: string;
      sandboxId?: string | null;
      policyHash?: string | null;
      now?: Date;
    }): AgentRuntimeRecord {
      const existing = getAgentRuntimeByPrincipal.get(
        input.workspaceId,
        input.slackUserId,
        input.engine
      );
      if (existing) {
        const now = (input.now ?? new Date()).toISOString();
        if (
          existing.endpointUrl !== input.endpointUrl ||
          existing.authTokenHash !== input.authTokenHash ||
          existing.statePath !== input.statePath ||
          existing.configPath !== input.configPath ||
          existing.workspacePath !== input.workspacePath ||
          existing.sandboxId !== (input.sandboxId ?? null)
        ) {
          updateAgentRuntimeBinding.run(
            input.endpointUrl,
            input.authTokenHash,
            input.statePath,
            input.configPath,
            input.workspacePath,
            input.sandboxId ?? null,
            now,
            existing.id
          );
        }
        if (input.policyHash && existing.policyHash !== input.policyHash) {
          updateAgentRuntimePolicyHash.run(input.policyHash, now, existing.id);
          const updated = getAgentRuntimeById.get(existing.id);
          if (!updated) {
            throw new Error("Failed to update agent runtime policy hash");
          }
          insertAgentRuntimeEvent.run(
            crypto.randomUUID(),
            updated.id,
            updated.workspaceId,
            updated.slackUserId,
            "runtime_policy_changed",
            JSON.stringify({
              previousPolicyHash: existing.policyHash,
              policyHash: input.policyHash
            }),
            now
          );
          return updated;
        }
        return getAgentRuntimeById.get(existing.id) ?? existing;
      }

      const id = buildAgentRuntimeId(
        input.workspaceId,
        input.slackUserId,
        input.engine
      );
      const now = (input.now ?? new Date()).toISOString();
      insertAgentRuntime.run(
        id,
        input.workspaceId,
        input.slackUserId,
        input.engine,
        "ready",
        input.endpointUrl,
        input.authTokenHash,
        input.statePath,
        input.configPath,
        input.workspacePath,
        input.sandboxId ?? null,
        input.policyHash ?? null,
        now,
        now,
        now
      );

      const created = getAgentRuntimeById.get(id);
      if (!created) {
        throw new Error("Failed to create agent runtime record");
      }
      return created;
    },

    getAgentRuntime(id: string): AgentRuntimeRecord | null {
      return getAgentRuntimeById.get(id);
    },

    getAgentRuntimeForPrincipal(input: {
      workspaceId: string;
      slackUserId: string;
      engine: AgentRuntimeEngine;
    }): AgentRuntimeRecord | null {
      return getAgentRuntimeByPrincipal.get(
        input.workspaceId,
        input.slackUserId,
        input.engine
      );
    },

    listIdleAgentRuntimes(idleBefore: Date): AgentRuntimeRecord[] {
      return listIdleAgentRuntimes.all(idleBefore.toISOString());
    },

    recordAgentRuntimeEvent(input: {
      runtimeId: string;
      eventType: AgentRuntimeEventType;
      summary?: Record<string, unknown>;
      now?: Date;
    }): void {
      const runtime = getAgentRuntimeById.get(input.runtimeId);
      if (!runtime) {
        return;
      }

      const now = (input.now ?? new Date()).toISOString();
      insertAgentRuntimeEvent.run(
        crypto.randomUUID(),
        runtime.id,
        runtime.workspaceId,
        runtime.slackUserId,
        input.eventType,
        JSON.stringify(input.summary ?? {}),
        now
      );
    },

    listAgentRuntimeEvents(runtimeId: string): AgentRuntimeEventRecord[] {
      return listAgentRuntimeEvents.all(runtimeId);
    },

    upsertConversationRoute(input: {
      workspaceId: string;
      slackUserId: string;
      transport: ConversationTransport;
      destination: Record<string, unknown>;
      kind?: ConversationRouteKind;
      grantedBySlackUserId?: string | null;
      expiresAt?: string | null;
      binding?: Record<string, unknown> | null;
      now?: Date;
    }): ConversationRouteRecord {
      const destinationJson = stableJson(input.destination);
      const bindingJson = input.binding ? stableJson(input.binding) : null;
      const id = buildConversationRouteId(
        input.workspaceId,
        input.slackUserId,
        input.transport,
        destinationJson,
        input.kind ?? "origin",
        bindingJson
      );
      const now = (input.now ?? new Date()).toISOString();
      upsertConversationRoute.run(
        id,
        input.workspaceId,
        input.slackUserId,
        input.transport,
        destinationJson,
        input.kind ?? "origin",
        input.grantedBySlackUserId ?? null,
        input.expiresAt ?? null,
        bindingJson,
        now,
        now
      );

      const route = getConversationRouteById.get(id);
      if (!route) {
        throw new Error("Failed to create conversation route");
      }
      return route;
    },

    getConversationRoute(id: string): ConversationRouteRecord | null {
      return getConversationRouteById.get(id);
    },

    getConversationGrantRouteForSlackChannel(input: {
      workspaceId: string;
      slackUserId: string;
      channelId: string;
    }): ConversationRouteRecord | null {
      const legacyDestinationJson = stableJson({
        channelId: input.channelId,
        isDirectMessage: false,
        rootId: `channel:${input.channelId}`
      });
      const legacyId = buildConversationRouteId(
        input.workspaceId,
        input.slackUserId,
        "slack",
        legacyDestinationJson,
        "grant",
        null
      );
      const legacyRoute = getConversationRouteById.get(legacyId);
      if (legacyRoute) {
        return legacyRoute;
      }

      const privateDestinationJson = stableJson({
        channelId: input.channelId,
        isDirectMessage: false,
        isPrivateChannel: true,
        rootId: `channel:${input.channelId}`
      });
      const privateId = buildConversationRouteId(
        input.workspaceId,
        input.slackUserId,
        "slack",
        privateDestinationJson,
        "grant",
        null
      );
      return getConversationRouteById.get(privateId);
    },

    recordConversationRouteDeliveryFailure(input: {
      routeId: string;
      code?: string | null;
      notificationSent?: boolean;
      now?: Date;
    }): ConversationRouteRecord | null {
      const now = (input.now ?? new Date()).toISOString();
      recordConversationRouteDeliveryFailure.run(
        now,
        input.code ?? null,
        input.notificationSent ? 1 : 0,
        now,
        now,
        input.routeId
      );
      return getConversationRouteById.get(input.routeId);
    },

    revokeConversationRoute(input: {
      routeId: string;
      now?: Date;
    }): ConversationRouteRecord | null {
      const now = (input.now ?? new Date()).toISOString();
      const result = revokeConversationRouteById.run(now, now, input.routeId);
      return result.changes > 0 ? getConversationRouteById.get(input.routeId) : null;
    },

    resetConversationRouteDeliveryFailure(input: {
      routeId: string;
      now?: Date;
    }): ConversationRouteRecord | null {
      const now = (input.now ?? new Date()).toISOString();
      resetConversationRouteDeliveryFailure.run(now, input.routeId);
      return getConversationRouteById.get(input.routeId);
    },

    revokeConversationRoutesForDestination(input: {
      workspaceId: string;
      transport: ConversationTransport;
      destination: Record<string, unknown>;
      kind?: ConversationRouteKind;
      now?: Date;
    }): number {
      const now = (input.now ?? new Date()).toISOString();
      const result = revokeConversationRoutesByDestination.run(
        now,
        now,
        input.workspaceId,
        input.transport,
        stableJson(input.destination),
        input.kind ?? "origin"
      ) as { changes: number | bigint };
      return Number(result.changes);
    },

    upsertWorkspacePolicy(input: {
      workspaceId: string;
      key: string;
      value: unknown;
      updatedBySlackUserId?: string | null;
      now?: Date;
    }): WorkspacePolicyRecord {
      const now = (input.now ?? new Date()).toISOString();
      upsertWorkspacePolicy.run(
        input.workspaceId,
        input.key,
        stableJson(input.value),
        input.updatedBySlackUserId ?? null,
        now
      );

      const record = getWorkspacePolicy.get(input.workspaceId, input.key);
      if (!record) {
        throw new Error("Failed to store workspace policy");
      }
      return toWorkspacePolicyRecord(record);
    },

    getWorkspacePolicy(
      workspaceId: string,
      key: string
    ): WorkspacePolicyRecord | null {
      const record = getWorkspacePolicy.get(workspaceId, key);
      return record ? toWorkspacePolicyRecord(record) : null;
    },

    listWorkspacePolicy(workspaceId: string): WorkspacePolicyRecord[] {
      return listWorkspacePolicy
        .all(workspaceId)
        .map(toWorkspacePolicyRecord);
    },

    upsertUserPreference(input: {
      workspaceId: string;
      slackUserId: string;
      key: string;
      value: unknown;
      now?: Date;
    }): UserPreferenceRecord {
      const now = (input.now ?? new Date()).toISOString();
      upsertUserPreference.run(
        input.workspaceId,
        input.slackUserId,
        input.key,
        stableJson(input.value),
        now
      );

      const record = getUserPreference.get(
        input.workspaceId,
        input.slackUserId,
        input.key
      );
      if (!record) {
        throw new Error("Failed to store user preference");
      }
      return toUserPreferenceRecord(record);
    },

    getUserPreference(
      workspaceId: string,
      slackUserId: string,
      key: string
    ): UserPreferenceRecord | null {
      const record = getUserPreference.get(workspaceId, slackUserId, key);
      return record ? toUserPreferenceRecord(record) : null;
    },

    listUserPreferences(
      workspaceId: string,
      slackUserId: string
    ): UserPreferenceRecord[] {
      return listUserPreferences
        .all(workspaceId, slackUserId)
        .map(toUserPreferenceRecord);
    },

    upsertAgentMemory(input: {
      workspaceId: string;
      scope: AgentMemoryScope;
      ownerId?: string | null;
      key: string;
      value: unknown;
      now?: Date;
    }): AgentMemoryRecord {
      const ownerId = normalizeAgentMemoryOwnerId(input.scope, input.ownerId);
      const now = (input.now ?? new Date()).toISOString();
      upsertAgentMemory.run(
        input.workspaceId,
        input.scope,
        ownerId,
        input.key,
        stableJson(input.value),
        now
      );

      const record = getAgentMemory.get(
        input.workspaceId,
        input.scope,
        ownerId,
        input.key
      );
      if (!record) {
        throw new Error("Failed to store agent memory");
      }
      return toAgentMemoryRecord(record);
    },

    listAgentMemory(input: {
      workspaceId: string;
      scope: AgentMemoryScope;
      ownerId?: string | null;
    }): AgentMemoryRecord[] {
      return listAgentMemory
        .all(
          input.workspaceId,
          input.scope,
          normalizeAgentMemoryOwnerId(input.scope, input.ownerId)
        )
        .map(toAgentMemoryRecord);
    },

    deleteAgentMemory(input: {
      workspaceId: string;
      scope: AgentMemoryScope;
      ownerId?: string | null;
      key: string;
    }): void {
      deleteAgentMemory.run(
        input.workspaceId,
        input.scope,
        normalizeAgentMemoryOwnerId(input.scope, input.ownerId),
        input.key
      );
    },

    upsertAgentJobState(input: {
      jobId: string;
      workspaceId: string;
      slackUserId: string;
      state: unknown;
      now?: Date;
    }): AgentJobStateRecord {
      const now = (input.now ?? new Date()).toISOString();
      upsertAgentJobState.run(
        input.jobId,
        input.workspaceId,
        input.slackUserId,
        stableJson(input.state),
        now
      );

      const record = getAgentJobState.get(input.jobId);
      if (!record) {
        throw new Error("Failed to store agent job state");
      }
      return toAgentJobStateRecord(record);
    },

    getAgentJobState(jobId: string): AgentJobStateRecord | null {
      const record = getAgentJobState.get(jobId);
      return record ? toAgentJobStateRecord(record) : null;
    },

    listAgentJobStatesForPrincipal(
      workspaceId: string,
      slackUserId: string
    ): AgentJobStateRecord[] {
      return listAgentJobStatesForPrincipal
        .all(workspaceId, slackUserId)
        .map(toAgentJobStateRecord);
    },

    deleteAgentJobState(jobId: string): void {
      deleteAgentJobState.run(jobId);
    },

    upsertAgentJobCapability(input: {
      jobId: string;
      workspaceId: string;
      slackUserId: string;
      requiredTools: string[];
      routeId?: string | null;
      policyHash?: string | null;
      capabilityProfile?: string | null;
      runtimeType?: AgentRuntimeEngine | null;
      stateRefs?: unknown[] | null;
      visibilityPolicy?: unknown;
      now?: Date;
    }): AgentJobCapabilityRecord {
      const now = (input.now ?? new Date()).toISOString();
      const existing = getAgentJobCapability.get(input.jobId);
      upsertAgentJobCapability.run(
        input.jobId,
        input.workspaceId,
        input.slackUserId,
        stableJson(normalizeRequiredTools(input.requiredTools)),
        input.routeId ?? null,
        input.policyHash ?? null,
        normalizeCapabilityProfile(input.capabilityProfile),
        input.runtimeType ?? null,
        stableJson(normalizeStateRefs(input.stateRefs)),
        stableJson(input.visibilityPolicy ?? {}),
        existing?.createdAt ?? now,
        now
      );

      const record = getAgentJobCapability.get(input.jobId);
      if (!record) {
        throw new Error("Failed to store agent job capability");
      }
      return toAgentJobCapabilityRecord(record);
    },

    getAgentJobCapability(jobId: string): AgentJobCapabilityRecord | null {
      const record = getAgentJobCapability.get(jobId);
      return record ? toAgentJobCapabilityRecord(record) : null;
    },

    listAgentJobCapabilitiesForPrincipal(
      workspaceId: string,
      slackUserId: string
    ): AgentJobCapabilityRecord[] {
      return listAgentJobCapabilitiesForPrincipal
        .all(workspaceId, slackUserId)
        .map(toAgentJobCapabilityRecord);
    },

    deleteAgentJobCapability(jobId: string): void {
      deleteAgentJobCapability.run(jobId);
    },

    upsertSkillCatalog(input: {
      id: string;
      version: string;
      title: string;
      description: string;
      metadata: unknown;
      contentRef: string;
      now?: Date;
    }): SkillCatalogRecord {
      const now = (input.now ?? new Date()).toISOString();
      upsertSkillCatalog.run(
        input.id,
        input.version,
        input.title,
        input.description,
        stableJson(input.metadata),
        input.contentRef,
        now
      );

      const record = getSkillCatalog.get(input.id, input.version);
      if (!record) {
        throw new Error("Failed to store skill catalog record");
      }
      return toSkillCatalogRecord(record);
    },

    getSkillCatalog(id: string, version: string): SkillCatalogRecord | null {
      const record = getSkillCatalog.get(id, version);
      return record ? toSkillCatalogRecord(record) : null;
    },

    listSkillCatalog(): SkillCatalogRecord[] {
      return listSkillCatalog.all().map(toSkillCatalogRecord);
    },

    upsertWorkspaceSkill(input: {
      workspaceId: string;
      skillId: string;
      version: string;
      enabled: boolean;
      updatedBySlackUserId?: string | null;
      now?: Date;
    }): WorkspaceSkillRecord {
      const now = (input.now ?? new Date()).toISOString();
      upsertWorkspaceSkill.run(
        input.workspaceId,
        input.skillId,
        input.version,
        input.enabled ? 1 : 0,
        input.updatedBySlackUserId ?? null,
        now
      );
      return {
        workspaceId: input.workspaceId,
        skillId: input.skillId,
        version: input.version,
        enabled: input.enabled,
        updatedBySlackUserId: input.updatedBySlackUserId ?? null,
        updatedAt: now
      };
    },

    listWorkspaceSkills(workspaceId: string): WorkspaceSkillRecord[] {
      return listWorkspaceSkills.all(workspaceId).map(toWorkspaceSkillRecord);
    },

    upsertUserSkill(input: {
      workspaceId: string;
      slackUserId: string;
      skillId: string;
      version: string;
      enabled: boolean;
      now?: Date;
    }): UserSkillRecord {
      const now = (input.now ?? new Date()).toISOString();
      upsertUserSkill.run(
        input.workspaceId,
        input.slackUserId,
        input.skillId,
        input.version,
        input.enabled ? 1 : 0,
        now
      );
      return {
        workspaceId: input.workspaceId,
        slackUserId: input.slackUserId,
        skillId: input.skillId,
        version: input.version,
        enabled: input.enabled,
        updatedAt: now
      };
    },

    listUserSkills(
      workspaceId: string,
      slackUserId: string
    ): UserSkillRecord[] {
      return listUserSkills.all(workspaceId, slackUserId).map(toUserSkillRecord);
    },

    updateAgentRuntimeStatus(
      id: string,
      input: {
        status: AgentRuntimeStatus;
        failureReason?: string | null;
        now?: Date;
      }
    ): void {
      const now = (input.now ?? new Date()).toISOString();
      updateAgentRuntimeStatus.run(
        input.status,
        now,
        input.status === "stopped" ? now : null,
        input.failureReason ?? null,
        id
      );
    },

    touchAgentRuntime(id: string, now = new Date()): void {
      const timestamp = now.toISOString();
      touchAgentRuntime.run(timestamp, timestamp, id);
    },

    close(): void {
      db.close();
    }
  };
}

function ensureProviderConnectionColumn(
  db: Database,
  name: string,
  definition: string
): void {
  const columns = db
    .query<{ name: string }, []>("PRAGMA table_info(provider_connections)")
    .all()
    .map((column) => column.name);
  if (!columns.includes(name)) {
    db.exec(`ALTER TABLE provider_connections ADD COLUMN ${name} ${definition}`);
  }
}

function ensureAgentRuntimeColumn(
  db: Database,
  name: string,
  definition: string
): void {
  const columns = db
    .query<{ name: string }, []>("PRAGMA table_info(agent_runtimes)")
    .all()
    .map((column) => column.name);
  if (!columns.includes(name)) {
    db.exec(`ALTER TABLE agent_runtimes ADD COLUMN ${name} ${definition}`);
  }
}

function ensureAgentJobCapabilityColumn(
  db: Database,
  name: string,
  definition: string
): void {
  const columns = db
    .query<{ name: string }, []>("PRAGMA table_info(agent_job_capabilities)")
    .all()
    .map((column) => column.name);
  if (!columns.includes(name)) {
    db.exec(`ALTER TABLE agent_job_capabilities ADD COLUMN ${name} ${definition}`);
  }
}

function ensureConversationRouteColumn(
  db: Database,
  name: string,
  definition: string
): void {
  const columns = db
    .query<{ name: string }, []>("PRAGMA table_info(conversation_routes)")
    .all()
    .map((column) => column.name);
  if (!columns.includes(name)) {
    db.exec(`ALTER TABLE conversation_routes ADD COLUMN ${name} ${definition}`);
  }
}

export function buildAgentRuntimeId(
  workspaceId: string,
  slackUserId: string,
  engine: AgentRuntimeEngine
): string {
  return `rt_${createHash("sha256")
    .update(`${workspaceId}:${slackUserId}:${engine}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function buildConversationRouteId(
  workspaceId: string,
  slackUserId: string,
  transport: ConversationTransport,
  destinationJson: string,
  kind: ConversationRouteKind = "origin",
  bindingJson: string | null = null
): string {
  const seed =
    kind === "origin" && !bindingJson
      ? `${workspaceId}:${slackUserId}:${transport}:${destinationJson}`
      : `${workspaceId}:${slackUserId}:${transport}:${kind}:${destinationJson}:${bindingJson ?? ""}`;
  return `convrt_${createHash("sha256")
    .update(seed)
    .digest("hex")
    .slice(0, 24)}`;
}

function toWorkspacePolicyRecord(row: WorkspacePolicyRow): WorkspacePolicyRecord {
  return {
    workspaceId: row.workspaceId,
    key: row.key,
    value: parseStoredJson(row.valueJson),
    updatedBySlackUserId: row.updatedBySlackUserId,
    updatedAt: row.updatedAt
  };
}

function toUserPreferenceRecord(row: UserPreferenceRow): UserPreferenceRecord {
  return {
    workspaceId: row.workspaceId,
    slackUserId: row.slackUserId,
    key: row.key,
    value: parseStoredJson(row.valueJson),
    updatedAt: row.updatedAt
  };
}

function toAgentMemoryRecord(row: AgentMemoryRow): AgentMemoryRecord {
  return {
    workspaceId: row.workspaceId,
    scope: row.scope,
    ownerId: row.ownerId,
    key: row.key,
    value: parseStoredJson(row.valueJson),
    updatedAt: row.updatedAt
  };
}

function toAgentJobStateRecord(row: AgentJobStateRow): AgentJobStateRecord {
  return {
    jobId: row.jobId,
    workspaceId: row.workspaceId,
    slackUserId: row.slackUserId,
    state: parseStoredJson(row.stateJson),
    updatedAt: row.updatedAt
  };
}

function toAgentJobCapabilityRecord(
  row: AgentJobCapabilityRow
): AgentJobCapabilityRecord {
  return {
    jobId: row.jobId,
    workspaceId: row.workspaceId,
    slackUserId: row.slackUserId,
    requiredTools: requiredToolsFromJson(row.requiredToolsJson),
    routeId: row.routeId,
    policyHash: row.policyHash,
    capabilityProfile: normalizeCapabilityProfile(row.capabilityProfile),
    runtimeType: normalizeAgentRuntimeEngine(row.runtimeType),
    stateRefs: stateRefsFromJson(row.stateRefsJson),
    visibilityPolicy: parseStoredJson(row.visibilityPolicyJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function toSkillCatalogRecord(row: SkillCatalogRow): SkillCatalogRecord {
  return {
    id: row.id,
    version: row.version,
    title: row.title,
    description: row.description,
    metadata: parseStoredJson(row.metadataJson),
    contentRef: row.contentRef,
    createdAt: row.createdAt
  };
}

function toWorkspaceSkillRecord(row: WorkspaceSkillRecord): WorkspaceSkillRecord {
  return {
    workspaceId: row.workspaceId,
    skillId: row.skillId,
    version: row.version,
    enabled: Boolean(row.enabled),
    updatedBySlackUserId: row.updatedBySlackUserId,
    updatedAt: row.updatedAt
  };
}

function toUserSkillRecord(row: UserSkillRecord): UserSkillRecord {
  return {
    workspaceId: row.workspaceId,
    slackUserId: row.slackUserId,
    skillId: row.skillId,
    version: row.version,
    enabled: Boolean(row.enabled),
    updatedAt: row.updatedAt
  };
}

function normalizeAgentMemoryOwnerId(
  scope: AgentMemoryScope,
  ownerId: string | null | undefined
): string {
  if (scope === "workspace") {
    return "";
  }
  if (!ownerId?.trim()) {
    throw new Error(`${scope} memory requires an owner id`);
  }
  return ownerId.trim();
}

function normalizeRequiredTools(requiredTools: string[]): string[] {
  return [...new Set(requiredTools.map((tool) => tool.trim()).filter(Boolean))]
    .sort();
}

function normalizeCapabilityProfile(value: string | null | undefined): string {
  const normalized = value?.trim();
  return normalized || "scheduled_job";
}

function normalizeAgentRuntimeEngine(
  value: string | null | undefined
): AgentRuntimeEngine | null {
  if (value === "burble-direct" || value === "direct-provider") {
    return "burble-native";
  }
  return isAgentRuntimeEngine(value) ? value : null;
}

function normalizeStateRefs(value: unknown[] | null | undefined): unknown[] {
  return Array.isArray(value) ? value : [];
}

function requiredToolsFromJson(valueJson: string): string[] {
  const value = parseStoredJson(valueJson);
  return Array.isArray(value)
    ? value.filter((tool): tool is string => typeof tool === "string")
    : [];
}

function stateRefsFromJson(valueJson: string): unknown[] {
  const value = parseStoredJson(valueJson);
  return Array.isArray(value) ? value : [];
}

function parseStoredJson(valueJson: string): unknown {
  return JSON.parse(valueJson) as unknown;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)])
  );
}
