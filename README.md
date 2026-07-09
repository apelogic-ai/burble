# Burble

Slack-as-TUI assistant for identity-scoped GitHub, Jira, Google Workspace,
HubSpot, and Slack search access.

## Run

```bash
bun install
cp .env.example .env
bun run dev
```

## Releases

Release automation and the manual tag-cutting process are documented in
[`docs/releases.md`](docs/releases.md). The release guard is:

```bash
bun run release:check
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
{BASE_URL}/oauth/google/callback
{BASE_URL}/oauth/hubspot/callback
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
- `/auth google` starts the Google OAuth flow for Drive files, Calendar, and Gmail.
- `/auth hubspot` starts the HubSpot OAuth flow for CRM contacts, companies, and deals.
- `/auth jira` starts the Jira OAuth flow.
- `/auth slack` starts the Slack user OAuth flow for message search.
- `/agent status` powers up and shows the current agent runtime status for the Slack user.
- `/agent config` powers up the runtime and shows a redacted preview of its selected agent config file.
- `/agent exec <task>` sends an explicit task directly to the user's private agent runtime.
- `/agent-status` is a legacy alias for agent status.
- `/agent-config` is a legacy alias for agent config.

Jira OAuth uses Atlassian 3LO with these scopes:

```text
read:jira-user read:jira-work write:jira-work
```

Google OAuth uses a Google Cloud web OAuth client with redirect URI:

```text
{BASE_URL}/oauth/google/callback
```

Enable the Drive, Calendar, and Gmail APIs for the Google Cloud project and add
these scopes. `drive.file` allows Burble to create and edit files the app owns
or that the user explicitly opens with the app.

```text
openid email profile
https://www.googleapis.com/auth/drive.metadata.readonly
https://www.googleapis.com/auth/drive.file
https://www.googleapis.com/auth/calendar.readonly
https://www.googleapis.com/auth/gmail.readonly
```

HubSpot OAuth uses a HubSpot public app with redirect URI:

```text
{BASE_URL}/oauth/hubspot/callback
```

Configure these scopes:

```text
oauth crm.objects.contacts.read crm.objects.companies.read crm.objects.deals.read
```

Required Slack bot scopes:

- `app_mentions:read`
- `chat:write`
- `commands`
- `channels:history`
- `channels:read`
- `groups:history`
- `groups:read`
- `im:history`
- `im:write`
- `users:read`
- `users:read.email`

Slack scheduled-output destination grants:

- Run `/agent grant here` in a Slack channel to authorize that channel for scheduled job output. Burble must already be a member of the channel.
- Run `/agent ungrant here` in that channel to revoke active scheduled-output grants for the channel. Revocation is channel-level cleanup: any channel member can remove the channel's grants.

Optional Slack user OAuth scopes for `/auth slack` message search:

- `search:read`
- `users:read`

Required Slack event subscription:

- Enable **Event Subscriptions**.
- Subscribe to bot event `app_mention`.
- Subscribe to bot event `message.im` for app DMs.
- With Socket Mode enabled, no Request URL is required.
- Reinstall the app after adding the event.

Required Slack slash commands:

- `/auth`
- `/help`
- `/agent`
- `/agent-status`
- `/agent-config`

The dev Slack app manifest is checked in at
`deploy/dev/slack-app-manifest.yaml`. If a slash command is not listed in the
Slack app configuration, Slack does not dispatch it to Burble, so the Burble app
logs will not show a `Received Slack payload ... command=/agent-config` line.

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
