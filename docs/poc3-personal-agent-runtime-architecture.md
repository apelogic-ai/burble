# PoC3 Personal Agent Runtime Architecture

PoC3 moves Burble from a single dev runtime into a multi-user architecture
where each user gets an isolated agent runtime. This matches the trust boundary
of OpenClaw, NemoClaw, Hermes, and similar agent harnesses: treat each runtime
as single-user unless the runtime explicitly proves otherwise.

The important distinction is that Burble stays the shared Slack-facing control
plane. Personal agent runtimes are internal workers. We should not create one
Slack app per user for the first implementation.

## Goals

- Run one isolated agent runtime per user or per principal.
- Keep one shared Burble Slack app as the workspace-facing UX.
- Route messages to the correct personal runtime.
- Keep Slack posting, OAuth, provider tokens, and visibility policy in Burble.
- Allow runtimes to be OpenClaw, NemoClaw, Hermes, or a future in-house runner
  behind the same interface.
- Support idle shutdown and later resurrection of personal runtimes.
- Preserve the current PoC2 behavior for a single-user dev deployment.

## Non-Goals

- No per-user Slack app/bot provisioning in the default PoC3 path.
- No runtime direct access to Slack bot tokens.
- No runtime direct access to provider OAuth tokens.
- No public channel posting directly from a personal runtime.
- No attempt to make OpenClaw/Hermes multi-tenant internally.
- No Kubernetes dependency for the first slice; Docker Compose or a simple
  process/container supervisor is acceptable for dev.

## Architecture

```text
Slack workspace
  |
  | one installed Burble app
  v
Burble Slack adapter
  |
  v
Burble control plane
  - identity
  - routing
  - provider connections
  - visibility policy
  - runtime lifecycle
  - audit log
  |
  v
Runtime factory
  |
  +-- personal runtime: workspace T1, user U1
  |     OpenClaw/NemoClaw/Hermes
  |     isolated state/config/workspace/session
  |
  +-- personal runtime: workspace T1, user U2
        OpenClaw/NemoClaw/Hermes
        isolated state/config/workspace/session
```

Burble is the multi-tenant system. Agent runtimes are single-tenant workers
owned by exactly one `principal`.

## Identity Model

Use a principal key that can evolve:

```ts
type PrincipalId = {
  workspaceId: string;
  slackUserId: string;
};
```

For PoC3 this is enough. Later, enterprise deployments may map the principal to
an internal user ID, organization ID, or SCIM identity.

Runtime identity should be derived from the principal:

```text
runtime_id = sha256("slack:" + workspace_id + ":" + slack_user_id)
```

Do not use email as the primary key. Email is useful for provider matching but
can change.

## Runtime Isolation

Each personal runtime gets isolated:

- state directory
- config path
- workspace directory
- session files
- logs/transcripts/artifacts
- tool approval state
- runtime process/container
- network policy, when available
- resource limits

For OpenClaw-like runtimes:

```text
/data/runtimes/<runtime_id>/state
/data/runtimes/<runtime_id>/config/openclaw.json
/data/runtimes/<runtime_id>/workspace
```

Burble may pass env vars to the runtime, but never provider OAuth tokens.
Provider access still happens through Burble's internal tool gateway.

## Runtime Contract

PoC2 already has the right contract shape:

```text
POST /runs
Authorization: Bearer <runtime-token>
```

Request:

```ts
type RuntimeRunRequest = {
  principal: {
    workspaceId: string;
    slackUserId: string;
    email?: string;
  };
  conversation: {
    channelId: string;
    threadTs?: string;
    messageTs: string;
    isDirectMessage: boolean;
  };
  input: {
    text: string;
    connections: {
      github?: ConnectionSummary;
      jira?: ConnectionSummary;
    };
  };
};
```

Response:

```ts
type RuntimeRunResponse = {
  response: {
    classification: "public" | "user_private" | "restricted";
    text: string;
    blocks?: unknown[];
  };
  events?: AgentRunEvent[];
};
```

The runtime returns proposed content. Burble decides whether and where it can be
posted.

## Runtime Lifecycle

Lifecycle states:

```text
none -> provisioning -> ready -> busy -> idle -> stopping -> stopped -> failed
```

Minimum registry table:

```text
agent_runtimes(
  id,
  workspace_id,
  slack_user_id,
  engine,
  status,
  endpoint_url,
  auth_token_hash,
  state_path,
  config_path,
  workspace_path,
  created_at,
  last_seen_at,
  last_used_at,
  stopped_at,
  failure_reason
)
```

For SQLite dev, this can be a normal table plus an in-process supervisor. For a
later service deployment, move lifecycle to a small orchestrator service.

## Runtime Factory

The factory owns:

- choosing runtime engine: `openclaw`, `hermes`, `deterministic`, etc.
- allocating ports or service names
- creating state/config/workspace directories
- generating runtime auth token
- writing runtime config patch
- starting the runtime process/container
- probing `/healthz`
- stopping idle runtimes
- cleaning failed runtimes

