# Runtime Configuration, Policy, Skills, and Memory Plan

## Goal

Burble should make each personal agent runtime configurable without letting the
runtime, the model, a skill, or a user preference become the authority for
security policy.

The target shape is:

```text
Burble control plane
  -> computes effective runtime manifest
  -> provisions or reloads personal runtime
  -> mints scoped MCP credentials
  -> enforces provider/tool/route policy
  -> records audit events

personal runtime
  -> consumes manifest
  -> loads approved skills and memory context
  -> asks Burble MCP for allowed tools
  -> returns proposed output
```

The runtime can be OpenClaw, NemoClaw, Hermes, Burble-direct, or a later
runtime. The policy model should not depend on runtime internals.

## Runtime Implementation Pluggability

Burble separates the runtime lifecycle from the runtime implementation:

- `AGENT_RUNTIME` selects the Burble-side adapter contract. Use
  `burble-runtime` for a runtime HTTP service that exposes Burble's `/healthz`
  and `/runs` contract. The previous `openclaw-nemoclaw` value is accepted as a
  legacy alias only.
- `AGENT_RUNTIME_FACTORY` selects how Burble obtains that service, such as a
  static URL or Docker-backed personal runtime containers.
- `AGENT_RUNTIME_IMAGE` selects the container image when the factory is Docker.
- `AGENT_RUNTIME_ENGINE` labels the runtime implementation and drives
  per-engine runtime state/config isolation. Supported control-plane engine
  values are currently `deterministic`, `openclaw`, `openclaw-gateway`,
  `burble-direct`, and `hermes`.

The legacy `OPENCLAW_NEMOCLAW_ENGINE` remains as a compatibility alias for
existing OpenClaw/NemoClaw deployments. New deployments should prefer
`AGENT_RUNTIME_ENGINE`.

Example Hermes-capable deployment shape:

```env
AGENT_RUNTIME=burble-runtime
AGENT_RUNTIME_FACTORY=docker
AGENT_RUNTIME_IMAGE=ghcr.io/apelogic-ai/nemo-hermes-runtime:dev
AGENT_RUNTIME_ENGINE=hermes
```

This is only a control-plane selection shape. A Hermes image is not considered
supported just because it can run a one-shot CLI command. To be a real Burble
runtime, Hermes must provide the same first-class channel behavior that the
OpenClaw integration provides:

- Burble can inject inbound user turns into a durable Hermes conversation
  session keyed by Burble route/runtime identity.
- Hermes can deliver normal replies, task status, and cron/background output
  back through a Burble route, not through Slack IDs, webhooks, or local
  transport credentials.
- Hermes scheduled jobs can target `delivery.channel = "burble"` /
  `delivery.to = "<convrt_*>"`-style route bindings, or their Hermes-native
  equivalent, without exposing transport identifiers to the model.
- Hermes consumes scoped Burble MCP credentials and effective manifests as
  policy input rather than treating local Hermes config as authority.

The preferred implementation is a Hermes gateway platform plugin/adapter named
`burble`, plus a thin runtime HTTP shim when Burble needs to provision and
health-check the runtime. A `hermes chat -q ...` wrapper is useful only as a
smoke test; it is not sufficient for Burble production semantics because it
does not provide durable two-way channel integration.

Autonomous workgroup and company agents use the authority model in
[Autonomous Agent Authority Model](autonomous-agent-authority-model.md). This
runtime configuration plan consumes their effective principal and grants, but
does not define non-user authority by itself.

## Design Principles

1. Burble is the authority. Runtime-local config is a cache of an effective
   manifest, not a source of truth.
2. Provider OAuth tokens stay in Burble.
3. Skills can guide behavior but cannot grant tools.
4. Memory can guide behavior but cannot bypass policy.
5. Write tools require explicit policy and, for higher-risk actions,
   confirmation.
6. Scheduled jobs get minimal capabilities for the job, not the user's whole
   tool surface forever.
7. Runtime configuration changes are versioned, auditable, and reloadable.

## Configuration Ownership

### Centrally Enforced

These settings should be owned by Burble administrators or deployment config:

