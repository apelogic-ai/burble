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
- `@Burble show my pull requests` lists open pull requests authored by you.
- `@Burble search GitHub issues for billing` searches GitHub issues privately.
- `/connect-github` starts a per-user GitHub OAuth flow.
- `/auth` shows available auth connections.
- `/auth github` starts the GitHub OAuth flow.
- `/github-me` verifies the connected GitHub identity for the Slack user.
- `/issues` lists open GitHub issues assigned to the connected user.

Required Slack bot scopes:

- `app_mentions:read`
- `chat:write`
- `commands`
- `im:history`
- `im:write`
- `users:read`
- `users:read.email`

Required Slack event subscription:

- Enable **Event Subscriptions**.
- Subscribe to bot event `app_mention`.
- Subscribe to bot event `message.im` for app DMs.
- With Socket Mode enabled, no Request URL is required.
- Reinstall the app after adding the event.

The architecture note is copied at `docs/slack-tui-architecture.md`.

## Agent Runtime

Default LLM mode uses the in-process AI SDK runner:

```env
AGENT_MODE=llm
AGENT_RUNTIME=ai-sdk
AI_MODEL=openai:gpt-5.4
OPENAI_API_KEY=...
```

The optional OpenClaw/NemoClaw adapter uses the same runner contract and calls
the repo-local runtime service in `runtimes/openclaw-nemoclaw`. That runtime
calls Burble's internal tool gateway, not provider APIs directly:

```text
POST /internal/tools/github.listAssignedIssues/execute
Authorization: Bearer ${INTERNAL_API_TOKEN}
```

Caddy blocks `/internal/*` from the public HTTPS endpoint; the gateway is for
container-to-container calls inside the deployment network.
