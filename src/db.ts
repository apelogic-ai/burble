import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

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

export type Provider = "github" | "jira";

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

export type AgentRuntimeEngine = "deterministic" | "openclaw" | "hermes";

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
  | "runtime_stopped"
  | "runtime_run_started"
  | "runtime_run_finished"
  | "runtime_tool_called";

export type AgentRuntimeEventRecord = {
  id: string;
  runtimeId: string;
  workspaceId: string;
  slackUserId: string;
  eventType: AgentRuntimeEventType;
  summaryJson: string;
  createdAt: string;
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
  `);
  ensureProviderConnectionColumn(db, "refresh_token", "TEXT");
  ensureProviderConnectionColumn(db, "access_token_expires_at", "TEXT");

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
      created_at,
      last_seen_at,
      last_used_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

    getOrCreateAgentRuntime(input: {
      workspaceId: string;
      slackUserId: string;
      engine: AgentRuntimeEngine;
      endpointUrl: string;
      authTokenHash: string;
      statePath: string;
      configPath: string;
      workspacePath: string;
      now?: Date;
    }): AgentRuntimeRecord {
      const existing = getAgentRuntimeByPrincipal.get(
        input.workspaceId,
        input.slackUserId,
        input.engine
      );
      if (existing) {
        return existing;
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

function buildAgentRuntimeId(
  workspaceId: string,
  slackUserId: string,
  engine: AgentRuntimeEngine
): string {
  return `rt_${createHash("sha256")
    .update(`${workspaceId}:${slackUserId}:${engine}`)
    .digest("hex")
    .slice(0, 32)}`;
}
