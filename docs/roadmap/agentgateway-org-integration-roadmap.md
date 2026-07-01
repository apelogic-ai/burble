# MCP gateway org integration — roadmap

Status: plan (parked, not committed to product roadmap)
Date: 2026-07-01
Track: MCP GW

## Goal

Integrate Burble with an org-wide **standalone MCP gateway** (the tool/MCP + A2A data
plane, analogous to how the inference gateway is the org-wide *model* data plane).
Deduplicate edge functions between Burble and the gateway **without losing Burble's
edge**: any authorization Burble can do more granularly than the gateway stays in
Burble. **agentgateway is a reference implementation, not a requirement.**

In this model Burble is simultaneously **(a) one MCP backend** behind the gateway
(its Slack-identity + per-user provider brokering + scheduled-job capabilities are
consumable by any org agent, incl. enterprise Claude) and **(b) one client** of the
gateway (its own runtimes dogfood the same plane).

## Portability principle (un-opinionated integration)

Burble must not lock onto a specific gateway product. agentgateway is the first
adapter; the integration is built against **standards**, with **ports** where no
standard exists.

- **Data plane is standard — depend on the protocol, not the product.** Tools go over
  **MCP**; authorization over the **MCP OAuth protected-resource spec**
  (`.well-known/oauth-protected-resource`, JWT bearer, JWKS); identity over
  **OIDC/JWKS**. Any conformant gateway is a drop-in. `mcpAuthentication` in
  agentgateway is just one implementation of that spec.
- **The lock-in is the control plane** — inbound identity verification and per-user
  token brokering have no single standard. Put narrow **ports** there:

  | Port (Burble depends on this) | Reference adapter | Default / null adapter |
  |---|---|---|
  | `InboundIdentityVerifier` — verify the caller's identity | gateway JWT via JWKS (OIDC) | **Burble-native shared secret** (today) |
  | `UserTokenBroker` — `identity × provider → upstream token` | external token-exchange service | **Burble's own connection store** (today) |

- **Burble must run with zero gateway** — the native/self adapters are the defaults,
  so the product is self-contained; the gateway is additive.
- **Vendor gateway config lives in the deployment, not in Burble.** agentgateway's
  `config.yaml` (routing, policy, federation) belongs to ops. Burble knows only base
  URLs + the port APIs.
- **Conformance suite** — each port's contract is defined by tests every adapter must
  pass, so "un-opinionated" stays honest.

## Delineation rule

> A function moves to the gateway only if it is decidable **without Burble's data**.
> Anything that needs Burble's user↔connection graph or stored policy stays in Burble.

- **Gateway (edge / PEP):** client authN (one org identity), MCP federation &
  discovery across many servers, coarse RBAC + guardrails + egress, rate-limit /
  quota, unified audit + cost.
- **Burble (authority / PDP — the edge we keep):** per-user credential injection,
  and the granular, data-dependent authorization the gateway cannot express —
  visibility policies, destination grants, per-user connection scoping,
  private-read-source rules, scheduled-job authority.

## Today's state (baseline)

- agentgateway is wired only as an **optional dev-compose override** (`--agentgateway`,
  `docker-compose.agentgateway.yml`), not in ansible/prod. It's a thin JWT-validating
  reverse proxy: `mcpAuthentication` (issuer=burble-app, JWKS) + CORS + path routing
  to `burble-app` `/mcp/*`, `backendAuth: passthrough`. ~20–30% of its capability.
- **Dual runtime auth exists:** runtime JWT (`src/runtime-jwt.ts`, validated by the
  gateway for MCP) **and** a shared-secret bearer token (`isRuntimeTokenValid`,
  `runtime.authTokenHash`) guarding `/internal/tools`. Same identity, two schemes —
  i.e. the `InboundIdentityVerifier` port already has two implicit implementations
  that should be unified behind it.

## The decision hinge

