# Normalized Tool Policy PR Goal

This is a follow-up PR goal for replacing ad hoc policy blobs with a normalized
tool-policy layer.

## Why

The current runtime-policy foundation already enforces provider/tool policy via:

- `workspace_policy` key `tools.policy`
- `user_preferences` key `tools.disabled`
- runtime manifest evaluation
- Burble MCP tool filtering and call-time enforcement

That is enough for the current PR. A normalized `tool_policy` table is mainly
for cleaner admin UX, auditability, future policy editors, and less JSON-shape
coupling.

## Scope

Add a first-class policy table that can represent:

- global product policy
- workspace policy
- user-specific policy
- job-specific policy
- provider-level policy
- tool-level policy
- risk and confirmation overrides

Proposed shape:

```text
tool_policy(
  id,
  scope,                -- global | workspace | user | job
  workspace_id nullable,
  slack_user_id nullable,
  job_id nullable,
  provider nullable,
  tool_name nullable,
  effect,               -- allow | deny
  risk nullable,        -- read | low_write | moderate_write | high_write
  confirmation nullable,-- none | explicit | strong
  route_required nullable,
  reason nullable,
  updated_by_slack_user_id nullable,
  created_at,
  updated_at
)
```

## Precedence

Security default:

- deny wins over allow
- narrower scope can add more restrictions
- broader restrictions cannot be silently bypassed by user settings
- job policy narrows runtime authority; it does not expand it

Effective tools:

```text
effective_tools =
  global policy
  intersect workspace policy
  intersect user policy
  intersect runtime manifest
  intersect job capability, when present
```

## Compatibility

During migration:

- Continue reading `workspace_policy.tools.policy`.
- Continue reading `user_preferences.tools.disabled`.
- Convert those records into equivalent in-memory policy records before
  manifest evaluation.
- Avoid a hard migration requirement for existing deployments.

Later:

- Admin `/burble` policy commands should write normalized rows.
- User `/agent config set disable-tool ...` may continue writing
  `user_preferences.tools.disabled`, or move to user-scoped `tool_policy`
  rows once the UI is ready.

## Tests

Add coverage for:

- workspace provider deny
- workspace tool deny
- user tool deny
- job-scoped allowlist narrowing
- deny-wins precedence
- risk/confirmation override precedence
- compatibility with existing JSON policy records

## Out Of Scope

- Durable scheduled-job runner.
- Slack App Home policy editor.
- Admin authorization model for `/burble`.
- Provider marketplace/plugin policy.
