# Burble Security and DevOps Architecture

This document describes Burble for IT security and DevOps review. It covers
the product architecture, external integrations, backend runtime requirements,
data handling, and supported deployment options.

## Executive Summary

Burble is a Slack-based assistant and agent control plane. Users interact with
one shared Slack app through mentions, direct messages, and slash commands.
Burble handles Slack delivery, OAuth connection flows, provider token storage,
visibility decisions, and routing to optional private agent runtimes.

The core service is a Bun/TypeScript backend with a SQLite data store. It can
run in deterministic mode for scoped command responses, in LLM mode with an
in-process AI SDK runner, or in LLM mode backed by an OpenClaw/NemoClaw runtime
service. For multi-user agent execution, Burble can provision one private
runtime container per Slack principal.

Provider OAuth tokens remain in Burble. Agent runtimes receive sanitized
connection summaries and call back to Burble through internal tool or MCP
gateways when they need provider data.

## Product Components

```text
Slack workspace
  |
  | Slack Socket Mode events, slash commands, OAuth user actions
  v
Burble app
  - Slack adapter and command handlers
  - OAuth callback server
  - Conversation orchestrator
  - Provider tools: GitHub, Jira, Google, Slack search
  - Internal tool gateway
  - Runtime MCP gateway
  - Runtime lifecycle manager
  - SQLite token/runtime registry
  |
  +--> External SaaS APIs
  |     - Slack Web API
  |     - GitHub OAuth/API
  |     - Atlassian OAuth/Jira/API/MCP
  |     - Google OAuth/Drive/Calendar/Gmail APIs
  |     - OpenAI, Anthropic, or Ollama-compatible model endpoints
  |
  +--> Optional private agent runtime
        - OpenClaw/NemoClaw adapter
        - Deterministic bridge, OpenClaw CLI, OpenClaw Gateway, or Burble-direct
        - Internal-only access back to Burble tool/MCP gateways
```

## Public and Internal HTTP Surface

Burble exposes one HTTP server on `PORT`, default `3000`.

Public endpoints:

- `GET /healthz` for health checks.
- `GET /oauth/github/callback` for GitHub OAuth.
- `GET /oauth/jira/callback` for Atlassian Jira OAuth.
- `GET /oauth/google/callback` for Google OAuth.
- `GET /oauth/slack/callback` for Slack user-token OAuth.
- `GET /oauth/jwks` for runtime JWT public keys.

Internal endpoints:

- `POST /internal/tools/{toolName}/execute` for runtime-to-Burble tool calls.
- `POST /mcp`, `/mcp/github`, `/mcp/google`, `/mcp/jira`, `/mcp/slack`, and
  `/mcp/atlassian` for runtime MCP access.

The provided Caddy deployment blocks `/internal/*` and `/mcp*` from the public
HTTPS endpoint and only proxies other paths to Burble. Internal endpoints are
intended for container-to-container traffic on the deployment network.

Slack event delivery uses Socket Mode, so the app does not require a public
Slack event request URL in the current dev deployment. Slash commands still
must be configured in the Slack app so Slack dispatches them to Burble.

## Identity and Authorization Model

Burble's runtime principal is:

```text
workspace_id + slack_user_id
```

The Slack profile email is used to associate provider OAuth connections and to
call provider tools, but it is not the preferred runtime identity because email
addresses can change.

OAuth flow protection:

- Burble creates single-use OAuth state values with a default 10-minute TTL.
- Callback handlers consume and delete the state before storing provider
  connections.
- Slack user OAuth verifies that the returned Slack user matches the user who
  initiated the flow.

Runtime gateway protection:

- Static runtime mode uses `INTERNAL_API_TOKEN` as the bearer token for
  internal tool calls.
- Docker-backed personal runtime mode derives per-principal runtime tokens from
  `AGENT_RUNTIME_TOKEN_SECRET` with HMAC-SHA256.
- MCP gateway access uses RS256 runtime JWTs. Burble issues JWTs with runtime,
  workspace, Slack user, issuer, audience, and expiry claims, and verifies the
  claims against the runtime registry before serving MCP tools.
