# Open-Source Readiness Report

Date: 2026-05-28

Scope: read-only repository review for brand names, leaks, open-source hygiene,
and general sanity concerns.

## Repo State

- Branch: `codex/provider-tools-mcp`
- Branch is ahead by one local commit: `83eb609 Add Google Drive text file creation tool`
- Existing untracked local file: `docs/security-devops-architecture.md`
- Local ignored `.env` exists. Its contents were not inspected.

## High Priority

### Missing License

The repository has no `LICENSE` file, and packages are still marked private:

- `package.json`
- `runtimes/openclaw-nemoclaw/package.json`
- `runtimes/openclaw-nemoclaw/openclaw-plugins/burble-channel/package.json`

Before open-sourcing, choose a license, add `LICENSE`, and decide whether any
package should remain `"private": true`.

### Private Test Identity Data

Tests contained personal/company-specific fixtures such as private domains,
named users, and provider account IDs. The cleanup PR replaces these with
generic example values.

Main clusters found in:

- `tests/runtimes/openclaw-nemoclaw/openclaw-cli.test.ts`
- `tests/tools/jira-tools.test.ts`
- `tests/tool-gateway.test.ts`
- `tests/mcp/provider-server.test.ts`
- `tests/jira.test.ts`
- `tests/slack-api.test.ts`

Recommendation: replace with neutral fixtures such as `Example User`,
`person@example.com`, `example.atlassian.net`, and `acct-example`.

### Token Storage Is Dev-Grade

OAuth provider tokens are stored as SQLite text values in:

- `users.github_token`
- `provider_connections.access_token`
- `provider_connections.refresh_token`

This is documented in `docs/security-devops-architecture.md`, but the public
README should make the same production-readiness boundary clear. Before broad
use, prefer encrypted storage, envelope encryption, or a managed secret store.

## Medium Priority

### README Is Stale For Google Drive Write Support

`README.md` lists Google scopes for Drive metadata, Calendar, and Gmail, but
does not include:

```text
https://www.googleapis.com/auth/drive.file
```

It also describes Google as Drive/Calendar/Gmail search only, not Drive file
creation.

### Example Env Files Omit Google Client Settings

The root `.env.example` and `deploy/dev/compose/.env.example` do not currently
include:

```env
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
```

### Docker Context Hygiene

`.dockerignore` excludes secrets and DB files, but not `.git` or `.DS_Store`.
The current Dockerfiles copy explicit paths, so this is not immediately
dangerous, but it is better hygiene before public release.

### Dev Deployment Is Clearly Dev-Only

The Terraform dev stack opens HTTP and HTTPS to the world and allows all
outbound traffic. That is expected for the current EC2+Caddy OAuth callback
host, but the deploy tree should stay clearly labeled as dev-only.

Relevant file:

- `deploy/dev/terraform/main.tf`

### CI Contains A Branch-Specific Trigger

`.github/workflows/ci.yml` includes:

```yaml
- codex/agent-exec-command
```

Remove this before open-sourcing.

## Brand And Naming Surface

Observed brand/product names:

- Burble
- OpenClaw
- NemoClaw
- Slack
- GitHub
- Jira
- Atlassian
- Google
- OpenAI
- Anthropic
- Ollama
- Bun
- Caddy
- Docker
- Terraform
- AWS
- AgentGateway

Most are integration references and are expected. Review `OpenClaw` and
`NemoClaw` usage specifically because those names are embedded in runtime
package paths, docs, deploy files, and product language.

## No Obvious Tracked Secret Leak Found

No obvious real provider tokens, API keys, private keys, Slack IDs, or cloud
credentials were found in tracked files during the scan.

Expected placeholder values were present, for example:

- `xoxb-...`
- `xapp-...`
- `sk-...`
- `GITHUB_CLIENT_SECRET=...`

Ignored sensitive local files are covered by ignore rules:

- `.env`
- `deploy/dev/compose/.env`
- `deploy/dev/ansible/group_vars/secrets.yml`
- Terraform state files
- SQLite DB files

## General Sanity Notes

- README still frames the project as a PoC. Decide whether that is acceptable
  public positioning or whether the README should be rewritten as a project
  overview.
- `deploy/dev` is useful but exposes a lot of operational detail. It is safe
  enough if scrubbed and clearly marked dev-only.
- The security architecture document is useful for public review, but it is
  currently untracked and should be reviewed before adding.
- No profanity or obviously embarrassing debug language was found in tracked
  source/docs during the scan.

## Suggested Pre-Open-Source Checklist

1. Add a license.
2. Replace private/person-specific test fixtures.
3. Update README Google scopes and Drive write capability.
4. Add Google env placeholders to example env files.
5. Add `.git` and `.DS_Store` to `.dockerignore`.
6. Remove the branch-specific CI trigger.
7. Decide whether to publish or omit `deploy/dev`.
8. Decide whether to include `docs/security-devops-architecture.md`.
9. Run a final secret scan on tracked files and packed release artifacts.