Interface:

```ts
type RuntimeFactory = {
  getOrCreateRuntime(principal: PrincipalId): Promise<RuntimeHandle>;
  stopRuntime(runtimeId: string): Promise<void>;
  reapIdleRuntimes(now: Date): Promise<void>;
};

type RuntimeHandle = {
  id: string;
  engine: "openclaw" | "hermes" | "deterministic";
  endpointUrl: string;
  authToken: string;
  status: "ready" | "busy" | "idle";
};
```

The conversation orchestrator should not know whether the runtime is a Docker
container, local process, Kubernetes pod, ECS task, or remote service.

## Slack App Strategy

Default PoC3 strategy:

- one shared Burble Slack app per workspace
- one bot identity in Slack
- Burble routes messages to personal runtimes internally

This is the right first implementation because it avoids:

- per-user Slack app creation
- per-user Socket Mode app tokens
- per-user bot tokens
- per-user install/admin approval flows
- app naming collisions
- orphaned app cleanup
- Slack app manifest automation complexity

Optional later strategy:

```text
AgentGod control app
  -> provisions personal Slack app
  -> provisions personal runtime
  -> wires personal app to personal runtime
```

Use that only if a customer needs visibly separate bot identities, separate
Slack app ownership, or per-bot Slack scopes as part of the trust boundary.

## Message Routing

For any Slack event:

```text
1. Normalize Slack event into ConversationRequest.
2. Resolve principal: workspace_id + slack_user_id.
3. Load or create provider connection summaries.
4. Ask RuntimeFactory for the principal runtime.
5. Send sanitized runtime request.
6. Receive proposed response.
7. Enforce visibility.
8. Post via the shared Burble Slack app.
```

Runtime selection should be per principal, not per channel. A user may interact
with their personal runtime from a DM or from a shared channel mention, but the
runtime identity stays the same.

## Shared Channel Policy

Personal runtimes can be invited into shared channel workflows through Burble,
but their data remains user-scoped by default.

Policy:

- Runtime output with `user_private` or `restricted` classification is never
  posted publicly in a shared channel.
- In channels, user-private output is ephemeral to the requester by default.
- In app DMs, user-private output can be posted normally.
- Public output may be posted to channel/thread.
- A future "share" action requires an explicit audience check.

Do not let a runtime decide final Slack visibility. It can classify content,
but Burble owns enforcement.

## Tool Gateway

The runtime should not call GitHub, Jira, Slack, or internal services directly
with user credentials.

Instead:

```text
runtime -> Burble internal tool gateway -> provider backend
```

The gateway enforces:

- principal identity
- provider connection lookup
- tool allowlist
- result caps
- output sanitization
- classification
- audit logging

Runtime auth should be bound to one principal. A runtime for user A must not be
able to call tools as user B.

## Orchestration Options

### Dev Slice: Docker Compose plus Local Supervisor

Simplest PoC3 path:

- Burble process starts runtimes using Docker CLI or a small local supervisor.
- Each runtime is a container on the compose network.
- Runtime data lives in named volumes or host paths under `/data/runtimes`.
- Registry is SQLite.

Pros:

- fast to build
- close to current deployment
- no new cloud control plane

Cons:

- weak scheduling
- limited observability
- harder to scale beyond one box

### Near-Term Production: ECS/Fargate or Kubernetes

The same factory interface can later create ECS tasks or Kubernetes pods.

Per-runtime requirements:

- CPU/memory limits
- persistent volume or object-backed state
- private network only
- service discovery address
- runtime auth token secret
- idle shutdown

### Long-Term: Dedicated Runtime Pool

For many users, cold-starting one runtime per message is too slow. Add:

- warm runtime pool
- idle TTL
- max runtimes per workspace
- per-user concurrency limit
- queue for pending runs
- backpressure response in Slack

## Security Model

Threats:

- runtime escapes its user boundary
- runtime reads another user's state
- runtime calls tools as another user
- runtime posts directly to Slack
- model hallucinates unsupported operational facts
- channel response leaks user-private data

Controls:

- one runtime auth token per principal/runtime
- tool gateway checks runtime token maps to principal
- no provider tokens in runtime env
- no Slack bot token in runtime env
- per-runtime state/config/workspace paths
- runtime output always returns to Burble for visibility enforcement
- capability routing before model invocation
- audit log on every tool call and runtime run

## Observability

Log events:

- runtime provision requested
- runtime provision finished/failed
- runtime run start/finish
- runtime idle shutdown
- tool call start/finish
- visibility decision

Do not log:

- OAuth tokens
- Slack bot/app tokens
- raw provider payloads
- full prompts by default
- full model responses when they include provider data

Useful fields:

