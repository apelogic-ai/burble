# LLM user-scoped keys — roadmap

Status: plan (parked, not committed to product roadmap)
Date: 2026-07-01
Track: LLM GW (inference gateway)

## Goal

Transition Burble's LLM gateway auth from a **single static service-level key** to
**per-user scoped keys** retrieved/provisioned from an org key-distribution service
via an M2M integration (long-lived JWT for now).

The point of user-scoped keys is per-user attribution, budgets, rate limits, and
audit at the LLM gateway. Burble must present the *right user's* key on every model
call so attribution is correct end-to-end.

## Portability principle (un-opinionated integration)

Burble is a product; it must not lock onto a specific gateway (LiteLLM is a
*reference adapter*, not a requirement).

- **Data plane is already standard — depend on the protocol, not the product.**
  Model calls go over the **OpenAI-compatible wire API** (`createOpenAICompatible`,
  `providers.ts:51`). Any conformant endpoint (LiteLLM, vLLM, cloud proxies, …) is a
  drop-in behind a base URL. No product name should appear in the code path
  (today `createOpenAICompatible({ name: "litellm" })` bakes one in — rename to
  `inference-gateway`).
- **The lock-in is the control plane** — key provisioning has no standard. Put a
  **narrow port** there with pluggable adapters:

  `LlmKeyProvider`: `resolve(identity) → { apiKey, expiresAt? }`

  | Adapter | Role |
  |---|---|
  | `static` | **default / null adapter** — reads the current env key; needs nothing external |
  | `self-service` | org key-distribution service (M2M, long-lived JWT) |
  | *(future)* `litellm` | LiteLLM key-management API, if ever needed |

- **Burble must run with zero gateway control plane** — the `static` adapter is the
  default and keeps the product self-contained.
- **Capability-named config, not product-named** — `LLM_KEY_SERVICE_URL`, not
  `LITELLM_KEY_URL`. Vendor-specific gateway config lives in the deployment, never
  in Burble.
- **Conformance suite** — the port contract is defined by tests every adapter must
  pass, so "un-opinionated" stays honest rather than encoding one vendor's quirks.

## Constraints / non-goals

- **Flag-gated.** Default = the `static` adapter, today's behavior unchanged
  byte-for-byte. Flip per environment when ready.
- Long-lived JWT M2M for now (short-lived/rotating tokens are later).
- Not building our own key store/rotation — we consume whatever adapter is selected.
- No change to model selection (`AI_MODEL`) or the OpenAI-compatible base-URL contract.

## Current seam (where the single key lives today)

- `src/agent/providers.ts:54` — `createDirectModelResolver()` builds the inference
  client **once at startup** with `readInferenceGatewayApiKey()` and reuses it for
  all users. Single-key chokepoint for the direct / ai-sdk path.
- `burble-runtime` mode has a **second** injection point: the provisioned runtime
  calls the inference gateway itself, so the key is bound into the runtime's
  inference config at provision time (runtime factory). Both seams must go through
  the `LlmKeyProvider` port.
- `getSlackEmail` (`src/slack.ts:347`) maps Slack user → email — the bridge to org
  identity.

## Open decisions (lock before PR 3)

- **D1 — identity source.** Is `getSlackEmail` → email the key the org service keys
  on, or does it want an SSO subject / UPN? (Shapes the identity mapper / port input.)
- **D2 — key handling.** Cache-only (re-fetch on expiry) vs. persisted-encrypted.
  Default lean: in-memory cache, no secret at rest.
- **D3 — failure policy when flag ON.** Fail-closed for that user vs. fall back to
  the `static` key. Default lean: fail-closed (attribution > uptime), configurable.

## Roadmap (PR slices)

Each PR is independently mergeable; the `static` adapter keeps default behavior
until PR 6.

### PR 1 — `LlmKeyProvider` port + `static` adapter + de-brand (no-op)
- Define the `LlmKeyProvider` port. Ship the `static` adapter (returns the env key).
- Route `createDirectModelResolver` and the runtime inference injection through the
  port. Rename `createOpenAICompatible({ name: "litellm" })` → `inference-gateway`.
- Add `LLM_KEY_PROVIDER` (default `static`) + service config keys
  (`LLM_KEY_SERVICE_URL`, `LLM_KEY_SERVICE_JWT_PATH`, `LLM_KEY_SERVICE_AUDIENCE`,
  `LLM_KEY_CACHE_TTL_MS`).
- **Acceptance:** provider defaults to `static` ⇒ identical behavior; no product name
  in the code path; deploy-config test covers the new env plumbing (`.env.example`,
  compose, ansible).

### PR 2 — `self-service` adapter (M2M) + conformance suite
- Implement the org key-service adapter: long-lived JWT M2M auth,
  `resolve(identity) → { apiKey, expiresAt? }`, timeouts, bounded retries, typed error
  taxonomy (auth vs. not-found vs. transient). In-memory per-user cache with TTL;
  refresh hook on upstream 401.
- Add the **port conformance test suite**; run it against both `static` and
  `self-service`.
- **Acceptance:** adapter passes the conformance suite against a mocked key service;
  no live org dependency in CI.

### PR 3 — Identity mapping
- `resolveOrgIdentity(slackUserId)` = `getSlackEmail` → org identity, behind a single
  swappable seam (D1). Handle missing-email explicitly.
- **Acceptance:** mapping tests incl. the users:read.email-missing error path.

### PR 4 — Direct / ai-sdk injection (interactive runs)
- Make the `ModelResolver` per-user: resolve the key via the port keyed by the
  requesting user's identity at model-resolution time, not construction time. Wire
  the mention and DM paths (they already fetch email).
- **Acceptance:** two users → two distinct keys reach the gateway; `static` unchanged;
  key-service outage exercises D3 policy.

### PR 5 — Runtime injection (burble-runtime mode)
- Inject the **run owner's** key (via the port) into the provisioned runtime's
  inference config/env at provision time, keyed by identity, not a service key.
- **Acceptance:** provisioned runtime env carries the per-user key; `static` fallback
  when the provider is `static`; owner identity flows through admission/build input.

### PR 6 — Scheduled runs + flip
- Scheduled runs resolve the **job owner's** key (not the triggerer) via
  `buildScheduledRunAgentInput` owner identity.
- Lifecycle hardening: end-to-end refresh-on-401, D3 wired, per-user attribution
  surfaced in run status/audit, docs. Enable `self-service` in a canary env.
- **Acceptance:** scheduled run uses owner key; canary shows correct per-user
  attribution at the gateway; deploy-config green.

## Test posture

- Every PR proves the `static` (default) path unchanged.
- The **port conformance suite** is the contract; every adapter must pass it.
- Mock the key service at the adapter boundary; no live org dependency in CI.
- Verify both injection seams (direct resolver + runtime provision) independently.

Related: [[openshell-strategic-direction]]; companion track in
`agentgateway-org-integration-roadmap.md`.
