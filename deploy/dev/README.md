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
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
```

Bring it up:

```bash
docker compose up -d --build
docker compose logs -f
```

Verify:

```bash
curl -fsSL https://<nip_io_domain>/healthz
# ok
```

## Authn Demo

Add Slack scope `app_mentions:read`. Then enable **Event Subscriptions** and
subscribe the bot to `app_mention`. With Socket Mode enabled, Slack does not
need a Request URL. Reinstall the app and invite Burble to a test channel.

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

`/github-me` proves the stored GitHub token maps to the Slack user identity,
even when the account has no assigned GitHub issues.