- Provider tool calls reject runtime requests when the provider connection does
  not belong to the runtime's Slack user.

## Data Storage

The default data store is SQLite using Bun's `bun:sqlite`.

Configured path:

```text
DATABASE_PATH
```

Default local path:

```text
burble.db
```

Docker Compose path:

```text
/data/burble.db
```

Primary tables:

- `users`: legacy GitHub connection records by email.
- `provider_connections`: GitHub, Jira, Google, and Slack user OAuth tokens.
- `oauth_state`: short-lived OAuth state records.
- `agent_runtimes`: runtime registry and lifecycle status.
- `agent_runtime_events`: runtime provisioning, run, and tool-call audit events.
- `conversation_routes`: active Slack route metadata for runtime responses.

Security note: provider access and refresh tokens are currently stored as
SQLite text values. Production deployments should place the database on
encrypted storage, restrict filesystem access to the service identity, and
prefer envelope encryption or a managed secret store before broad rollout.

## External Integrations

### Slack

Purpose:

- Primary user interface.
- App mentions, app DMs, and slash commands.
- Bot replies, ephemeral auth prompts, and optional user-token message search.

Required bot scopes:

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

Scheduled-output destination grants:

- `/agent grant here` authorizes a Slack channel for scheduled job output only after Burble verifies that the bot is already a channel member.
- `/agent ungrant here` revokes active scheduled-output grants for the channel. Revocation is channel-level cleanup, so any channel member can remove the channel's grants.

Optional user OAuth scopes for Slack search:

- `search:read`
- `users:read`

Required events:

- `app_mention`
- `message.im`

Required commands:

- `/auth`
- `/help`
- `/agent`
- `/agent-status`
- `/agent-config`

### GitHub

Purpose:

- Per-user GitHub OAuth.
- Authenticated user lookup.
- Assigned issue listing.
- Pull request listing.
- Issue search.

Required configuration:

- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- OAuth callback: `{BASE_URL}/oauth/github/callback`

### Atlassian Jira

Purpose:

- Per-user Atlassian OAuth 2.0 3LO.
- Jira user lookup.
- Assigned issue listing.
- Project and user search.
- Jira issue create/edit.
- Optional Atlassian MCP facade through Burble.

Required configuration when enabled:

- `JIRA_CLIENT_ID`
- `JIRA_CLIENT_SECRET`
- OAuth callback: `{BASE_URL}/oauth/jira/callback`
- `ATLASSIAN_MCP_URL`, default `https://mcp.atlassian.com/v1/mcp`

Jira scopes documented in this repository:

```text
read:jira-user read:jira-work write:jira-work offline_access
```

### Google Workspace

Purpose:

- Per-user Google OAuth.
- Drive metadata search.
- Calendar read/search.
- Gmail read/search.

Required configuration when enabled:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- OAuth callback: `{BASE_URL}/oauth/google/callback`

Required APIs:

- Google Drive API
- Google Calendar API
- Gmail API

Scopes documented in this repository:

```text
openid email profile
https://www.googleapis.com/auth/drive.metadata.readonly
https://www.googleapis.com/auth/calendar.readonly
https://www.googleapis.com/auth/gmail.readonly
```

### LLM Providers

Purpose:

- LLM-backed conversation planning and answer generation in `AGENT_MODE=llm`.

Model selector:

```text
AI_MODEL=provider:model
```

Supported provider prefixes:

- `openai`
- `anthropic`
- `ollama`

Provider secrets and endpoints:

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `OLLAMA_API_KEY`
- `OLLAMA_BASE_URL`, default `https://ollama.com`
- `OLLAMA_OPENAI_BASE_URL`, optional OpenAI-compatible Ollama endpoint

## Agent Runtime Options

### Deterministic Mode

```text
AGENT_MODE=deterministic
```

Burble handles supported intents directly without an LLM runtime. This is the
lowest-complexity deployment mode and is useful for constrained pilots.

### In-Process AI SDK Runner

```text
AGENT_MODE=llm
AGENT_RUNTIME=ai-sdk
AI_MODEL=openai:gpt-5.4
```

