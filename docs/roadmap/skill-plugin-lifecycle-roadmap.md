# Skill and Plugin Lifecycle Roadmap

## Context

Burble already has the start of a skill model, but plugins are still mostly
runtime image artifacts.

Current skill persistence:

- `skill_catalog`: global skill metadata keyed by `id + version`.
- `workspace_skills`: workspace-level skill allow/enable state.
- `user_skills`: user-level skill enable/preference state.

Current plugin handling:

- Hermes plugins are bundled in the runtime image under
  `runtimes/nemo-hermes/hermes-plugins`.
- The runtime copies bundled plugins into its runtime home at startup.
- Fixed plugin names are written into Hermes config.
- Burble does not yet have plugin catalog, install, enable, disable, upgrade, or
  removal workflows.

The target product model is:

```text
plugin package
  contributes tools + skills + permissions
    -> workspace admin approval
      -> user skill enablement
        -> runtime manifest
          -> agent receives selected skills/tools/plugins
```

## Definitions

### Skill

A skill is model-facing instruction. It tells the runtime agent how to use a
capability, provider, workflow, or operating convention.

Examples:

- GitHub PR triage skill.
- Google Drive shared-drive search skill.
- Scheduled task execution skill.
- Burble workflow authoring skill.

Skills are not executable code. They should be versioned and inspectable.

### Plugin

A plugin is executable runtime capability code.

Examples:

- Hermes `burble-platform` plugin.
- Hermes `burble-provider-tool` plugin.
- Hermes `burble-web-extract` plugin.
- OpenClaw `burble-channel` plugin.

Plugins may contribute tools, skills, platform adapters, provider bridges, or
runtime integrations. Plugins need stricter approval than skills because they
expand executable surface area.

## Principles

- Slash commands and App Home may use deterministic lifecycle-management flows.
- Ordinary chat should use the agent loop and structured tools, not regex
  routing.
- Workspace admins approve plugin availability.
- Users can enable/disable allowed optional skills.
- Plugin versions should be immutable and pinned by digest or release ref.
- Removing a plugin must remove its contributed tools and skills from effective
  runtime manifests.
- Tool policy remains authoritative even when a plugin contributes tools.
- Skills are versioned; behavior-changing edits should create a new version.
- Disable is the normal delete path. Hard delete is only for unused/unreferenced
  records or dev cleanup.

## Current State

### Implemented

- Skill catalog storage.
- Workspace skill enablement storage.
- User skill enablement storage.
- Runtime manifest assembly includes workspace/user skill state.
- Runtime plugin bundling for Hermes/OpenClaw images.

### Missing

- Admin UI for skills.
- User UI for skill preferences.
- Plugin catalog table.
- Plugin install/upgrade/disable workflow.
- Mapping from plugin contributions to tools/skills.
- Runtime manifest plugin section derived from Burble policy.
- Runtime reload/restart behavior when plugin state changes.
- Audit events for skill/plugin changes.

## Data Model

### Existing Skill Tables

Keep:

```text
skill_catalog(
  id,
  version,
  title,
  description,
  metadata_json,
  content_ref,
  created_at,
  primary key(id, version)
)

workspace_skills(
  workspace_id,
  skill_id,
  version,
  enabled,
  updated_by_slack_user_id,
  updated_at,
  primary key(workspace_id, skill_id, version)
)

user_skills(
  workspace_id,
  slack_user_id,
  skill_id,
  version,
  enabled,
  updated_at,
  primary key(workspace_id, slack_user_id, skill_id, version)
)
```

Add later if needed:

```text
skill_content(
  skill_id,
  version,
  content_text,
  content_sha256,
  created_at,
  primary key(skill_id, version)
)
```

`content_ref` can remain the stable pointer. Inline `skill_content` is optional
if skills are still loaded from repo/runtime assets.

### New Plugin Tables

Proposed:

```text
plugin_catalog(
  id,
  version,
  title,
  description,
  source_type,
  source_ref,
  package_ref,
  digest,
  metadata_json,
  created_at,
  primary key(id, version)
)

plugin_contributions(
  plugin_id,
  plugin_version,
  contribution_type, -- tool|skill|provider|platform_adapter|runtime_hook
  contribution_id,
  metadata_json,
  primary key(plugin_id, plugin_version, contribution_type, contribution_id)
)

workspace_plugins(
  workspace_id,
  plugin_id,
  version,
  enabled,
  updated_by_slack_user_id,
  updated_at,
  primary key(workspace_id, plugin_id, version)
)

user_plugins(
  workspace_id,
  slack_user_id,
  plugin_id,
  version,
  enabled,
  updated_at,
  primary key(workspace_id, slack_user_id, plugin_id, version)
)
```

`user_plugins` should stay optional. Most executable plugin policy should be
workspace/admin controlled.

## Lifecycle Workflows

### Skill Create

1. Register a new `skill_catalog` row.
2. Store or reference immutable skill content.
3. Optionally attach metadata:
   - provider
   - tool groups
   - risk
   - default enabled state
   - compatible runtime engines
4. Do not auto-enable for all users unless workspace policy says so.

### Skill Read

App Home / admin views should show:

- Catalog skills.
- Workspace allowed/enabled state.
- User enabled state.
- Version.
- Description.
- Source/content reference.
- Contributed-by plugin, if any.

### Skill Update

Behavior-changing updates create a new `version`.

Allowed in-place updates:

- title typo
- description typo
- metadata display fields

Not allowed in-place:

- instruction content changes
- provider/tool behavior changes
- risk changes

### Skill Delete

