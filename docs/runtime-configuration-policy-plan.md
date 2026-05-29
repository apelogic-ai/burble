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
- Slash commands for user-scoped settings. The preferred command shape is:

```text
/agent get <setting>
/agent set <setting> <value>
```

- Examples:

```text
/agent get model
/agent set model gpt-5.4-mini
/agent get github default-org
/agent set github default-org apelogic-ai
/agent set github repo-alias warp-bridge apelogic-ai/warp-bridge
/agent set tool github_create_pr disabled
/agent set skill github-pr-triage enabled
/agent set memory off
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
- prompt/task.
- schedule.
- enabled flag.
- required tools.
- manifest or policy hash at creation.
- current cursor/state.
- last run status.

At run time, Burble should mint a job-scoped capability:

```text
principal = user
route = saved route
tools = required tools only
expires = short TTL
jobId = current job
```

This prevents a scheduled job from inheriting every tool the user happens to
have enabled.

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

The initial implementation does not yet enforce the manifest at MCP tool-call
time or expose `/agent set` / `/agent get` in Slack. Those are the next slices.

### Slice 1: Manifest Types and Builder

- Status: foundation implemented.
- Added manifest type definitions.
- Added manifest builder from current config, provider specs, workspace policy,
  user preferences, and runtime config.
- Added tests for policy/preference persistence and manifest behavior.

### Slice 2: Tool Policy Records

- Add global/workspace/user tool policy storage.
- Add policy evaluation.
- Add tests for provider-level, tool-level, and user-level denial.

### Slice 3: Runtime Manifest Delivery

- Include manifest metadata in runtime run requests.
- Teach OpenClaw/NemoClaw wrapper to log manifest version and expose it in
  status.
- Restart/reload runtime when manifest hash changes.

### Slice 4: Skill Catalog

- Add skill metadata model.
- Add workspace/user enablement.
- Load only approved/enabled skills into runtime context.
- Ensure skills cannot grant tools.

### Slice 5: Memory Scopes

- Add user memory storage with inspect/delete.
- Add workspace memory storage.
- Add job state storage.
- Add prompt/context injection rules with size caps and redaction.

### Slice 6: Job-Scoped Capabilities

- Store required tools on scheduled jobs.
- Mint short-lived job capabilities at runtime.
- Deny unexpected tools during job execution.
- Add audit events for denied job tool calls.

### Slice 7: Slack/Admin UX

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
