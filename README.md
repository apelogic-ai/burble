# Burble

Slack-as-TUI PoC for identity-scoped GitHub and Jira access.

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

Then set `BASE_URL` in `.env` and configure OAuth callback URLs:

```text
{BASE_URL}/oauth/github/callback
{BASE_URL}/oauth/jira/callback
{BASE_URL}/oauth/slack/callback
```

## Slack Commands

- `@Burble connect github` starts a per-user GitHub OAuth flow from a mention.
- `@Burble who am I on GitHub?` verifies the connected GitHub identity.
- `@Burble what issues are assigned to me?` lists assigned GitHub issues privately.
- `@Burble show my pull requests` lists open pull requests authored by you.
- `@Burble search GitHub issues for billing` searches GitHub issues privately.
- `/help` shows command help and examples.
- `/auth` shows connected account status and auth buttons.
- `/auth github` starts the GitHub OAuth flow.
- `/auth jira` starts the Jira OAuth flow.
- `/auth slack` starts the Slack user OAuth flow for message search.
- `/agent-status` powers up and shows the current agent runtime status for the Slack user.
- `/agent-config` powers up the runtime and shows a redacted preview of its configured runtime config file.

Jira OAuth uses Atlassian 3LO with these scopes:

```text
read:jira-user read:jira-work write:jira-work
```

Required Slack bot scopes:

- `app_mentions:read`
- `chat:write`
- `commands`
- `channels:history`
- `groups:history`
- `im:history`
- `im:write`
- `users:read`
- `users:read.email`

Optional Slack user OAuth scopes for `/auth slack` message search:

- `search:read`
- `users:read`

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

`AI_MODEL` is the normalized LLM selector for both the in-process AI SDK
runner and the OpenClaw/NemoClaw runtime. Use `provider:model`:

```env
AI_MODEL=openai:gpt-5.4
AI_MODEL=anthropic:claude-opus-4.6
AI_MODEL=ollama:qwen3-coder:30b-cloud
OLLAMA_API_KEY=...
OLLAMA_BASE_URL=https://ollama.com
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

The runtime defaults to `OPENCLAW_NEMOCLAW_ENGINE=deterministic`. Setting
`OPENCLAW_NEMOCLAW_ENGINE=openclaw` makes it invoke an `openclaw` CLI binary
inside the runtime container with sanitized Burble tool context. The optional
`deploy/dev/compose/docker-compose.openclaw-cli.yml` override builds that image
from `runtimes/openclaw-nemoclaw/Dockerfile.openclaw-cli`.
