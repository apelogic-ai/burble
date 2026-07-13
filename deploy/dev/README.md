# Burble — dev deployment on AWS

A single-instance dev environment for the Slack/GitHub authn PoC. The host
runs Docker Compose, Caddy terminates HTTPS, and `nip.io` maps the EC2 Elastic
IP to a browser-reachable hostname without a DNS-provider step.

```
GitHub OAuth callback
        │
        ▼
https://<elastic-ip>.nip.io
        │
        ▼ ports 80/443
┌──────────────────────────┐
│ EC2 t4g.small            │
│ ┌──────┐  ┌────────────┐ │
│ │caddy │→ │burble-app  │ │
│ └──────┘  └────────────┘ │
│ TLS        Bun + SQLite  │
└──────────────────────────┘
```

## Layout

- `terraform/` — EC2, EIP, SSM IAM role, security group, and a private S3
  bucket used by Ansible's SSM connection plugin for file transfer.
- `compose/` — Caddy plus the Bun app.
- `ansible/` — optional host-side deployment automation over AWS SSM.

## Bootstrap

```bash
cd deploy/dev/terraform
cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars
terraform init
terraform apply
```

Terraform outputs:

- `public_ip`
- `nip_io_domain`
- `github_oauth_callback_url`
- `instance_id`
- `ssm_transfer_bucket_name`

Set the GitHub OAuth app callback URL to:

```text
https://<nip_io_domain>/oauth/github/callback
```

## Manual Deploy

Open an SSM shell:

```bash
aws ssm start-session --target <instance_id>
sudo -u ubuntu -i
```

Clone this repo on the host:

```bash
git clone <repo-url> burble
cd burble/deploy/dev/compose
cp .env.example .env
vi .env
```

Set:

```env
DOMAIN=<nip_io_domain>
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_LOG_LEVEL=info
SLACK_CLIENT_ID=
SLACK_CLIENT_SECRET=
SLACK_REDIRECT_URI=
AGENT_MODE=deterministic
AGENT_FAST_TRACK=false
AGENT_RUNTIME=ai-sdk
AGENT_RUNTIME_FACTORY=static
AGENT_RUNTIME_ENGINE=
AGENT_RUNTIME_ALLOWED_ENGINES=
AGENT_RUNTIME_IMAGE=
AGENT_RUNTIME_TOKEN_SECRET=
AGENT_RUNTIME_MCP_GATEWAY_URL=
AGENT_RUNTIME_MCP_AUDIENCE=
AGENT_RUNTIME_STREAMING=native
AGENT_RUNTIME_SANDBOX_URL=
AGENT_RUNTIME_SANDBOX_TOKEN=
AGENT_RUNTIME_SANDBOX_TRANSPORT=cli
AGENT_RUNTIME_SANDBOX_START_COMMAND=
AGENT_RUNTIME_OPENSHELL_CLI_BIN=
AGENT_RUNTIME_OPENSHELL_DIAL_HOST=
OPENSHELL_IMAGE_TAG=latest
OPENSHELL_BIND_HOST=0.0.0.0
OPENSHELL_PORT=8080
OPENSHELL_HEALTH_PORT=8081
OPENSHELL_DATA_ROOT=/var/lib/openshell
TASK_WORKFLOW_SHADOW_ENABLED=false
TASK_WORKFLOW_SHADOW_DATABASE_PATH=
TASK_WORKFLOW_AUTHORITY=off
TASK_WORKFLOW_MAX_ATTEMPTS=2
SCHEDULED_RUN_AUDIT_RETENTION_DAYS=90
SCHEDULED_RUN_AUDIT_PRUNE_INTERVAL_MS=86400000
AI_MODEL=openai:gpt-5.4
OPENCLAW_NEMOCLAW_URL=
INTERNAL_API_TOKEN=
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
OLLAMA_API_KEY=
OLLAMA_BASE_URL=https://ollama.com
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
JIRA_CLIENT_ID=
JIRA_CLIENT_SECRET=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
```