- Runtime engine and runtime factory.
- Approved model providers and model IDs.
- Model-provider credentials.
- MCP gateway URL, issuer, audience, and JWT settings.
- Provider OAuth client configuration.
- Provider token storage and refresh behavior.
- Global tool catalog.
- Tool risk classification.
- Tool allow/deny policy.
- Write-action confirmation rules.
- Route/capability validation.
- Slack visibility downgrade rules.
- Network and egress policy.
- Runtime resource limits.
- Runtime TTL/reaper policy.
- Audit logging and redaction.

### Workspace Configurable

Workspace admins should be able to configure:

- Allowed providers.
- Allowed tool groups.
- Allowed model choices from the global approved list.
- Allowed skills from the global skill catalog.
- Default provider scopes, such as default GitHub orgs.
- Whether durable memory is enabled.
- Whether scheduled jobs are allowed.
- Stricter confirmation rules for writes.
- User or group-specific tool restrictions.

### User Configurable

Users should be able to configure preferences, not authority:

- Preferred model from workspace-approved options.
- Tone, brevity, and formatting preferences.
- Default repos, projects, calendars, and similar aliases.
- Enabled skills from workspace-approved skills.
- Personal memory opt-in or opt-out.
- Notification and scheduled job preferences.
- Optional per-tool disablement for their own account.

User settings cannot grant tools that global/workspace policy denies.

## Configuration Storage and Application

Workspace and user configuration should live in Burble-owned durable storage.
Runtime-local files can mirror the effective configuration, but they are not
the source of truth.

### Workspace Configuration

Workspace config is administrator-managed policy. In the first implementation
it can be stored in SQLite as key/value JSON records. Later it can move behind
an admin API or managed control-plane service without changing the runtime
manifest contract.

Provisional storage shape:

```text
workspace_policy(
  workspace_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_by_slack_user_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id, key)
)
```

Example workspace policy records:

```json
{
  "workspace_id": "T123",
  "key": "providers.allowed",
  "value": ["github", "google", "jira", "slack"]
}
```

```json
{
  "workspace_id": "T123",
  "key": "models.allowed",
  "value": [
    { "provider": "openai", "model": "gpt-5.4" },
    { "provider": "openai", "model": "gpt-5.4-mini" }
  ]
}
```

```json
{
  "workspace_id": "T123",
  "key": "tools.policy",
  "value": [
    {
      "provider": "github",
      "tool": "github_merge_pr",
      "effect": "deny"
    },
    {
      "provider": "github",
      "tool": "github_create_pr",
      "effect": "allow",
      "confirmation": "explicit"
    },
    {
      "provider": "google",
      "toolGroup": "drive.write",
      "effect": "allow",
      "confirmation": "explicit"
    }
  ]
}
```

```json
{
  "workspace_id": "T123",
  "key": "skills.allowed",
  "value": [
    { "id": "github-pr-triage", "versions": ["1"] },
    { "id": "jira-ticket-summary", "versions": ["1"] }
  ]
}
```

```json
{
  "workspace_id": "T123",
  "key": "skills.sources.allowed",
  "value": {
    "marketplaces": [
      {
        "id": "burble-official",
        "url": "https://marketplace.burble.dev/skills",
        "trust": "official"
      },
      {
        "id": "company-internal",
        "url": "https://skills.example.com/catalog.json",
        "trust": "workspace"
      }
    ],
    "repositories": [
      {
        "host": "github.com",
        "owner": "apelogic-ai",
        "repo": "burble-skills",
        "refPolicy": "tagged-release-only"
      }
    ],
    "denyUnsigned": true
  }
}
```

```json
{
  "workspace_id": "T123",
  "key": "plugins.sources.allowed",
  "value": {
    "marketplaces": [
      {
        "id": "burble-official",
        "url": "https://marketplace.burble.dev/plugins",
        "trust": "official"
      }
    ],
    "repositories": [
      {
        "host": "github.com",
        "owner": "apelogic-ai",
        "repo": "burble-provider-plugins",
        "refPolicy": "tagged-release-only"
      }
    ],
    "denyUnsigned": true
  }
}
```

Application flow:

1. Admin updates workspace policy.
2. Burble validates it against known providers, tools, skills, plugins, source
   allowlists, signatures, and models.
3. Burble stores it and records an audit event.
4. Burble invalidates affected runtime manifest hashes.
5. Affected runtimes reload or restart on the next request.

Security restrictions should take effect immediately. Capability expansions
should normally require new user/job confirmation before existing scheduled
jobs can use them.

### User Configuration

User config is preference and opt-in state inside workspace limits.

