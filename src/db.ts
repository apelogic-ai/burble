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
  `);

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
    },

    getConnectedUserByEmail(email: string): ConnectedUser | null {
      return getUserByEmail.get(email);
    },

    getConnection(provider: Provider, email: string): ProviderConnection | null {
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
