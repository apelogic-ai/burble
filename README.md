# Burble

Slack-as-TUI PoC for identity-scoped GitHub access.

## Run

```bash
bun install
cp .env.example .env
bun run dev
```

Expose the local callback server with a tunnel such as:

```bash
ngrok http 3000
```

Then set `BASE_URL` in `.env` and configure the GitHub OAuth callback URL as:

```text
{BASE_URL}/oauth/github/callback
```

## Slack Commands

- `@Burble connect github` starts a per-user GitHub OAuth flow from a mention.
- `@Burble who am I on GitHub?` verifies the connected GitHub identity.
- `@Burble what issues are assigned to me?` lists assigned GitHub issues privately.
- `/connect-github` starts a per-user GitHub OAuth flow.
- `/auth` shows available auth connections.
- `/auth github` starts the GitHub OAuth flow.
- `/github-me` verifies the connected GitHub identity for the Slack user.
- `/issues` lists open GitHub issues assigned to the connected user.

Required Slack bot scopes:

- `app_mentions:read`
- `chat:write`
- `commands`
- `im:write`
- `users:read`
- `users:read.email`

The architecture note is copied at `docs/slack-tui-architecture.md`.