Provisional storage shape:

```text
user_preferences(
  workspace_id TEXT NOT NULL,
  slack_user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id, slack_user_id, key)
)
```

Example user preferences:

```json
{
  "workspace_id": "T123",
  "slack_user_id": "U123",
  "key": "github.defaults",
  "value": {
    "org": "apelogic-ai",
    "repoAliases": {
      "burble": "apelogic-ai/burble",
      "warp-bridge": "apelogic-ai/warp-bridge"
    }
  }
}
```

```json
{
  "workspace_id": "T123",
  "slack_user_id": "U123",
  "key": "runtime.model",
  "value": {
    "provider": "openai",
    "model": "gpt-5.4"
  }
}
```

```json
{
  "workspace_id": "T123",
  "slack_user_id": "U123",
  "key": "tools.disabled",
  "value": ["github_create_pr", "google_move_drive_file"]
}
```

```json
{
  "workspace_id": "T123",
  "slack_user_id": "U123",
  "key": "skills.enabled",
  "value": [
    { "id": "github-pr-triage", "version": "1" }
  ]
}
```

```json
{
  "workspace_id": "T123",
  "slack_user_id": "U123",
  "key": "memory.user",
  "value": {
    "enabled": true,
    "retentionDays": 90
  }
}
```

User change surfaces:

- Slack App Home controls for common settings: provider connect, enabled
  skills, memory opt-in, selected model, disabled tools.
- Slash commands for user-scoped settings. The implemented command shape is:

```text
/agent config get [setting]
/agent config set <setting> <value>
```

The shorter `/agent get` and `/agent set` forms are accepted as aliases, but
`/agent config ...` is the documented shape so it stays visibly separate from
`/agent exec`.

- Examples:

```text
/agent config get
/agent config get model
/agent config set model gpt-5.4-mini
/agent config set memory off
/agent config set tools.disabled github_create_pr google_move_drive_file
/agent config set disable-tool github_create_pr
/agent config set enable-tool github_create_pr
```

These commands only mutate user preferences within workspace policy limits.
They must not grant tools, models, providers, or skills that the workspace has
not allowed.

- `/burble` is reserved for authorized workspace/admin operations. It can
  manage workspace-level policy, provider availability, approved skills, runtime
  defaults, and audit/admin diagnostics, subject to Slack user authorization.

- Natural-language requests can propose config changes, but Burble should
  confirm the interpreted setting before storing it when ambiguity or risk is
  non-trivial.

User application flow:

1. User requests or clicks a setting change.
2. Burble checks workspace policy.
3. If allowed, Burble stores the preference.
4. Burble records an audit event.
5. Burble recomputes the user's runtime manifest hash.
6. Runtime reloads or restarts on next use if needed.

Example denied user change:

```text
User: enable github_merge_pr
Burble: GitHub merge is disabled by workspace policy.
```

Example accepted user change:

```text
User: use apelogic-ai as my default GitHub org
Burble: Saved. I will use `apelogic-ai` as your default GitHub org when a repo
name is ambiguous.
```

## Effective Runtime Manifest

Burble should compute a runtime manifest for each principal.

```ts
type RuntimeManifest = {
  version: string;
  principal: {
    workspaceId: string;
    slackUserId: string;
  };
  runtime: {
    engine: string;
    factory: "static" | "docker" | "remote";
    ttlMs: number;
    reaperEnabled: boolean;
  };
  model: {
    provider: string;
    model: string;
    reasoningEffort?: string;
  };
  tools: Array<{
    name: string;
    provider: string;
    enabled: boolean;
    risk: "read" | "low_write" | "moderate_write" | "high_write";
    routeRequired: boolean;
    confirmation: "none" | "explicit" | "strong";
  }>;
  skills: Array<{
    id: string;
    version: string;
    enabled: boolean;
  }>;
  memory: {
    userMemoryEnabled: boolean;
    workspaceMemoryEnabled: boolean;
    jobMemoryEnabled: boolean;
  };
  disabledTools: string[];
  policyHash: string;
};
```

The manifest should be deterministic. Any relevant policy or preference change
must produce a different `policyHash`.

## Tool Policy

The effective tool set is an intersection:

```text
effective_tools =
  global_enabled_tools
  ∩ workspace_allowed_tools
  ∩ user_allowed_tools
  ∩ runtime_capability_tools
  - disabled_tools
```

