# Provider MCP Future Direction

Burble should move toward provider-native MCP integrations, but keep Burble as
the route-bound control plane.

## Target Shape

```text
OpenClaw agent
  -> Burble MCP gateway / policy broker
    -> provider MCP servers
      -> GitHub / Google / Jira / Slack
```

Burble remains responsible for:

- Slack principal and workspace binding.
- Conversation route and cron identity binding.
- Tool allowlists and write-action policy.
- Audit logs that include runtime, job, route, principal, provider, and tool.
- Cross-provider orchestration.
- Revocation and reconnect UX.

Provider MCP servers should be responsible for:

- Provider OAuth and enterprise SSO where available.
- Provider-specific API semantics.
- Provider schema evolution.
- Native provider errors and pagination semantics.

## Why Not Direct Agent-To-Provider MCP

Direct agent access to GitHub, Google, Jira, or Slack MCP servers bypasses the
Burble security boundary. It makes scheduled/background jobs harder to reason
about because the provider server does not know the Burble conversation route,
Slack workspace, Slack user, cron job, or runtime policy context.

The agent should receive a curated Burble-visible tool surface, not the full
provider MCP surface.

## Declarative Tool Specs

The current implementation still has duplicated tool metadata in code for:

- Burble provider MCP registration.
- OpenClaw static/fallback catalog entries.
- Runtime tool-name mapping.
- Tool-gateway validation.

This should move to declarative provider tool specs, for example YAML or JSON:

- Tool name and provider.
- Human-readable title/description.
- JSON schema or zod-compatible schema.
- Read/write classification.
- Risk level.
- Required provider scopes.
- Route requirement.
- Runtime exposure policy.
- Formatter hints for terminal/direct results.

The generated code should then derive:

- MCP `tools/list` registration.
- Runtime static catalog fallback.
- Burble tool-gateway validation.
- OpenClaw name mapping.
- Documentation and hand-test checklists.

This will make adding provider tools less error-prone and keep policy review
focused on the declarative spec rather than scattered code blocks.

## Incremental Plan

1. Keep Burble-local provider tools as the broker surface.
2. Replace individual provider implementations underneath with official/provider
   MCP servers where mature enough.
3. Keep write tools curated and opt-in.
4. Move catalog/schema/policy metadata into declarative specs.
5. Generate or load runtime/catalog/MCP registration from those specs.