```text
runtime_id
workspace_id
slack_user_id
engine
channel_type
is_direct_message
tool_names
classification
visibility
duration_ms
result_count
```

## Data Model

Add:

```text
agent_runtimes
agent_runtime_events
agent_sessions
agent_runtime_locks
```

Possible schema:

```text
agent_sessions(
  id,
  runtime_id,
  workspace_id,
  slack_user_id,
  channel_id,
  thread_ts,
  created_at,
  updated_at
)

agent_runtime_events(
  id,
  runtime_id,
  event_type,
  summary,
  created_at
)

agent_runtime_locks(
  runtime_id,
  locked_until,
  owner_id
)
```

The lock table prevents two concurrent Burble workers from provisioning the
same runtime.

## Implementation Plan

### Slice 1: Runtime Registry

Implement DB-backed runtime registry:

- create table `agent_runtimes`
- lookup by `(workspace_id, slack_user_id, engine)`
- status transitions
- last-used timestamps

Tests:

- creates runtime record for user
- returns same runtime for same principal
- different users get different runtime records
- status transition validation

### Slice 2: Runtime Factory Interface

Add `RuntimeFactory` interface and a dev implementation that does not yet start
containers. It returns the existing configured remote runtime for compatibility.

Tests:

- conversation orchestrator asks factory for runtime in `openclaw` mode
- no Slack/Bolt types cross the interface
- runtime handle is principal-scoped

### Slice 3: Principal-Bound Tool Gateway

Bind runtime auth tokens to principal/runtime.

Current gateway accepts one shared internal token. PoC3 should accept:

```text
Authorization: Bearer <runtime-token>
X-Burble-Runtime-Id: <runtime-id>
```

Then enforce:

```text
runtime_id -> workspace_id/slack_user_id -> provider connection
```

Tests:

- runtime A cannot call tools for runtime B
- missing runtime token is rejected
- shared legacy token remains available only for dev

### Slice 4: Local Container Runtime Factory

Start one runtime container per user on the dev AWS box.

Container env:

```text
BURBLE_TOOL_GATEWAY_URL=http://burble-app:3000/internal/tools
BURBLE_INTERNAL_TOKEN=<runtime-specific-token>
OPENCLAW_NEMOCLAW_ENGINE=openclaw
OPENCLAW_STATE_DIR=/data/openclaw/state
OPENCLAW_CONFIG_PATH=/data/openclaw/config/openclaw.json
OPENCLAW_WORKSPACE_DIR=/data/openclaw/workspace
OPENCLAW_CONFIG_PATCH_PATH=/etc/openclaw/patches/openai.json5
```

Container volumes:

```text
/data/runtimes/<runtime_id>:/data/openclaw
./openclaw-patches:/etc/openclaw/patches:ro
```

Tests:

- generated container spec contains no provider tokens except model provider
  keys explicitly approved for the runtime engine
- state paths include runtime ID
- startup waits for health check

### Slice 5: Routing Through Personal Runtime

Replace the single `OPENCLAW_NEMOCLAW_URL` dependency with factory lookup:

```text
conversation request -> runtime factory -> runtime handle -> POST /runs
```

Keep `OPENCLAW_NEMOCLAW_URL` as dev fallback.

Tests:

- user A request goes to runtime A URL
- user B request goes to runtime B URL
- DMs do not thread fresh replies
- channel private data remains ephemeral

### Slice 6: Idle Reaper

Add idle shutdown:

```text
if now - last_used_at > AGENT_RUNTIME_IDLE_TTL_SECONDS:
  stop runtime
```

Defaults:

```text
AGENT_RUNTIME_IDLE_TTL_SECONDS=1800
AGENT_RUNTIME_MAX_PER_WORKSPACE=20
```

Tests:

- idle runtime is stopped
- busy runtime is not stopped
- stopped runtime is recreated on next message

### Slice 7: Runtime Events and Audit

Record lifecycle and tool events.

Tests:

- provision event recorded
- run event recorded
- tool event contains summary but no token
- visibility event recorded

### Slice 8: Optional Personal Slack App Mode

Design only. Do not implement unless needed.

If required later:

- AgentGod app provisions personal Slack app from manifest.
- User/admin approves install.
- personal bot token is scoped to that user's bot.
- personal runtime receives no token directly; it still talks through Burble or
  a per-bot Slack adapter.

This mode is operationally heavier and should not block PoC3.

## Definition of Done

PoC3 is done when:

1. User A and User B both use the same Burble Slack app.
2. Each user gets a different runtime ID and isolated state/workspace.
3. Burble routes each user's messages to their own runtime.
4. Runtime A cannot call tools as User B.
5. Provider OAuth tokens remain in Burble, not in runtime prompts or state.
6. Fresh app DM replies are not threaded.
7. Channel responses with user-private data remain ephemeral.
8. Idle runtimes are stopped and can be recreated.
9. Logs show runtime lifecycle and run boundaries without secrets.