Use `AGENT_MODE=llm` to route mentions and DMs through an agent runner.
`AGENT_FAST_TRACK=false` is the default: provider queries go through the agent
when one is configured. Set `AGENT_FAST_TRACK=true` only to re-enable Burble's
legacy deterministic provider shortcuts for simple GitHub/Jira/Gmail lookups.
`AGENT_RUNTIME=ai-sdk` is the default in-process runner. `AI_MODEL` is the
normalized model selector for both AI SDK and OpenClaw/NemoClaw runtimes. Use
`provider:model` format, for example `openai:gpt-5.4`,
`anthropic:claude-opus-4.6`, or `ollama:qwen3-coder:30b-cloud`, and set the
matching provider key before enabling it.

Workflow flags are explicitly passed through but default to observationally
off. Keep `TASK_WORKFLOW_AUTHORITY=off` until a deployment has passed the
workflow rollout smoke test. `TASK_WORKFLOW_SHADOW_ENABLED=true` records the
workflow shadow sidecar database; set `TASK_WORKFLOW_AUTHORITY=manual` only
when manual task runs should execute through the workflow driver. Audit
retention defaults to 90 days and prunes daily.

For Jira hand testing, create an Atlassian OAuth 2.0 3LO app, add:

```text
https://<DOMAIN>/oauth/jira/callback
```

Then grant scopes `read:jira-user read:jira-work write:jira-work offline_access` and set
`JIRA_CLIENT_ID` / `JIRA_CLIENT_SECRET` in `deploy/dev/compose/.env`.
`ATLASSIAN_MCP_URL` defaults to `https://mcp.atlassian.com/v1/mcp`; override it
only when testing a different Atlassian MCP endpoint.

For Google Workspace hand testing, create a Google Cloud OAuth web app, enable
the Drive, Calendar, and Gmail APIs, and add:

```text
https://<DOMAIN>/oauth/google/callback
```

Then set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in
`deploy/dev/compose/.env`. Users connect Google with `/auth google`.

For Slack search hand testing, add a Slack OAuth redirect URL:

```text
https://<DOMAIN>/oauth/slack/callback
```

Then grant user token scopes `search:read users:read` and set
`SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` in `deploy/dev/compose/.env`.
`SLACK_REDIRECT_URI` is optional and defaults to
`https://<DOMAIN>/oauth/slack/callback`; set it only if the Slack app uses a
different exact callback URL.
Users connect this token with `/auth slack`; normal bot delivery still uses
`SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`.

Bring it up:

```bash
docker compose up -d --build
docker compose logs -f
```

To run with the optional OpenClaw/NemoClaw runtime adapter, include the
override file. Compose builds the runtime image from
`runtimes/openclaw-nemoclaw` by default:

```env
AGENT_MODE=llm
AGENT_FAST_TRACK=false
AGENT_RUNTIME=burble-runtime
INTERNAL_API_TOKEN=<long-random-secret>
AGENT_RUNTIME_ENGINE=deterministic
```

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.openclaw-nemoclaw.yml \
  up -d --build
```

The override sets `OPENCLAW_NEMOCLAW_URL=http://openclaw-nemoclaw:8080` for
`burble-app`. Burble still owns Slack delivery, OAuth tokens, and visibility
policy; the remote runtime receives only sanitized connection summaries.

Set `OPENCLAW_NEMOCLAW_IMAGE=some-registry/image:tag` only if you want Compose
to tag/push/use a different image name. It is not required for dev deployment.
Use this naming split for runtime configuration:

- `AGENT_RUNTIME_*`: Burble-owned cross-engine runtime selection, lifecycle,
  networking, MCP, JWT, and mounted patch paths.
- `<ENGINE>_*`, for example `OPENCLAW_*` or `HERMES_*`: engine-native debug or
  implementation knobs passed through to that runtime.
- `OPENCLAW_NEMOCLAW_*`: legacy compatibility aliases. Prefer the
  `AGENT_RUNTIME_*` equivalents for new deployment config.

For new pluggable runtime images, prefer `AGENT_RUNTIME_IMAGE` and
`AGENT_RUNTIME_ENGINE`. Use `AGENT_RUNTIME_CONFIG_PATCH_HOST_PATH` for runtime
config patch mounts; `OPENCLAW_CONFIG_PATCH_HOST_PATH` remains as a legacy
fallback.

For example, the experimental Hermes-compatible image exposes the same Burble
runtime HTTP contract and can be selected with:

```env
AGENT_RUNTIME_IMAGE=burble-nemo-hermes:dev
AGENT_RUNTIME_ENGINE=hermes
```

Build that image locally with:

```bash
docker build -f ../../runtimes/nemo-hermes/Dockerfile \
  -t burble-nemo-hermes:dev \
  ../..
```

This is not a `hermes chat -q` wrapper. The image starts Hermes gateway with a
Burble platform adapter so inbound turns, normal replies, and cron/background
delivery flow through Burble route IDs. Burble still owns provider OAuth, MCP
policy, and final Slack transport delivery.

## OpenShell Sandbox Factory

The sandbox runtime factory replaces Burble's local Docker personal-runtime
factory with an OpenShell-compatible control plane. Burble keeps Slack/OAuth,
tool-gateway policy, runtime tokens, and model/tool context. OpenShell owns
the sandbox lifecycle: create a sandbox for a workspace/user/runtime, apply the
compiled filesystem/network/resource policy, bind credentials, start the
selected runtime image, and return the runtime contract endpoint.

Use one OpenShell service for the compose stack. It is a shared control plane,
not one service per runtime. Each agent principal still gets its own sandbox
behind that control plane.

For an externally managed OpenShell provider, set:

```env
AGENT_MODE=llm
AGENT_RUNTIME=burble-runtime
AGENT_RUNTIME_FACTORY=sandbox
AGENT_RUNTIME_SANDBOX_URL=http://<openshell-host>:<port>
AGENT_RUNTIME_SANDBOX_TOKEN=<shared-provider-token-if-required>
AGENT_RUNTIME_SANDBOX_TRANSPORT=cli
```

`AGENT_RUNTIME_ENGINE` and `AGENT_RUNTIME_IMAGE` keep their normal dynamic
selection behavior. The sandbox start command defaults from the selected engine:
Hermes uses `["python","/runtime/entrypoint.py"]`; Bun-based runtimes use
`["bun","src/index.ts"]`. Set `AGENT_RUNTIME_SANDBOX_START_COMMAND` only for a
custom runtime image whose entrypoint differs.

For a compose-managed OpenShell gateway, leave `AGENT_RUNTIME_SANDBOX_URL`
empty. The override starts `ghcr.io/nvidia/openshell/gateway` with OpenShell's
Docker compute driver, mounts the host Docker socket, and points Burble at
`http://openshell:8080` inside the compose network. The deploy script also
downloads the matching Linux OpenShell CLI into `deploy/dev/compose/.cache` and
mounts it into the app container for create-time workload launch:

```env
AGENT_MODE=llm
AGENT_RUNTIME=burble-runtime
AGENT_RUNTIME_FACTORY=sandbox
AGENT_RUNTIME_SANDBOX_URL=
AGENT_RUNTIME_SANDBOX_TOKEN=<long-random-secret>
AGENT_RUNTIME_SANDBOX_TRANSPORT=cli
OPENSHELL_IMAGE_TAG=latest
OPENSHELL_BIND_HOST=0.0.0.0
OPENSHELL_PORT=8080
OPENSHELL_HEALTH_PORT=8081
OPENSHELL_DATA_ROOT=/var/lib/openshell
```

`OPENSHELL_BIND_HOST=0.0.0.0` is intentional for the Docker-driver testbed:
OpenShell-created sandbox containers must connect back to the gateway through
the Docker host bridge to fetch policy. Keep port 8080/8081 closed in the EC2
security group unless you intentionally expose OpenShell outside the host.

`OPENSHELL_DATA_ROOT` must be an absolute host path that is also visible at the
same path inside the OpenShell gateway container; the Docker driver bind-mounts
its supervisor binary into sandbox containers through the host Docker daemon.
The default `/var/lib/openshell` is recommended for the AWS compose testbed.

Deploy it from `deploy/dev/compose` with:

```bash
./deploy-personal-runtimes.sh --agentgateway --openshell
```

The script still builds the selected runtime image locally, because same-host
OpenShell Docker-driver testbeds need the runtime image available to the
gateway. If the OpenShell service is remote, publish the runtime image to a
registry and set `AGENT_RUNTIME_IMAGE` to that pullable image instead.

The runtime supports these internal engines:

```env
AGENT_RUNTIME_ENGINE=deterministic
```