Execution still requires:

```text
tool enabled
AND provider connected
AND runtime principal valid
AND route/capability valid when required
AND risk policy satisfied
AND confirmation policy satisfied when required
```

### Policy Levels

- Global: product/deployment-level tool availability.
- Workspace: tenant-level allowlist and restrictions.
- User: opt-in/opt-out and personal defaults.
- Runtime: manifest and scoped MCP credentials.
- Job: job-specific capabilities and confirmation state.

### Selective Disablement

Support these cases:

- Disable a provider for a workspace.
- Disable GitHub write tools for a workspace.
- Disable `github_create_pr` for one user.
- Disable all Google Drive write tools for scheduled jobs.
- Allow Jira read tools but require confirmation for Jira writes.

This should be represented as policy records, not hardcoded conditionals.

## Skills

Skills are approved behavior/context packages. They are not permissions.

Skill metadata should include:

```yaml
id: github-pr-triage
version: 1
title: GitHub PR triage
description: Helps summarize and triage pull requests.
requiresTools:
  - github_list_my_pull_requests
  - github_get_pr
optionalTools:
  - github_comment_on_issue_or_pr
risk: read-mostly
```

Rules:

- Skills must come from an approved marketplace or repository source.
- Repo-backed skills should be pinned to immutable refs, preferably signed
  release tags or commit SHAs. Branch refs are acceptable only for development
  workspaces.
- Workspace admins approve skill availability.
- Users enable approved skills.
- Skills can request tools through metadata.
- Policy decides whether requested tools are available.
- Skill content should be inspectable.
- Skill updates should create new versions.
- Runtime reload should be driven by manifest hash changes.

## Plugins

Plugins are installable runtime extensions. They can contribute tools, skills,
MCP servers, UI surfaces, or provider adapters, so they need a stricter policy
layer than skills.

Plugin metadata should include:

```yaml
id: github-provider
version: 1.2.0
source:
  marketplace: burble-official
  package: github-provider
  digest: sha256:...
contributes:
  providers:
    - github
  tools:
    - github_list_my_pull_requests
    - github_create_issue
  skills:
    - github-pr-triage
permissions:
  network:
    - api.github.com
  secrets:
    - github.oauth
risk: provider-adapter
```

Rules:

- Plugins must come from an approved marketplace or repository source.
- Workspace admins approve plugin availability.
- Users should not be able to install arbitrary plugins unless workspace policy
  explicitly allows personal plugin sources.
- Plugin versions should be pinned by digest or immutable release ref.
- Plugin-contributed tools still pass through normal tool policy.
- Installing or upgrading a plugin changes the runtime manifest hash.
- Removing or denying a plugin should immediately remove its contributed tools
  and skills from effective manifests.

## Durable Memory

Memory should be separated by scope.

### User Memory

Examples:

- Default GitHub org or repo.
- Preferred answer style.
- Personal aliases for projects.
- Notification preferences.

User memory must be inspectable and deletable by the user.

### Workspace Memory

Examples:

- Team aliases.
- Project ownership.
- Common repo mappings.
- Workspace-level style or compliance rules.

Workspace memory should be admin-managed.

### Job Memory

Examples:

- Last notified PR ID.
- Last processed Jira issue update timestamp.
- Report cursor.

Scheduled jobs should store canonical state in Burble-owned durable storage,
not only inside the runtime filesystem.

### Runtime Scratch Memory

Runtime-local memory can cache context and notes, but it is disposable. It
should not be the only copy of scheduled automation state.

## Runtime Lifecycle On Config Changes

When config changes:

1. Burble stores the changed policy/preference/skill/memory setting.
2. Burble recomputes the manifest for affected principals.
3. If `policyHash` changes, Burble records an audit event.
4. On the next request, Burble sends the current manifest to the runtime.
5. If the runtime supports reload, it reloads.
6. If it does not support reload, Burble restarts or reprovisions it.
7. Long-running jobs either keep their original manifest or are explicitly
   migrated.

Open question: whether existing scheduled jobs should inherit future user
policy changes automatically or keep a pinned manifest. Safer default is:

- security restrictions apply immediately;
- expansions require explicit job update or confirmation.

## Runtime Deployment Backends

Runtime deployment should be a pluggable factory concern. Docker is the current
dev implementation, not the architecture boundary.

The common contract is:

