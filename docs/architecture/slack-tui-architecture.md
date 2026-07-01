# Slack-as-TUI: Enterprise Agent Architecture and PoC

A reference architecture for letting non-coding enterprise users query corporate
data conversationally through Slack, with per-user identity propagation,
semantic-layer authorization, and curated tool access. Includes a
minimum-viable integration PoC against GitHub.

## Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Authentication and authorization flow](#authentication-and-authorization-flow)
- [Trust boundaries](#trust-boundaries)
- [Proof of concept](#proof-of-concept)
- [Setup steps](#setup-steps)
- [The demo](#the-demo)
- [Next steps](#next-steps)

---

## Overview

The goal is to let enterprise users — sales, finance, support, not engineers —
query their corporate systems using natural language in Slack, while preserving
the identity, authorization, and audit guarantees that traditional SaaS UIs
provide through their own login flows.

Three observations frame the design:

1. **Slack is the only TUI that's already deployed.** Every enterprise has
   Slack open all day; nothing else competes for ambient access. Building a
   new web UI loses on adoption before it loses on anything else.
2. **Identity must propagate end-to-end.** "The agent has Salesforce
   credentials" is a category error — the *user* has Salesforce credentials,
   and the agent must act as them. Service accounts collapse the entire
   authorization model.
3. **Authorization belongs at the semantic layer, not after the fact.**
   Post-hoc masking of full result sets is the wrong shape; queries should
   be generated with field- and row-level filters baked in before they hit
   the vendor system.

---

## Architecture

The runtime separates into three concerns, color-coded above.

### Agent control plane (purple)

The Slack app, identity broker, agent worker pool, and session store. The
Slack app validates inbound events and resolves Slack identity to enterprise
IdP subject. The agent worker pool is stateless and pooled — sessions are
externalized to a store so workers handle many concurrent threads.

This is deliberately **not** 1:1 agent:VM. A micro-VM is a trust boundary for
untrusted code execution, not a session container. If the agent's tool surface
is "call db-mcp, call LLM gateway, post to Slack," there's no untrusted code
to isolate — paying VM startup latency and idle cost buys a security property
that isn't being used. Sandboxes enter per-tool-call, not per-session.

### Resource gateways (teal)

LLM gateway routes model calls with audit and PII handling. `db-mcp` is the
semantic data layer that owns vendor authentication, token exchange, and
authorization enforcement. The sandbox pool is conditional — only invoked
per-tool-call when an action requires arbitrary code execution. Most queries
never touch it; the dashed arrow in the diagram reflects this.

### Terminal resources (gray)

External systems the agent doesn't own: LLM providers (Anthropic, OpenAI,
self-hosted) and vendor systems (Salesforce, NetSuite, Jira, GitHub, the
warehouse). Trust at this boundary belongs to vendor-specific credentials
held by `db-mcp`, not anything in the agent runtime.

### Out of frame

- **OAuth connection dashboard** — separate web surface where users
  initiate first-time vendor OAuth flows. Writes refresh tokens into the
  connection store. Orthogonal to the runtime path.
- **Audit / observability** — every hop emits OpenTelemetry spans. Drawing
  these into the architecture diagram clutters it; they're a sidecar concern
  attached to every box.
- **Async job runner** — for long-running warehouse queries that outlive
  Slack's conversational rhythm. Sits next to the worker pool, takes over
  when a query is "go do this and DM me when done."

---

## Authentication and authorization flow

The credential chain has three distinct transformations.

**Event (signed).** Slack's HMAC over the request body. Proves the message
came from Slack — nothing more. The Slack `user_id` inside is local to Slack
and useless alone.

**JWT (5m TTL).** The enterprise identity assertion, signed by the IdP. Short
TTL bounds blast radius if it leaks. This is what propagates through the
agent runtime; every downstream call carries it.

**Vendor cred.** Minted via RFC 8693 token exchange against the user's
stored OAuth grant. Scoped to the specific intent of this query, not to the
user's full vendor permissions. Lives entirely inside `db-mcp`.

### The trust boundary that matters

The agent never sees vendor credentials. JWT goes in, query results come out.
All vendor token handling stays inside `db-mcp`. If the agent runtime is ever
compromised — prompt injection, a bad tool call, anything — the worst case is
JWT replay within 5 minutes against `db-mcp`'s existing authz checks. Not
"exfiltrate the Salesforce refresh token."

### What "Authz'd query" means

The final arrow in the diagram does the most work. It means: `db-mcp`'s
semantic layer generates the SQL or API call with field-level filters (mask
SSN unless role allows) and row-level filters (only records this user has
scope on) baked into the query before execution.

This is the architectural commitment. Post-hoc masking applied to a fat
result set is wrong — it leaks data into the agent runtime where prompt
injection can extract it, and it scales badly when the result set is large.

### Not in the diagram

- **HMAC verification** at the Slack app — precondition for everything else;
  a self-loop would have cluttered the picture.
- **First-time OAuth dance** — when a user has never connected a vendor,
  RFC 8693 has nothing to exchange. The dashboard flow runs once, writes the
  refresh token into the connection store, then this sequence works.
- **Refresh handling** — if the stored OAuth grant is stale, IdP refreshes
  it before minting the downscoped cred. Implicit in the "vendor cred" return.

---

## Trust boundaries

| Boundary | What crosses | What doesn't |
|---|---|---|
| Slack → Slack app | HMAC-signed event, Slack `user_id` | Anything else |
| Slack app → Agent | User-scoped JWT (5m TTL) | Slack signing secret, IdP refresh tokens |
| Agent → db-mcp | User-scoped JWT | Vendor credentials, raw vendor responses |
| db-mcp → Vendor | Downscoped vendor token (RFC 8693) | User's full OAuth grant, other users' tokens |
| Vendor → db-mcp | Raw query result | (vendor returns; nothing else exits) |
| db-mcp → Agent | Filtered result (field/row authz applied) | Unfiltered data, vendor credentials |

The horizontal line through the middle: nothing inside the agent runtime is
privileged with vendor credentials. Compromise of the agent does not equal
compromise of vendor data access beyond the active JWT.

---

## Proof of concept

The minimum integration that proves the shape works: Slack user identity →
user-specific vendor credential → identity-isolated query response.

### Scope

**Validates:**

- Slack user identity propagates correctly via workspace SSO (typically Google)
- Each user accesses vendor data with their own credentials, not a service account
- Identity isolation: two different users get different results from the same query
- OAuth grant revocation correctly breaks vendor access

**Deliberately not in scope** (engineering effort, not architectural risk):

- LLM-driven natural language (V0 uses slash commands; LLM is V1)
- Multiple vendor backends (start with GitHub; Jira, Salesforce later)
- High availability / pooling (single process)
- Production identity (uses Slack-provided email; no JWT minting yet)
- Async patterns, audit, sandboxing

### PoC architecture

```
[Slack workspace] ──Socket Mode events──┐
                                         │
                                         ↓
                                 [Bolt app (Python)]
                                   │             │
                                   │             │  OAuth callback
                                   │             ↓
                                   │       [Flask :3000]
                                   │             │
                                   │      (via ngrok tunnel)
                                   │             ↓
                                   │       [GitHub OAuth]
                                   ↓
                            [SQLite token store]
                                   │
                                   │  Bearer token per user
                                   ↓
                            [GitHub API]
```

A single Python process. Bolt connects to Slack via Socket Mode for events
(no public webhook needed). A small Flask server runs on port 3000 for the
GitHub OAuth callback, exposed via ngrok. SQLite stores per-user GitHub tokens
keyed by email.

---

## Setup steps

### 1. Slack app

At `api.slack.com/apps`:

1. **Create New App** → **From scratch**. Name it; pick your workspace.
2. **Socket Mode** → toggle **Enable Socket Mode**. When prompted, generate
   an app-level token with scope `connections:write`. Save it as
   `SLACK_APP_TOKEN` (starts with `xapp-`).
3. **OAuth & Permissions** → **Bot Token Scopes**, add:
   - `chat:write` — post messages
   - `commands` — receive slash commands
   - `users:read` — look up users
   - `users:read.email` — read email (critical: without this, identity
     resolution fails silently)
   - `im:write` — DM users
4. **Slash Commands** → create two:
   - `/connect-github` — "Connect your GitHub account"
   - `/issues` — "List my open GitHub issues"

   Request URL is unused in Socket Mode; leave blank or set to anything.
5. **Install App** → install to workspace. Copy the **Bot User OAuth Token**
   as `SLACK_BOT_TOKEN` (starts with `xoxb-`).

### 2. GitHub OAuth app

At `github.com/settings/developers`:

1. **OAuth Apps** → **New OAuth App**.
2. **Application name**: anything. **Homepage URL**: `http://localhost:3000`
   for now.
3. **Authorization callback URL**:
   `http://localhost:3000/oauth/github/callback` — will be updated once ngrok
   is running.
4. Register. Copy the **Client ID**. Generate a new client secret and save it.

Save as `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`.

### 3. Local environment

```bash
mkdir slack-tui-poc && cd slack-tui-poc
python3.11 -m venv .venv && source .venv/bin/activate
pip install slack-bolt requests flask python-dotenv
```

Create `.env`:

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
BASE_URL=https://your-ngrok-subdomain.ngrok.io
```

In a separate terminal:

```bash
ngrok http 3000
```

Note the HTTPS URL. Update:

- `BASE_URL` in `.env`
- GitHub OAuth app's Authorization callback URL to
  `{BASE_URL}/oauth/github/callback`

### 4. Database schema

```python
# db.py
import sqlite3

def init_db():
    conn = sqlite3.connect('tokens.db', check_same_thread=False)
    conn.executescript('''
        CREATE TABLE IF NOT EXISTS users (
            email TEXT PRIMARY KEY,
            github_login TEXT,
            github_token TEXT,
            connected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS oauth_state (
            state TEXT PRIMARY KEY,
            slack_user_id TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    ''')
    conn.commit()
    return conn
```

`check_same_thread=False` is required because Flask runs in a separate thread
from the Bolt Socket Mode handler.

### 5. The app

```python
# app.py
import os, secrets, threading
import requests
from dotenv import load_dotenv
from flask import Flask, request
from slack_bolt import App
from slack_bolt.adapter.socket_mode import SocketModeHandler
from db import init_db

load_dotenv()
conn = init_db()

app = App(token=os.environ['SLACK_BOT_TOKEN'])
flask_app = Flask(__name__)


def get_slack_email(client, user_id):
    info = client.users_info(user=user_id)
    return info['user']['profile'].get('email')


@app.command('/connect-github')
def connect_github(ack, body, client):
    ack()
    user_id = body['user_id']
    state = secrets.token_urlsafe(32)
    conn.execute(
        'INSERT INTO oauth_state (state, slack_user_id) VALUES (?, ?)',
        (state, user_id)
    )
    conn.commit()
    url = (
        f"https://github.com/login/oauth/authorize"
        f"?client_id={os.environ['GITHUB_CLIENT_ID']}"
        f"&state={state}"
        f"&scope=repo+read:user+user:email"
        f"&redirect_uri={os.environ['BASE_URL']}/oauth/github/callback"
    )
    client.chat_postMessage(
        channel=user_id,
        text=f"<{url}|Click here to connect GitHub>"
    )


@app.command('/issues')
def issues(ack, body, client):
    ack()
    user_id = body['user_id']
    channel_id = body['channel_id']
    email = get_slack_email(client, user_id)

    row = conn.execute(
        'SELECT github_token FROM users WHERE email = ?', (email,)
    ).fetchone()
    if not row:
        client.chat_postMessage(
            channel=channel_id,
            text="Run /connect-github first."
        )
        return

    token = row[0]
    r = requests.get(
        'https://api.github.com/search/issues',
        params={'q': 'is:open is:issue assignee:@me'},
        headers={'Authorization': f'Bearer {token}'}
    )

    if r.status_code == 401:
        client.chat_postMessage(
            channel=channel_id,
            text="GitHub token rejected. Run /connect-github to reconnect."
        )
        return

    items = r.json().get('items', [])
    if not items:
        text = "No open issues assigned to you."
    else:
        text = "\n".join(
            f"• <{i['html_url']}|{i['title']}>" for i in items[:10]
        )

    client.chat_postMessage(channel=channel_id, text=text)


@flask_app.route('/oauth/github/callback')
def oauth_callback():
    code = request.args.get('code')
    state = request.args.get('state')

    row = conn.execute(
        'SELECT slack_user_id FROM oauth_state WHERE state = ?', (state,)
    ).fetchone()
    if not row:
        return "Invalid state", 400
    slack_user_id = row[0]
    conn.execute('DELETE FROM oauth_state WHERE state = ?', (state,))

    # Exchange code for token
    r = requests.post(
        'https://github.com/login/oauth/access_token',
        data={
            'client_id': os.environ['GITHUB_CLIENT_ID'],
            'client_secret': os.environ['GITHUB_CLIENT_SECRET'],
            'code': code,
            'state': state,
        },
        headers={'Accept': 'application/json'}
    )
    token = r.json().get('access_token')
    if not token:
        return "Token exchange failed", 400

    gh_user = requests.get(
        'https://api.github.com/user',
        headers={'Authorization': f'Bearer {token}'}
    ).json()
    github_login = gh_user['login']

    email = get_slack_email(app.client, slack_user_id)

    conn.execute('''
        INSERT INTO users (email, github_login, github_token)
        VALUES (?, ?, ?)
        ON CONFLICT(email) DO UPDATE SET
            github_login = excluded.github_login,
            github_token = excluded.github_token,
            connected_at = CURRENT_TIMESTAMP
    ''', (email, github_login, token))
    conn.commit()

    app.client.chat_postMessage(
        channel=slack_user_id,
        text=f"✓ Connected as `{github_login}` ({email})"
    )

    return "Connected. You can close this tab."


def run_flask():
    flask_app.run(host='0.0.0.0', port=3000)


if __name__ == '__main__':
    threading.Thread(target=run_flask, daemon=True).start()
    SocketModeHandler(app, os.environ['SLACK_APP_TOKEN']).start()
```

### 6. Run

```bash
python app.py
```

Bolt connects to Slack via Socket Mode; Flask listens on 3000; ngrok tunnels
to it. The terminal will show Bolt's connection logs.

### Common gotchas

- **Forgot `users:read.email`** — Slack returns the user object but `email`
  field is missing or empty. Re-add the scope and reinstall the app.
- **ngrok URL changed** — free-tier URLs change on every restart. Either
  upgrade or use `cloudflared tunnel` for stable URLs.
- **GitHub callback mismatch** — the `redirect_uri` in your authorize URL
  must exactly match what's registered in the OAuth app, including scheme
  and trailing slashes.
- **SQLite threading errors** — `check_same_thread=False` is mandatory
  since Flask and Bolt run in different threads.

---

## The demo

The PoC's whole point is this sequence:

1. **User A** in Slack: `/connect-github` → DM with link → click → GitHub
   auth → callback runs → DM "✓ Connected"
2. **User A**: `/issues` → list of *their* open GitHub issues
3. **User B** (different person) repeats the connect flow with *their*
   GitHub account
4. **User B**: `/issues` → list of *their* open issues, different from A's
5. **Revoke User A's grant** at `github.com/settings/applications` →
   **User A**: `/issues` → "GitHub token rejected. Run /connect-github to
   reconnect."

What this proves visibly:

- No shared service account — each user authenticates as themselves
- Identity isolation — A and B see different data with the same command
- Revocation propagates — the user-controlled GitHub OAuth grant is the
  source of truth, and breaking it correctly breaks access

This is the foundation. The rest of the architecture is built on top of
exactly this pattern.

---

## Next steps

In order of build.

### V1: add the LLM

Replace the slash commands with a single `@bot` mention handler. Send the
user's message plus a small tool schema to the LLM. Available tools:
`list_issues`, `list_prs`, `search_repos`. The LLM picks one, the handler
executes it against GitHub with the user's stored token, formats the result,
posts back.

The integration is already proven; the LLM is just an interface layer.

### V2: add Jira

Duplicate the OAuth flow for Atlassian. 3LO has one extra step — after token
exchange, call `https://api.atlassian.com/oauth/token/accessible-resources`
to get the user's `cloudId`, which you also store. API calls then use
`https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/...`.

The moment the bot can answer either a GitHub question or a Jira question
depending on what the user asked, the "agent over the corporate stack"
pitch starts feeling real.

### V3: insert db-mcp

Until now the integration has talked directly to vendor APIs. Insert
`db-mcp` as the data gateway: the LLM calls `db-mcp` tools, `db-mcp` does
the token exchange and applies semantic-layer authz. This is where the PoC
architecture becomes the architecture from the top of this document.

### V4+: hardening

- Real IdP integration replacing the Slack-email lookup
- Token store with encryption at rest
- Audit logging at every hop (OpenTelemetry)
- Async job runner for long-running queries
- Pooled workers, externalized session state, the full runtime

Each step is well-defined and individually small. The PoC validates the
foundation; everything after is incremental engineering on a proven shape.
