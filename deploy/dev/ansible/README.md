# Ansible deployment

Automates the host-side deployment: clone/update the Burble repo, render
`deploy/dev/compose/.env`, run `docker compose up --build`, and verify
`/healthz` through Caddy.

Connection goes through AWS SSM. There is no SSH key and no port 22.

## Prerequisites

- Python 3 + `boto3`
- `ansible` >= 2.16
- AWS CLI configured for the dev AWS account
- `session-manager-plugin`
- Ansible collections:

```bash
ansible-galaxy collection install community.aws community.docker
```

## Setup

After `terraform apply`, fill in:

```bash
$EDITOR group_vars/all.yml
cp group_vars/secrets.yml.example group_vars/secrets.yml
$EDITOR group_vars/secrets.yml
```

Use Terraform outputs for:

- `instance_id`
- `ssm_transfer_bucket`
- `domain` (`nip_io_domain`)

Set `burble_repo_url` to this repo's Git remote.

## Deploy

```bash
export AWS_PROFILE=<profile>
export OBJC_DISABLE_INITIALIZE_FORK_SAFETY=YES
ansible-playbook playbook.yml
```

Re-run the playbook after changing the repo ref or secrets.