```ts
type RuntimeFactory = {
  kind: "static" | "docker" | "kubernetes" | "remote";
  getOrCreateRuntime(principal: {
    workspaceId: string;
    slackUserId: string;
  }): Promise<RuntimeHandle>;
  stopRuntime(runtimeId: string): Promise<void>;
  touchRuntime(runtimeId: string): Promise<void>;
  reapIdleRuntimes(now: Date): Promise<void>;
};

type RuntimeHandle = {
  id: string;
  endpointUrl: string;
  authToken: string;
  engine: string;
  manifestHash: string;
  status: "provisioning" | "ready" | "busy" | "idle" | "failed";
};
```

### Static Backend

The static backend points Burble at an already-running runtime URL.

Use cases:

- local development
- one-user demos
- compatibility while a real factory is being introduced

Limitations:

- not a multi-user isolation boundary
- no per-user lifecycle control
- should not be used for production multi-user provider access

### Docker Backend

The Docker backend starts one container per principal.

Expected resources:

```text
container: burble-rt-<runtime_id>
volume:    /data/runtimes/<runtime_id>
network:   private compose/runtime network
```

The container receives:

- runtime ID
- runtime-local auth token
- runtime manifest or manifest path
- Burble MCP/agentgateway URL
- model-provider configuration needed by the runtime

The container must not receive provider OAuth tokens.

Docker remains the simplest dev and single-host deployment backend.

### Kubernetes Backend

Kubernetes should be another implementation of the same factory contract.

Per principal, Burble can create:

```text
Pod or Deployment: burble-rt-<runtime_id>
Service:           burble-rt-<runtime_id>
PVC:               burble-rt-<runtime_id>-state
Secret:            burble-rt-<runtime_id>-auth
ConfigMap:         burble-rt-<runtime_id>-manifest
```

Possible configuration:

```env
AGENT_RUNTIME_FACTORY=kubernetes
AGENT_RUNTIME_K8S_NAMESPACE=burble-runtimes
AGENT_RUNTIME_IMAGE=...
AGENT_RUNTIME_SERVICE_ACCOUNT=burble-runtime
```

The runtime registry should store Kubernetes metadata:

```text
runtime_id
factory = kubernetes
namespace
pod_or_deployment_name
service_name
endpoint_url
auth_token_hash
manifest_hash
status
last_used_at
```

Kubernetes-specific policy requirements:

- NetworkPolicy should allow runtime pods to reach only Burble MCP,
  agentgateway, and approved model/provider endpoints.
- Runtime pods should not be able to reach each other.
- Burble's Kubernetes service account should have narrow RBAC for runtime
  resources in the runtime namespace only.
- Secrets should contain only runtime-local credentials, not provider OAuth
  tokens.
- PVC retention should be explicit: keep for durable runtime memory, delete for
  stateless/scratch runtimes.
- Image rollout should update or restart affected runtimes when runtime image
  or manifest compatibility changes.
- ResourceQuota and LimitRange should cap per-workspace and per-cluster runtime
  usage.
- Labels should make garbage collection and audit easy:

```text
app=burble-runtime
burble.io/runtime-id=<runtime_id>
burble.io/workspace-id=<workspace_id>
burble.io/slack-user-id=<slack_user_id>
burble.io/manifest-hash=<policy_hash>
```

### Backend-Agnostic Rules

All deployment backends must preserve the same security rules:

- Provider OAuth tokens stay in Burble.
- Runtime endpoint access is authenticated.
- Runtime tool access goes through Burble MCP or a Burble-approved gateway.
- Runtime lifecycle events are recorded.
- Runtime manifest changes are detectable by hash.
- Reaper and liveness semantics are enforced by Burble, even if the backend
  performs the actual stop/delete operation.

## Scheduled Jobs

Scheduled jobs need their own capability model.

A job record should include:

- owner principal.
- target route.
- target route grant, including whether the target was the invoking
  conversation or an explicitly approved different Slack channel.
- prompt/task.
- schedule.
- enabled flag.
- required tools.
- maximum output visibility: `public`, `channel`, `user_private`, or
  `restricted`.
- source/tool sensitivity requirements.
- declassification policy, if private-derived summaries are ever allowed to be
  posted to a shared channel.
- manifest or policy hash at creation.
- current cursor/state.
- last run status.

At run time, Burble should mint a job-scoped capability:

