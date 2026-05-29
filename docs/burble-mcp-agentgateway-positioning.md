# Burble MCP, Agentgateway, and Product Positioning

This note captures the architecture review against the earlier MCP gateway
benchmark work in `~/dev/mcp-gateway-bench/`.

## Short Answer

The current Burble MCP architecture is defensible.

Burble MCP is not an MCP gateway product in the same category as
agentgateway, Lunar MCPX, Obot, Mint, or Portkey. It is a Burble-specific MCP
adapter and policy broker.

Its job is to expose a curated Burble provider-tool surface to Burble-owned
agent runtimes while preserving Burble's Slack identity, OAuth token, route,
runtime, and audit boundaries.

Agentgateway is the gateway component. It provides MCP ingress, MCP protected
resource metadata, JWT validation against Burble's JWKS, CORS/header handling,
and proxying to Burble's internal MCP endpoint.

## Product Proposition

### What Burble MCP Is

Burble MCP is an application adapter for Burble's private agent architecture.

It turns Burble's provider tools into an MCP-compatible surface:

- GitHub tools bound to the connected Slack user's GitHub OAuth token.
- Google tools bound to the connected Slack user's Google OAuth token.
- Jira tools bound to the connected Slack user's Jira OAuth token.
- Slack search tools bound to the connected Slack user's Slack user token.
- A curated Atlassian MCP facade with allowlisting and result/schema
  sanitization.

It also applies Burble-specific policy:

- Runtime JWT verification and runtime registry lookup.
- Slack workspace and Slack user binding.
- Provider connection lookup by runtime principal.
- Conversation route validation.
- Runtime liveness updates.
- Provider token refresh and storage.
- Tool-result classification.
- Burble audit events.
- Reconnect UX when a user has not connected a provider.

This is a product capability because it makes Burble agents useful and safe
inside Slack. It is not a standalone gateway product because its value depends
on Burble's surrounding control plane.

### What Burble MCP Is Not

Burble MCP is not trying to be:

- A generic enterprise MCP gateway.
- A catalog for arbitrary third-party MCP servers.
- A central platform-team tool registry.
- A general OAuth/OIDC front door for any MCP client.
- A multi-upstream MCP routing product independent of Burble.
- A replacement for agentgateway, Lunar, Obot, Portkey, Mint, or similar
  gateway-tier systems.

If packaged as a product, it should be described as:

```text
Burble Provider MCP Adapter
```

or:

```text
Burble Policy-Brokered MCP Adapter
```

It should not be marketed as:

```text
Burble MCP Gateway
```

unless the product intentionally expands into generic gateway concerns such as
tenant-wide catalog, arbitrary upstream registration, gateway-owned auth, tool
RBAC, request/response policy DSLs, and centralized MCP observability.

## Comparison With MCP Gateways

From the benchmark docs, real MCP gateways generally own some mix of:

- Identity termination: OAuth, OIDC, JWT, API tokens.
- MCP protected-resource discovery.
- Tool-level RBAC.
- Audit and observability.
- Routing and multiplexing to one or more upstream MCP servers.
- Transport mediation.
- Catalog or registry.
- Guardrails, filtering, or policy plugins.

Agentgateway specifically is strongest as a Pattern B gateway:

- It validates JWTs against an external issuer's JWKS.
- It exposes MCP 2025-06-18 protected-resource metadata.
- It passes identity through to upstream MCP servers.
- In the benchmark, it did not provide default tool-level policy enforcement.

Burble MCP owns the layer below that:

- It knows what a Burble runtime is.
- It knows what Slack workspace/user the runtime belongs to.
- It knows which provider tokens are connected for that Slack user.
- It knows how to refresh provider tokens.
- It knows which conversation route a runtime is allowed to use.
- It knows which Atlassian MCP tools are allowed.
- It knows how to shape provider results for Burble agents.

Those are application semantics. They are not things a generic MCP gateway can
infer from JSON-RPC alone.

## Functional Duplication Assessment

### Defensible Duplication

Burble validates runtime JWTs even when agentgateway is in front.

This is acceptable. Agentgateway validates the ingress token, but Burble still
needs the claims to resolve the runtime record and enforce Burble-specific
runtime, workspace, Slack user, and route checks. Burble also remains protected
if an internal caller bypasses agentgateway and reaches `burble-app:3000/mcp`
directly.

### Real Duplication Inside Burble

The current duplication is not primarily between Burble and agentgateway. It is
inside Burble:

- The legacy `/internal/tools/:tool/execute` endpoint.
- The newer `/mcp` provider adapter.
- Runtime static/fallback tool catalogs.
- Tool-name mapping between Burble names and MCP names.
- Tool validation and schema definitions across multiple files.

This is already called out in `docs/provider-mcp-future-direction.md`.

The right fix is not to delete agentgateway or move Burble policy into
agentgateway. The right fix is to converge Burble provider-tool metadata into a
single declarative source of truth.

## Caveats

### Gateway Bypass

Today, if a runtime can reach `burble-app:3000/mcp` directly, it can bypass
agentgateway. This is not currently a major security loss because Burble still
validates the runtime JWT and enforces the meaningful application policy.

It becomes a problem if we later depend on agentgateway for:

- Tool-level RBAC.
- Rate limits.
- Request or response filtering.
- Centralized audit.
- Tenant-level MCP policy.

If those controls move to agentgateway, the network must force runtimes through
agentgateway or Burble must require an additional upstream credential minted by
agentgateway.

### Naming

The word "gateway" is overloaded.

In this repo:

- `agentgateway` is the MCP gateway tier.
- Burble MCP is the Burble-owned provider adapter and policy broker.
- `/internal/tools` is a legacy internal REST-like tool gateway.

For architecture docs, prefer:

- "agentgateway MCP ingress"
- "Burble provider MCP adapter"
- "Burble policy broker"
- "legacy internal tool gateway"

Avoid calling all of them "gateway" without a qualifier.

### Public Surface

The provided Caddy config blocks `/mcp*` and `/internal/*` from the public
HTTPS endpoint. That remains important. Burble MCP is currently intended for
runtime-to-Burble traffic, not arbitrary external MCP clients.

### Product Boundary

Burble MCP could become a standalone product only if it stops depending on
Burble-specific assumptions and grows gateway-category features:

- Arbitrary upstream MCP server registration.
- External customer identity providers as first-class issuers.
- General tool RBAC independent of Slack.
- General catalog/discovery UX.
- Policy DSL or policy plugin hooks.
- Gateway-level audit/search/export.
- Admin APIs for platform teams.
- Multi-tenant deployment model independent of a single Burble Slack app.

That would be a different product. It would also compete with the gateway
category rather than complementing it.

## Recommendation

Keep the current split:

```text
runtime
  -> agentgateway
  -> Burble provider MCP adapter
  -> Burble provider tools / provider MCP facades
  -> SaaS APIs
```

Position agentgateway as infrastructure and Burble MCP as application policy.

Near-term cleanup:

1. Keep provider tools on MCP for isolated runtimes.
2. Keep `/internal/tools` only for conversation tools and legacy callers until
   it can be narrowed or retired.
3. Move provider-tool metadata to declarative specs.
4. Generate MCP registration, runtime catalogs, name mapping, and validation
   from those specs.
5. If agentgateway starts carrying policy, enforce network topology so runtimes
   cannot bypass it.

