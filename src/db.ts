import { Database } from "bun:sqlite";

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

    close(): void {
      db.close();
    }
  };
}
