# Provider Modules

Provider-specific integration metadata lives under `src/providers/<provider>/`.

The first supported contract is `tools.yaml`, which declares MCP-facing tool
metadata:

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