Default delete is disable:

- workspace disable removes skill from `skills.allowed`
- user disable removes skill from `skills.enabled`

Hard delete only if:

- no workspace/user references exist
- no plugin contribution references it
- no runtime manifest/audit requires historical lookup

### Plugin Install

1. Admin selects plugin from approved source.
2. Burble resolves immutable package/version/digest.
3. Burble reads plugin manifest.
4. Burble records `plugin_catalog`.
5. Burble records `plugin_contributions`.
6. Admin enables plugin for workspace.
7. Contributed skills are added to catalog.
8. Contributed tools become visible only through normal tool policy.
9. Runtime manifest hash changes.

### Plugin Read

Admin view should show:

- installed plugins
- available plugins from approved sources
- enabled/disabled state
- version/digest
- contributed tools
- contributed skills
- required provider scopes/secrets
- runtime compatibility
- risk classification

### Plugin Update

Plugin updates install a new immutable version:

1. Record new catalog version.
2. Compare contributions with previous version.
3. Show added/removed tools/skills/permissions.
4. Admin approves upgrade.
5. Enable new version.
6. Disable old version after runtime transition.
7. Recompute runtime manifest hash.

### Plugin Delete

Default delete is disable:

1. Disable workspace plugin.
2. Remove contributed tools from effective runtime manifests.
3. Remove contributed skills from effective skill sets unless independently
   allowed.
4. Mark affected runtimes for reload/restart.
5. Keep catalog history for audit.

Hard delete should be a maintenance/admin-only operation.

## Runtime Manifest Integration

Runtime manifest should eventually include:

```json
{
  "plugins": [
    {
      "id": "burble-provider-tool",
      "version": "1.2.0",
      "digest": "sha256:...",
      "enabled": true
    }
  ],
  "skills": {
    "allowed": [
      { "id": "github-pr-triage", "version": "1.0.0" }
    ],
    "enabled": [
      { "id": "github-pr-triage", "version": "1.0.0" }
    ]
  }
}
```

The runtime should not independently decide which plugins are allowed. It should
receive a Burble-authored manifest and enforce it locally.

## App Home UX

### User View

Add a "Skills" section:

- list enabled skills
- list available skills allowed by workspace
- enable/disable optional skills
- inspect skill details

### Admin View

Add a "Runtime capabilities" section:

- installed plugins
- available plugins
- plugin details
- enable/disable plugin
- upgrade plugin
- inspect contributed tools/skills
- inspect policy and risk

If admin role detection is not ready, expose read-only plugin state first and
keep mutations behind explicit slash/admin command or config.

## Agent Tooling

Eventually expose structured tools for lifecycle management:

- `burble.listSkills`
- `burble.getSkill`
- `burble.enableSkill`
- `burble.disableSkill`
- `burble.listPlugins`
- `burble.getPlugin`

Admin-only tools:

- `burble.installPlugin`
- `burble.enablePlugin`
- `burble.disablePlugin`
- `burble.upgradePlugin`

These tools should be explicit, structured, and policy-gated. They should not
depend on regex intent classifiers.

## Audit

Record audit events for:

- skill catalog created
- skill workspace enabled/disabled
- skill user enabled/disabled
- plugin catalog installed
- plugin workspace enabled/disabled
- plugin upgraded
- plugin disabled due to policy
- runtime manifest changed because of skill/plugin state

Audit fields:

- workspace ID
- Slack user ID
- skill/plugin ID
- version
- action
- old state
- new state
- runtime manifest hash
- timestamp

## Rollout Plan

### Slice 1: Document and Read Model

- Add this roadmap.
- Add read-only selectors for effective skills/plugins.
- Add tests for manifest construction.

### Slice 2: Skill Management

- Add App Home read-only skill list.
- Add user enable/disable for workspace-allowed skills.
- Add workspace/admin enable/disable path.
- Add audit events.

### Slice 3: Plugin Catalog

- Add plugin catalog and contribution tables.
- Seed bundled runtime plugins into catalog.
- Show installed plugin state in App Home.
- Keep plugin mutation disabled by default.

### Slice 4: Runtime Manifest Plugins

- Include plugin state in runtime manifest.
- Make Hermes/OpenClaw config generation derive enabled plugin list from the
  manifest where practical.
- Preserve existing bundled plugin behavior as the compatibility fallback.

### Slice 5: Plugin Mutations

- Add admin enable/disable.
- Add upgrade-by-version for approved sources.
- Recompute manifest hashes and reload/restart affected runtimes.

### Slice 6: Marketplace / External Sources

- Add approved source registry.
- Add digest pinning.
- Add package verification.
- Add contribution diff review before install/upgrade.

## Acceptance Criteria

- Users can inspect and toggle allowed skills.
- Workspace admins can inspect workspace skill policy.
- Bundled plugins are visible as installed capabilities.
- Plugin-contributed skills/tools are traceable to their plugin.
- Disabling a plugin removes its contributed tools/skills from effective
  manifests.
- Runtime manifests are reproducible from Burble state.
- Plugin/skill changes are audited.
- Ordinary chat does not rely on regex intent routing for skill/plugin lifecycle
  management.

## Open Questions

- What is the first admin surface: App Home, slash command, or config-only?
- Do skills live in DB content, repo assets, or runtime package assets?
- Do we support user-level plugin enablement, or only workspace-level?
- What is the runtime reload boundary for plugin changes?
- Which plugin sources are allowed in dev, staging, and production?
- How do we represent plugin compatibility across OpenClaw, Hermes, and future
  runtimes?