```text
principal = user
route = saved route
tools = required tools only
maxOutputVisibility = saved delivery grant
expires = short TTL
jobId = current job
```

This prevents a scheduled job from inheriting every tool the user happens to
have enabled.

### Scheduled Delivery Grants

Scheduled delivery must be explicit when the output target is not the current
Burble conversation.

Examples:

- User asks in `#reports`: create a recurring public-web summary and post it
  back to `#reports`.
- User asks in a DM: create a recurring public-web summary and post it to
  `#reports`.
- User asks in a DM: query my Jira tickets and post them to `#reports`.

The first case can reuse the active conversation route if Burble has channel
access. The second case requires a target-channel grant before the job is
created. The third case should be denied or require an explicit private-data
release policy, because user OAuth data would otherwise be posted into a shared
channel.

The grant should capture:

```text
delivery_route_id
delivery_transport = slack
delivery_channel_id
delivery_channel_kind = dm | public_channel | private_channel
approved_by_slack_user_id
approved_at
max_output_visibility
allowed_tools
allowed_source_sensitivity
declassification_required
```

Burble must verify it can post to the target Slack channel before accepting the
job. For private channels, Burble must be a member. For public channels, Burble
must either already be present or the workspace must explicitly grant a broader
Slack posting scope.

### Output Visibility Gate

Scheduled jobs need a final release gate before `conversation.sendMessage` or
any Slack `chat.postMessage` call.

The effective output visibility should be computed as the most restrictive
input involved in the run:

- public internet only: `public`
- public GitHub repository data, when repo visibility is known: `public`
- private GitHub, Jira, Google Drive/Gmail/Calendar, Slack search, or any user
  OAuth-backed provider: `user_private` by default
- restricted workspace/admin tools: `restricted`
- mixed public and private sources: private wins

The agent/runtime may propose a classification, but Burble is the authority.
If effective output visibility exceeds the saved delivery grant, Burble should
not post to the channel. It should instead fail the run, post a private
explanation to the creator, or require a preview/approval flow depending on
job policy.

`conversation.sendMessage` should eventually require delivery metadata such as:

```json
{
  "routeId": "convrt_...",
  "text": "...",
  "proposedVisibility": "public",
  "sourceClassifications": ["public"]
}
```

Burble should combine that with tool-call audit data from the run. A runtime
must not be able to declassify private data by simply setting
`proposedVisibility` to `public`.

The durable scheduled-job runner should be a separate implementation PR, not a
tail-end patch to runtime policy. That runner needs its own state machine,
claiming/lease behavior, retry/backoff, timeout handling, runtime selection,
route resolution, delivery grants, output visibility enforcement, job-scoped
JWT minting, and audit/event stream.

Proposed follow-up PR:

```text
scheduled -> due -> claimed -> running -> succeeded
                         -> failed_retryable -> scheduled
                         -> failed_terminal
                         -> cancelled
```

Responsibilities for that PR:

- Store and migrate durable schedules.
- Claim due work safely when multiple Burble app instances are running.
- Mint short-lived job-scoped JWTs with `job_id` and `allowed_tools`.
- Resolve and validate the saved delivery route grant before each run.
- Call the selected agent runtime with the saved task and route.
- Enforce the final output visibility gate before posting to Slack.
- Persist job state/cursors after each run.
- Record denied tools, retries, failures, and delivery results.
- Decide how legacy OpenClaw-owned cron jobs are imported, mirrored, or left as
  agent-local schedules.

## Data Model Sketch

Possible tables:

```text
workspace_policy(
  workspace_id,
  key,
  value_json,
  updated_at
)

user_preferences(
  workspace_id,
  slack_user_id,
  key,
  value_json,
  updated_at
)

tool_policy(
  id,
  workspace_id,
  slack_user_id nullable,
  tool_name nullable,
  provider nullable,
  effect allow|deny,
  confirmation none|explicit|strong nullable,
  updated_at
)

skill_catalog(
  id,
  version,
  metadata_json,
  content_ref,
  created_at
)

workspace_skills(
  workspace_id,
  skill_id,
  version,
  enabled,
  updated_at
)

user_skills(
  workspace_id,
  slack_user_id,
  skill_id,
  version,
  enabled,
  updated_at
)

runtime_manifests(
  runtime_id,
  policy_hash,
  manifest_json,
  generated_at
)

job_state(
  job_id,
  state_json,
  updated_at
)
```

