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
AGENT_MODE=deterministic
AGENT_RUNTIME=ai-sdk
AI_MODEL=openai:gpt-5.4
OPENCLAW_NEMOCLAW_URL=
INTERNAL_API_TOKEN=
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
```

Use `AGENT_MODE=llm` to route mentions and DMs through an agent runner.
`AGENT_RUNTIME=ai-sdk` is the default in-process runner. `AI_MODEL` uses
`provider:model` format and resolves through direct provider packages, so set
the matching provider key before enabling it.

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
AGENT_RUNTIME=openclaw-nemoclaw
INTERNAL_API_TOKEN=<long-random-secret>
OPENCLAW_NEMOCLAW_ENGINE=deterministic
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

The runtime supports two internal engines:

```env
OPENCLAW_NEMOCLAW_ENGINE=deterministic
```

This is the default deployable bridge. It calls the Burble tool gateway and
formats the answer itself.

```env
OPENCLAW_NEMOCLAW_ENGINE=openclaw-cli
OPENCLAW_COMMAND=openclaw
OPENCLAW_AGENT=main
OPENCLAW_TIMEOUT_MS=60000
OPENCLAW_STATE_DIR=/data/openclaw/state
OPENCLAW_CONFIG_PATH=/data/openclaw/config/openclaw.json
OPENCLAW_WORKSPACE_DIR=/data/openclaw/workspace
OPENCLAW_SETUP_ON_START=true
OPENCLAW_CONFIG_PATCH_PATH=/etc/openclaw/patches/openai.json5
OPENCLAW_VALIDATE_ON_START=true
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
the resulting config. Use that patch file for non-interactive OpenClaw
model/provider configuration. The checked-in
`compose/openclaw-patches/openai.json5` patch enables OpenAI with
`openai/gpt-5.5`; the API key is still supplied only through `OPENAI_API_KEY`.
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
OPENCLAW_VERSION=2026.5.19
```

The CLI image installs the `openclaw` npm package during Docker build. If that
build fails, switch back to `OPENCLAW_NEMOCLAW_ENGINE=deterministic` and deploy
with only the first two compose files.

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
- `im:history`

Then enable **Event Subscriptions** and subscribe the bot to:

- `app_mention`
- `message.im`

In **App Home**, enable the messages tab and allow users to send messages to
the app. With Socket Mode enabled, Slack does not need a Request URL. Reinstall
the app and invite Burble to a test channel.

In Slack:

```text
@Burble connect github
@Burble who am I on GitHub?
@Burble what issues are assigned to me?
@Burble show my pull requests
@Burble search GitHub issues for billing
/connect-github
/auth github
/github-me
```

In the Burble app DM:

```text
summarize my GitHub work
prioritize my open GitHub PRs
```

`/github-me` proves the stored GitHub token maps to the Slack user identity,
even when the account has no assigned GitHub issues.