Burble runs the LLM tool loop in the app process using the configured provider
key. This keeps deployment simple but shares app CPU, memory, network, and
failure domain with agent execution.

### Shared Burble Runtime Service

```text
AGENT_MODE=llm
AGENT_RUNTIME=burble-runtime
AGENT_RUNTIME_FACTORY=static
OPENCLAW_NEMOCLAW_URL=http://openclaw-nemoclaw:8080
INTERNAL_API_TOKEN=<long-random-secret>
```

Burble sends runs to a runtime service on the private container network. The
runtime calls Burble's internal tool gateway with `INTERNAL_API_TOKEN`.

Supported runtime engines:

- `deterministic`: deployable bridge over the Burble tool gateway.
- `openclaw`: invokes an OpenClaw CLI binary inside the runtime container.
- `openclaw-gateway`: starts a private OpenClaw Gateway process.
- `burble-native`: runs Burble's native runtime contract worker without the
  OpenClaw agent process.

### Docker-Backed Personal Runtimes

```text
AGENT_MODE=llm
AGENT_RUNTIME=burble-runtime
AGENT_RUNTIME_FACTORY=docker
AGENT_RUNTIME_TOKEN_SECRET=<long-random-secret>
AGENT_RUNTIME_DATA_ROOT=/opt/burble/runtimes
```

Burble starts one runtime container per Slack principal. Each runtime gets its
own state, config, workspace path, runtime token, and optional runtime JWT.
This mode requires Docker access from the Burble container and mounts:

```text
/var/run/docker.sock:/var/run/docker.sock
${AGENT_RUNTIME_DATA_ROOT}:${AGENT_RUNTIME_DATA_ROOT}
```

Security note: mounting the Docker socket grants broad host/container control.
For production, prefer a constrained runtime orchestrator, Kubernetes with
service accounts and network policies, ECS/Fargate, or another scheduler
instead of exposing the raw Docker socket to the app container.

## Backend Requirements

Runtime:

- Bun 1.2.x.
- TypeScript source executed by Bun.
- SQLite support through `bun:sqlite`.
- Outbound HTTPS access to configured SaaS and model providers.
- Persistent writable data directory for SQLite, runtime JWT private key, and
  optional runtime state.

Container image:

- Base image: `oven/bun:1.2.21-alpine`.
- Exposes port `3000`.
- Installs `docker-cli` so Docker-backed runtime provisioning can be enabled.

Minimum environment:

```text
BASE_URL
SLACK_BOT_TOKEN
SLACK_APP_TOKEN
GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET
```

Common optional environment:

```text
PORT
DATABASE_PATH
SLACK_LOG_LEVEL
SLACK_CLIENT_ID
SLACK_CLIENT_SECRET
SLACK_REDIRECT_URI
JIRA_CLIENT_ID
JIRA_CLIENT_SECRET
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
AGENT_MODE
AGENT_RUNTIME
AGENT_RUNTIME_FACTORY
AI_MODEL
OPENCLAW_NEMOCLAW_URL
OPENCLAW_NEMOCLAW_ENGINE
OPENAI_API_KEY
ANTHROPIC_API_KEY
OLLAMA_API_KEY
OLLAMA_BASE_URL
INTERNAL_API_TOKEN
AGENT_RUNTIME_TOKEN_SECRET
AGENT_RUNTIME_MCP_GATEWAY_URL
AGENT_RUNTIME_MCP_AUDIENCE
RUNTIME_JWT_ISSUER
RUNTIME_JWT_PRIVATE_KEY_PATH
ATLASSIAN_MCP_URL
```

## Network Requirements

Inbound:

- Public HTTPS to the reverse proxy for OAuth callbacks and health checks.
- Public HTTP only if using ACME HTTP-01 certificate issuance or HTTP-to-HTTPS
  redirect.
- No inbound SSH is required in the provided AWS dev deployment; access is via
  AWS Systems Manager Session Manager.

Internal:

- Reverse proxy to `burble-app:3000`.
- Optional Burble-to-runtime HTTP access on the private container network.
- Optional runtime-to-Burble HTTP access to `/internal/tools` and `/mcp`.

Outbound:

- Slack APIs and Socket Mode.
- GitHub OAuth and REST APIs.
- Atlassian OAuth, Jira APIs, and optional Atlassian MCP.
- Google OAuth and Workspace APIs.
- Selected model provider API.
- ACME certificate endpoints when using Caddy.
- OS/package registries during image or host provisioning.

## Deployment Options

### Local Development

Use Bun directly:

```bash
bun install
bun run dev
```

Expose callbacks through a tunnel and set:

```text
BASE_URL=<public tunnel URL>
```

### Docker Compose Single Host

The default dev Compose stack runs:

- `caddy` for HTTPS termination and reverse proxy.
- `burble-app` for the Bun backend.
- Docker volumes for Caddy state and `/data/burble.db`.

Compose blocks public access to `/internal/*` and `/mcp*` through Caddy.

### Docker Compose With Shared Runtime

Add `docker-compose.openclaw-nemoclaw.yml` to run a shared private runtime
service beside Burble. This is suitable for controlled pilots where runtime
multi-tenancy is acceptable or the runtime engine is deterministic.

### Docker Compose With Personal Runtimes

Add `docker-compose.personal-runtimes.yml` to let Burble start one runtime
container per user. This improves runtime state isolation but requires Docker
socket access and should be treated as a development or controlled PoC pattern.

### AWS Dev Deployment

The checked-in Terraform and Ansible assets provision a single AWS EC2 host:

- Ubuntu 24.04 ARM64 instance, default `t4g.small`.
- Elastic IP and `nip.io` hostname.
- Security group allowing `80/tcp` and `443/tcp` from the internet.
- No SSH ingress.
- AWS SSM IAM role for shell access.
- Private S3 bucket for Ansible SSM file transfer.
- Encrypted gp3 root volume.
- Docker Compose stack with Caddy and Burble.

This is explicitly a dev deployment topology. For production, split control
plane, state, runtime orchestration, secret management, and observability into
managed services appropriate to the organization's platform.

## Security Controls Present

- Slack Socket Mode reduces public inbound Slack request surface.
- Caddy terminates TLS and blocks internal gateway paths from public access.
- OAuth state is single-use and expires.
- Provider access is scoped per connected Slack user.
- Runtime calls are authenticated with internal tokens or runtime JWTs.
- Runtime JWTs use RS256 and include issuer, audience, expiry, runtime,
  workspace, and Slack user claims.
- Runtime/provider principal mismatches are rejected.
- Agent runtimes receive connection summaries rather than raw provider OAuth
  tokens.
- Logs redact common provider tokens in several runtime/debug paths.

## Production Hardening Recommendations

- Encrypt provider tokens at the application layer or store them in a managed
  secrets system instead of plaintext SQLite columns.
- Use managed database backups and restore testing for the token/runtime store.
- Restrict egress to approved SaaS and model-provider endpoints.
- Replace Docker socket-based runtime creation with a constrained orchestrator
  for production multi-user deployments.
- Add centralized structured logging, metrics, alerting, and audit export.
- Define retention for `agent_runtime_events`, runtime logs, raw stream debug
  files, and Slack-derived context.
- Keep OpenClaw raw stream and debug payload logging disabled by default.
- Use least-privilege OAuth scopes per customer deployment.
- Rotate Slack, OAuth client, internal API, runtime, and model-provider secrets.
- Run containers as non-root where practical and add resource limits.
- Add network policies so runtimes can reach only Burble gateways and approved
  model/provider endpoints.
- Review Jira write tools and Atlassian MCP allowed-tool policy before enabling
  write access in production.

## Operational Checks

Health check:

```text
GET /healthz -> ok
```

Recommended smoke checks after deployment:

- Slack app starts and receives Socket Mode events.
- `/auth` returns provider connection status.
- GitHub OAuth callback stores a connection and can call authenticated GitHub
  tools.
- Optional Jira, Google, and Slack search OAuth flows complete.
- `AGENT_MODE=llm` returns a response with the selected runtime mode.
- Internal paths `/internal/*` and `/mcp*` return `404` from the public HTTPS
  endpoint when deployed behind the provided Caddy config.
- SQLite database and runtime JWT private key persist across container restart.
