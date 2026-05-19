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

- `/connect-github` starts a per-user GitHub OAuth flow.
- `/github-me` verifies the connected GitHub identity for the Slack user.
- `/issues` lists open GitHub issues assigned to the connected user.

The architecture note is copied at `docs/slack-tui-architecture.md`.