This is the default deployable bridge. It calls the Burble tool gateway and
formats the answer itself.

```env
AGENT_RUNTIME_ENGINE=openclaw
OPENCLAW_COMMAND=openclaw
OPENCLAW_AGENT=main
OPENCLAW_TIMEOUT_MS=60000
OPENCLAW_STATE_DIR=/data/openclaw/state
OPENCLAW_CONFIG_PATH=/data/openclaw/config/openclaw.json
OPENCLAW_WORKSPACE_DIR=/data/openclaw/workspace
OPENCLAW_SETUP_ON_START=true
OPENCLAW_CONFIG_PATCH_PATH=/etc/openclaw/patches/openai.json5
OPENCLAW_VALIDATE_ON_START=true
OPENCLAW_STREAM_DEBUG=false
OPENCLAW_LOG_LEVEL=
OPENCLAW_DIAGNOSTICS=
OPENCLAW_DEBUG_MODEL_TRANSPORT=
OPENCLAW_DEBUG_MODEL_PAYLOAD=
OPENCLAW_DEBUG_SSE=
OPENCLAW_DEBUG_CODE_MODE=
OPENCLAW_FAST_MODE=false
OPENCLAW_RAW_STREAM_DEBUG=false
OPENCLAW_GATEWAY_PORT=18789
OPENCLAW_GATEWAY_BIND=loopback
OPENCLAW_GATEWAY_TOKEN=
OPENAI_API_KEY=sk-...
```

This calls an OpenClaw CLI binary from inside the runtime container using
gateway-derived context. On startup the runtime runs
`openclaw onboard --non-interactive --accept-risk --flow quickstart --mode local
--auth-choice skip --skip-daemon --skip-channels --skip-skills --skip-search
--skip-health --workspace "${OPENCLAW_WORKSPACE_DIR}" --json` with persistent
state/config paths under the `openclaw_nemoclaw_data` Docker volume.
If `OPENCLAW_CONFIG_PATCH_PATH` points to a JSON5 patch file inside the
container, startup applies it with `openclaw config patch --file` and validates
the resulting config. The runtime then generates and applies a provider patch
from `AI_MODEL`, so provider/model swaps do not require editing JSON5. The
checked-in `compose/openclaw-patches/openai.json5` patch remains available for
extra OpenClaw defaults; the generated `AI_MODEL` patch is applied after it so
the selected provider wins. Provider secrets are still supplied only through env
vars such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `OLLAMA_API_KEY`.
Set `OPENCLAW_STREAM_DEBUG=true` temporarily to log OpenClaw stdout chunk
timing, parsed delta counts, and redacted previews while debugging streaming.
For deeper OpenClaw internals, set `OPENCLAW_LOG_LEVEL=debug` or `trace` and
enable targeted diagnostics such as `OPENCLAW_DEBUG_MODEL_TRANSPORT=true`,
`OPENCLAW_DEBUG_MODEL_PAYLOAD=summary`, and `OPENCLAW_DEBUG_SSE=events`.
Use `OPENCLAW_DEBUG_CODE_MODE=true` if OpenClaw's code-mode tool surface is
involved.
OpenClaw code mode is disabled by default for Burble runtimes because simple
channel and cron turns should use direct OpenClaw tools instead of the
`exec`/`wait` orchestration surface. Set `OPENCLAW_CODE_MODE=true` to opt back
into code mode for broader tool-catalog or coding-style experiments.
Set `OPENCLAW_FAST_MODE=true` to apply Burble's tightened OpenClaw defaults:
`thinkingDefault=minimal`, `reasoningDefault=off`, `fastModeDefault=true`, and
startup-only reductions for pricing catalog and shell-env import. This improves
simple/model-only turns while leaving tool-heavy/search-heavy turns dependent on
provider and tool behavior.
Set `OPENCLAW_RAW_STREAM_DEBUG=true` temporarily to ask OpenClaw for per-run
raw stream JSONL under `/data/openclaw/state/raw-streams`; Burble parses those
files for token usage and logs only the summarized counts.
Use `AGENT_RUNTIME_ENGINE=openclaw-gateway` only when you want the real
OpenClaw Gateway agent path. In that mode the runtime starts a private
`openclaw gateway run` process once at boot using `OPENCLAW_GATEWAY_PORT`,
`OPENCLAW_GATEWAY_BIND`, and token auth. Leave `OPENCLAW_GATEWAY_TOKEN` empty
to generate an ephemeral per-process token.
The patch writes OpenClaw file logs to `/data/openclaw/logs/openclaw.log` inside
the runtime container.
To build the repo-provided image with the OpenClaw CLI installed, add the CLI
override:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.openclaw-nemoclaw.yml \
  -f docker-compose.openclaw-cli.yml \
  up -d --build