How far dedup can go depends on whether the gateway is **optional** or **mandatory**:

- **While optional (today):** Burble must stay self-sufficient (native identity +
  self-authz) — the gateway may not be in the path. Dedup is limited to *not
  re-implementing Burble's authority in the gateway config* (already satisfied).
  Phase A only.
- **Once mandatory (prod ingress):** collapse the parallel auth behind the
  `InboundIdentityVerifier` port, push edge concerns into the gateway, thin Burble's
  front door. Phase B.

## Deferred fork (resolved by the `UserTokenBroker` port)

Does Burble's per-user connection store become the **shared org token-broker** (so any
org agent can call GitHub-as-user), or does a separate token-exchange service own that
with Burble as one consumer? The port makes this swappable; pick the adapter once the
org identity model from `llm-user-scoped-keys-roadmap.md` is settled — likely a
dedicated token-exchange adapter rather than gateway config.

## Roadmap (PR slices)

### Phase A — no dependency on the gateway being mandatory

#### PR 1 — Delineation + inventory (ADR)
- Record the delineation + portability rules; inventory current `tool-gateway.ts`
  functions and classify keep / move / defer. Enumerate the dual-auth surfaces as the
  two implicit `InboundIdentityVerifier` implementations.
- **Acceptance:** ADR merged; each responsibility tagged.

#### PR 2 — `InboundIdentityVerifier` port (flag, additive)
- Extract inbound auth behind the port. Ship two adapters: `native` (shared secret,
  **default**) and `gateway-jwt` (verify via `verifyRuntimeJwt` / JWKS). Selectable by
  flag; native stays the fallback.
- Add the port conformance suite.
- **Acceptance:** both adapters pass the suite; default `native` ⇒ unchanged behavior.

#### PR 3 — MCP surface as first-class (federation-ready, protocol-only)
- Make Burble's `/mcp/*` cleanly consumable by *any* org agent, not just Burble
  runtimes: stable tool naming/namespacing, MCP discovery + resource metadata, and an
  auth contract stated purely in MCP-OAuth/OIDC terms (no agentgateway-specific
  assumptions).
- **Acceptance:** a non-Burble MCP client lists + calls tools through the gateway
  using an org identity; no vendor-specific config in Burble.

### Phase B — gated on the gateway becoming a mandatory ingress

#### PR 4 — Collapse dual auth via the port
- Default the `InboundIdentityVerifier` to `gateway-jwt`; deprecate/remove the
  shared-secret adapter once the migration completes. Single org identity end-to-end.
- **Acceptance:** one credential end-to-end; native adapter removed behind a completed
  migration.

#### PR 5 — Push coarse RBAC/guardrails to the gateway
- Move static allow/deny + guardrails + egress to gateway policy as the enforcement
  point; keep Burble's data-dependent authz as the authoritative source (gateway RBAC
  is defense-in-depth, never a second source of truth).
- **Acceptance:** coarse denials at the gateway; granular denials still enforced by
  Burble; single allow/deny source of truth documented.

#### PR 6 — `UserTokenBroker` port + federation + unified observability
- Extract per-user upstream token brokering behind the `UserTokenBroker` port
  (`connection-store` adapter = today; `token-exchange` adapter = shared service).
  Register Burble MCP behind the gateway alongside other org MCP servers; wire unified
  audit / quota / cost (paired with the LLM GW trace).
- **Acceptance:** broker adapters pass the conformance suite; Burble tools appear in
  the federated catalog; per-consumer quota + per-user audit visible across tool +
  model planes.

## Test posture

- Phase A changes ship flag-gated, default preserving today's behavior.
- The **port conformance suites** (`InboundIdentityVerifier`, `UserTokenBroker`) are
  the contracts; every adapter must pass.
- Keep Burble runnable **without** any gateway until Phase B completes.

Related: [[openshell-strategic-direction]]; companion track in
`llm-user-scoped-keys-roadmap.md`.