## Implementation Plan

Implementation has started with the control-plane foundation:

- `workspace_policy` and `user_preferences` durable storage primitives.
- A deterministic runtime manifest builder that combines workspace policy,
  user preferences, runtime settings, tool catalog, skills, and memory flags.
- Tests for policy/preference persistence and manifest computation.
- MCP tool-call enforcement against the runtime manifest and job-scoped
  capability claims.
- `/agent config get` and `/agent config set` for user-scoped runtime
  preferences.

### Slice 1: Manifest Types and Builder

- Status: foundation implemented.
- Added manifest type definitions.
- Added manifest builder from current config, provider specs, workspace policy,
  user preferences, and runtime config.
- Added tests for policy/preference persistence and manifest behavior.

### Slice 2: Tool Policy Records

- Status: foundation implemented.
- Added workspace-level tool policy through `workspace_policy` key
  `tools.policy`.
- Added user-level tool denial through `user_preferences` key
  `tools.disabled`.
- Added provider/tool policy evaluation in runtime manifests and Burble MCP.
- Added tests for provider-level policy, user-disabled tools, write-tool
  confirmation policy, and job-scoped tool narrowing.
- Deferred: a normalized `tool_policy` table for richer global/workspace/user
  inheritance.

### Slice 3: Runtime Manifest Delivery

- Status: foundation implemented.
- Runtime factories compute and persist manifest policy hashes.
- Runtime handles carry the current manifest.
- OpenClaw/NemoClaw run requests receive manifest metadata, skills, memory
  settings, and memory context.
- Runtime policy drift is recorded as a runtime audit event.
- `/agent config set` stops the current user runtime when the effective
  manifest hash changes, so the next run starts with fresh config.
- Deferred: a general backend reload protocol for non-user-triggered manifest
  changes. Current fallback is still to send the latest manifest with each run.

### Slice 4: Skill Catalog

- Status: foundation implemented.
- Added durable skill metadata catalog storage.
- Added workspace/user skill enablement storage.
- Runtime manifest generation loads typed workspace/user skill enablement when
  present.
- Ensure skills cannot grant tools.
- Deferred: admin/user skill marketplace management UX.

### Slice 5: Memory Scopes

- Status: foundation implemented.
- Added user, workspace, and job-scoped memory storage with inspect/delete.
- Added dedicated durable job state storage keyed by job ID.
- Added prompt/context injection rules with size caps and redaction.
- Scheduled job execution will consume job state in the dedicated durable
  scheduled-job runner PR.

### Slice 6: Job-Scoped Capabilities

- Status: foundation implemented.
- Added durable scheduled job capability metadata keyed by job ID, including
  required tools, target route, and policy hash.
- Runtime JWTs can carry optional `job_id` and `allowed_tools` claims.
- Burble MCP intersects job-scoped `allowed_tools` with the active runtime
  manifest and hides/blocks unexpected tools.
- Unexpected job tool calls are denied before provider execution and recorded
  as runtime audit events.
- Scheduled runtime JWT minting will happen in the dedicated durable
  scheduled-job runner PR.

### Slice 7: User Config UX

- Status: implemented for the initial allowed user preference set.
- Added `/agent config get [key]` for user-scoped runtime preferences.
- Added `/agent config set <key> <value>` for model, user memory, disabled
  tools, and enabled skills.
- Added `disable-tool` / `enable-tool` shortcuts for user-scoped tool
  preferences.
- User config changes that alter the effective manifest stop the current
  runtime so the next request reprovisions cleanly.
- Keep `/burble` for admin/workspace policy controls in a later PR.

### Slice 8: Slack/Admin UX

- App Home should show provider connection state.
- Add runtime policy/status view.
- Add skill enablement controls.
- Add memory inspect/delete controls.
- Add tool-disabled explanations when a tool is blocked.

## Open Questions

- Should user memory be enabled by default or opt-in?
- Should workspace admins be able to inspect user memory, or only workspace
  memory?
- Which write tools require strong confirmation versus normal explicit
  confirmation?
- Should scheduled jobs pin manifests or always use the latest manifest?
- What is the migration story for runtime-local OpenClaw memory into
  Burble-owned memory?
- Should provider-defaults such as GitHub org aliases live in memory or in
  typed preferences?