```

Optional version pin:

```env
OPENCLAW_VERSION=2026.6.11
```

The CLI image installs the `openclaw` npm package during Docker build. If that
build fails, switch back to `AGENT_RUNTIME_ENGINE=deterministic` and deploy
with only the first two compose files.

For the Docker-backed personal runtime path, the compose directory includes a
convenience helper:

```bash
./deploy-personal-runtimes.sh
```

It runs `git pull --ff-only`, rebuilds the Burble app and personal runtime
image, restarts Compose, and removes existing `burble-rt-*` containers so the
next DM provisions a runtime with the latest image and environment. Use
`--no-pull` or `--keep-runtimes` when you want to skip those steps.

Add `--agentgateway` when testing the MCP path:

```bash
./deploy-personal-runtimes.sh --agentgateway
```

For the OpenShell-backed sandbox runtime path, use the same helper but select
the sandbox factory in `.env` or on the command line. In sandbox mode the helper
still builds the selected runtime image for same-host OpenShell testbeds, but it
starts `burble-app` without the Docker personal-runtime compose override:

```env
AGENT_MODE=llm
AGENT_RUNTIME=burble-runtime
AGENT_RUNTIME_FACTORY=sandbox
AGENT_RUNTIME_TOKEN_SECRET=<long-random-secret>
AGENT_RUNTIME_SANDBOX_URL=http://<openshell-host>:<port>
AGENT_RUNTIME_SANDBOX_TOKEN=<openshell-token>
AGENT_RUNTIME_SANDBOX_TRANSPORT=cli
```

```bash
AGENT_RUNTIME=burble-runtime \
AGENT_RUNTIME_FACTORY=sandbox \
./deploy-personal-runtimes.sh --agentgateway --openshell
```

Use `AGENT_RUNTIME_ENGINE=openclaw` with
`AGENT_RUNTIME_IMAGE=burble-openclaw-nemoclaw-openclaw-cli:dev` for the
OpenClaw runtime image, or `AGENT_RUNTIME_ENGINE=burble-native` with
`AGENT_RUNTIME_IMAGE=burble-native-runtime:dev` for the native runtime.
For default Burble runtime images, the sandbox start command is selected from
the engine automatically. Override `AGENT_RUNTIME_SANDBOX_START_COMMAND` only
for custom runtime images.

### Burble Native hand test

This makes Burble Native the default while keeping existing OpenClaw Gateway
scheduled jobs admissible. Scheduled jobs retain the runtime engine stored when
they were created; new jobs use the user's effective runtime engine.

Set these values in `deploy/dev/compose/.env`:

```env
AGENT_MODE=llm
AGENT_RUNTIME=burble-runtime
AGENT_RUNTIME_FACTORY=sandbox
AGENT_RUNTIME_ENGINE=burble-native
AGENT_RUNTIME_ALLOWED_ENGINES=openclaw-gateway,burble-native
AGENT_RUNTIME_IMAGE=burble-native-runtime:dev
```

Keep `LLM_GW_BASE_URL` pointed at the same-host LiteLLM endpoint, then deploy
through the normal OpenShell path:

```bash
./deploy-personal-runtimes.sh --agentgateway --openshell
```

In Slack App Home, select `burble-native` if the user already has a different
stored runtime preference. Run `/agent status` and confirm the effective engine
is `burble-native`. Then exercise the packaged model path, one provider call,
and attachment fetch with these messages:

```text
Reply exactly: Burble Native is running.
Use GitHub tools and tell me my authenticated GitHub login.
Summarize the attached text file in one sentence.
```

The first request must complete without a tool. The second must show one GitHub
tool completion before the final answer. Attach a small text file to the third;
it must show `conversation get Attachment` before the summary. On the host,
confirm the runtime engine and image:

```bash
docker ps --filter name=openshell-b- --format '{{.Names}} {{.Image}}'
docker compose logs --since=10m burble-app llm-gw
```

#### Rollback to OpenClaw

Restore these `.env` values and run the same deployment helper:

```env
AGENT_RUNTIME_ENGINE=openclaw-gateway
AGENT_RUNTIME_ALLOWED_ENGINES=openclaw-gateway,burble-native
AGENT_RUNTIME_IMAGE=burble-openclaw-nemoclaw:dev
```

```bash
./deploy-personal-runtimes.sh --agentgateway --openshell
```

After connecting Jira, a hand-test for the upstream MCP path is:

```text
list Atlassian MCP tools
```

That should route through `agentgateway`, Burble's MCP facade, and the upstream
Atlassian MCP endpoint using the connected Jira identity.

After the tool list returns, you can hand-test an allowed upstream tool call
with the exact tool name and JSON arguments:

```text
call Atlassian MCP tool searchJiraIssuesUsingJql with {"jql":"assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC"}
```

Read-style upstream tool names and selected Jira write tools are allowed at this
stage. Burble currently allows `createJiraIssue`, `editJiraIssue`,
`transitionJiraIssue`, `addCommentToJiraIssue`, and `addWorklogToJiraIssue`.
Other mutating tool names are blocked before reaching Atlassian.

`/internal/*` is blocked by Caddy on the public HTTPS hostname. The
OpenClaw/NemoClaw service calls `http://burble-app:3000/internal/tools` over
the Docker network with `BURBLE_INTERNAL_TOKEN`.

You can smoke-test the gateway from the instance after GitHub auth is connected:

```bash
docker compose exec burble-app bun -e 'fetch("http://localhost:3000/internal/tools/github.getAuthenticatedUser/execute", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${process.env.INTERNAL_API_TOKEN}` }, body: JSON.stringify({ user: { email: "you@example.com" } }) }).then(r => r.text()).then(console.log)'
```

The public endpoint should not expose it:

```bash
curl -i https://<nip_io_domain>/internal/tools/github.getAuthenticatedUser/execute
# HTTP 404
```

Verify:

```bash
curl -fsSL https://<nip_io_domain>/healthz
# ok
```

## Authn Demo

Add Slack scopes:

- `app_mentions:read`
- `channels:history`
- `channels:read`
- `groups:history`
- `groups:read`
- `im:history`
- `search:read` as a user token scope for `/auth slack`
- `users:read` as both a bot token scope and a user token scope for `/auth slack`

Add Slack slash commands:

- `/auth`
- `/help`
- `/agent`
- `/agent-status`
- `/agent-config`

Scheduled-output destination grants:

- Run `/agent grant here` in a channel to authorize that channel for scheduled job output. The bot must already be a channel member.
- Run `/agent ungrant here` in the channel to revoke active scheduled-output grants for that channel. Revocation is channel-level cleanup and can be performed by any channel member.

The checked-in manifest at `deploy/dev/slack-app-manifest.yaml` contains the
expected scopes, events, and slash commands. If a command is missing from the
Slack app config, Slack will not dispatch it to Burble at all; Burble logs will
not show a `Received Slack payload ... command=/agent-status` line.

Then enable **Event Subscriptions** and subscribe the bot to:

- `app_mention`
- `message.im`

In **App Home**, enable the messages tab and allow users to send messages to
the app. With Socket Mode enabled, Slack delivers commands and events over the
app-level websocket; any command/interactivity Request URL in the Slack UI or
manifest is only a placeholder. Reinstall the app after changing scopes,
events, or commands, then invite Burble to a test channel.

In Slack:

```text
@Burble connect github
@Burble who am I on GitHub?
@Burble what issues are assigned to me?
@Burble show my pull requests
@Burble search GitHub issues for billing
/auth
/auth github
/auth slack
/agent status
/agent config
/agent exec summarize my connected accounts
/agent-status
/agent-config
/help
```

After `/auth slack`, ask the app questions such as:

```text
what did I say about DM-12?
who mentioned onboarding crash loop?
```

In the Burble app DM:

```text
summarize my GitHub work
prioritize my open GitHub PRs
```

`/auth` shows connection status for supported provider accounts.
