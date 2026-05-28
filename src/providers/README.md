# Provider Modules

Provider-specific integration code and metadata lives under
`src/providers/<provider>/`.

Each provider module can contain:

- `client.ts`: OAuth helpers, provider API calls, and provider-specific result
  types.
- `tools.yaml`: MCP-facing tool metadata.
- `tool-specs.ts`: a small loader/export surface for the YAML specs.
- Provider-specific policy files, when useful, such as
  `atlassian/policy.yaml`.

`tools.yaml` declares:

- stable MCP tool name
- model-facing alias
- audited TypeScript implementation binding
- title and description
- input schema

YAML is intentionally metadata only. Runtime behavior, authentication, provider
API calls, and output sanitization stay in TypeScript. This keeps community
provider additions reviewable without making declarative config an execution
surface.

Provider MCP wrappers should:

1. Load specs from `src/providers/<provider>/tools.yaml`.
2. Convert YAML input specs through `src/providers/tool-specs.ts`.
3. Bind each spec's `implementation` to a TypeScript handler.
4. Execute through the route-scoped provider connection.
