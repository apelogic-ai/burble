# Plan: Generalize the providers/tools edge

Status: working plan. Companion to [[runtime-pluggability-next-targets]]. Applies
the **same recipe** that generalized the runtime edge (single-sourced contract →
registry → conformance → thin adapters) to the **provider/tool edge**.

## Frame

Burble is a control-plane core (identity, auth, policy, memory, scheduling,
visibility, routing) with pluggable edges. The **runtime** edge is generalized.
The **provider/tool** edge is the next one, and it's at the stage runtimes were
*before* the descriptor registry:

- **Already good (don't rebuild):** tools are declarative. `ProviderToolSpec`
  (`src/providers/tool-specs.ts`) carries provider/name/alias(es)/implementation/
  risk/confirmation/input-schema, partly YAML-authored, aggregated in
  `providerToolCatalog` and flowed to runtimes via `manifest.tools`. The tool
  *definition* is largely single-sourced.
- **The gap:** the **provider itself is hardcoded** — adding a provider means
  editing ~8 site-classes (below). There is no provider registry; the provider
  set is a literal union repeated in many files.

## Current state — what adding a provider touches today

| Site | File(s) | What's hardcoded |
|---|---|---|
| Provider union (canonical) | `src/db.ts:23` `Provider = "github"\|"jira"\|...` + per-provider branches (`:1078`,`:1111`) | the set |
| Tool-gateway routing/authz | `src/tool-gateway.ts:1464,1479` (union) `:443` (branch) | the set + routing |
| Slack connect UI | `src/slack.ts` (~10 sites: status `:2169`, actions `:1079/1132`, command parse `:1923/4077`, union `:4637`, usage text `:2200`) | connect buttons, status, "connect X" parsing |
| Request/connection types | `src/server.ts:98` | the set |
| OAuth callback config | `src/config.ts:284` (`/oauth/<provider>/callback`) | per-provider OAuth wiring |
| Tool catalog aggregation | `src/providers/catalog.ts` | hand-imported/spread per provider |
| Connection model | `src/db.ts` (`getConnection`, `ProviderConnection`) | provider-keyed branches |
| Scopes | per-provider (the recurring HubSpot-scope churn) | scope lists per provider |

## Confirmed since (PRs #39–#45): the *tool-bridge* tax is the bigger cost

The provider-set hardcoding above is real, but live feature work surfaced a
second, **higher-frequency** tax the original framing under-weighted: every new
*tool* must be hand-wired through multiple **bridge surfaces** — and it hits per
*tool*, not per provider.

Adding one tool today touches:

| Bridge surface | File |
|---|---|
| HTTP tool gateway (routing/authz) | `src/tool-gateway.ts` |
| App MCP handler (+ server deps) | `src/mcp/provider-google.ts`, `src/mcp/provider-server.ts` |
| Direct AI-SDK tools | `src/agent/runner.ts` |
| Tool implementation | `src/tools/google.ts` |
| OpenClaw executor `switch` + MCP mapping | `runtimes/openclaw-nemoclaw/src/burble-tools.ts`, `openclaw-cli.ts` |
| Hermes tool hints | `runtimes/nemo-hermes/runtime/entrypoint.py` |
| Slack + tool-groups + yaml | `src/slack.ts`, `src/agent/tool-groups.ts`, `tools.yaml` |

Evidence: #39 wired Google read tools into the *app* bridges but **missed the
runtime bridges → #40 was a whole second PR** to reach OpenClaw/Hermes; #44 and #45
each touched ~8 surfaces to add a few tools. A tool present in one bridge and
missing from another is also a silent drift bug (works under `tool_gateway` mode,
404s under MCP) — the #37/#38 class.

**`burble-native` is the proof of the fix.** It needed *zero* per-tool wiring in
any of those PRs because it is **catalog-driven** — one generic
`burble_provider_call` + the tool list from `manifest.tools` (derived from the
spec). OpenClaw and Hermes carry the per-tool tax precisely because their bridges
are hand-wired, not catalog-derived.

**Slice-0 already landed (#45):** Hermes's Google tool hints are now *generated
from the provider spec* (`runtime/google-provider-tool-hints.json`) with a drift
guard — the first spec-derived bridge. The phase is to extend that pattern to all
providers × all bridges, and to fold in two spec fields the recent fixes proved
are needed (input coercion, idempotency — see increments).

## Target — a provider descriptor registry (the runtime-registry move)

One source per provider; everything above **derives** from it.

```
ProviderDescriptor = {
  id, displayName, usageBlurb,
  toolSpecs,                       // already exists per provider
  oauth: { scopes, optionalScopes, callbackPath, authorizeUrl, ... },
  defaultRisk, connection: { ... },
  capabilities,                    // provider-level (see below)
}
```

- `Provider` union, `providerToolCatalog`, tool-gateway routing, the Slack connect
  UI, and OAuth callback config all derive from the registry (mirror how
  `runtimeEngines`/`runtimeDescriptor` now drive the engine side).
- The per-provider **client** stays bespoke (each API is idiosyncratic) — only its
  *registration/config* becomes declarative. Generalize the seams, not the API
  glue.

## Increments (behavior-neutral first, like the runtime registry)

1. **Open the provider registry (behavior-neutral).** Introduce
   `providerDescriptors` + `providerDescriptor(id)`; derive the `Provider` union,
   `providerToolCatalog`, and tool-gateway provider routing from it. No behavior
   change for the 6 existing providers; removes the catalog hand-aggregation and
   the repeated unions.
2. **Fold OAuth/scope config into the descriptor.** Per-provider scopes,
   optional-scopes, and callback paths become descriptor fields; `config.ts`
   derives callbacks. The HubSpot-scope-churn class becomes a one-line descriptor
   edit instead of touching OAuth wiring + UI + config.
3. **Derive the Slack connect surface from the registry.** Connect buttons,
   connection-status rendering, and "connect X" command parsing read
   `displayName`/`usageBlurb` from descriptors — kills the ~10 `slack.ts` sites.
4. **Provider capability/scope conformance.** Assert a *connected* provider
   actually holds the scopes/tools it declares (the #35 capability-assertion
   pattern applied to providers), behind a **real OAuth/scope boundary test**, not
   a mock (the #37/#38 lesson — providers have the identical "real auth path fails
   while the mock passes" exposure). Unify provider scopes into the capability/gate
   model so runtime capabilities, provider scopes, and feature entitlements share
   one gate+assert engine.
5. **(Defer) Extract `@burble/provider-sdk`.** Only if providers ever live outside
   the monorepo or third parties author them (same YAGNI bar that gated the runtime
   SDK). The descriptor + tool-spec schema + OAuth helpers + gateway-client
   contract are the package surface when that day comes.

## Increments — tool-bridge derivation (the higher-frequency win)

These attack the per-tool tax above. `burble-native` is the reference; the goal is
"add a tool = edit the spec, nothing else."

- **B0. Spec-derived Hermes hints — DONE (#45, Google only).** Extend the
  generated-with-drift-guard pattern (`google-provider-tool-hints.json`) to **all
  providers**.
- **B1. Make the OpenClaw bridge catalog-derived.** Replace the per-tool `switch`
  in `burble-tools.ts` and the alias/input mapping in `openclaw-cli.ts` with
  dispatch/mapping derived from the catalog (`manifest.tools`), like native. Adding
  a tool then needs no OpenClaw edit.
- **B2. Spec-driven input coercion.** Replace the per-tool hand-written normalizers
  (#45's `normalizeGoogleSlidesCreateSlideInput`, …) with one coercion to the tool
  spec's declared input schema. Stops the normalizers from *growing* the per-tool
  tax they were meant to relieve.
- **B3. `idempotent` / `retrySafe` as a tool-spec field.** Replace #45's hardcoded
  `nonIdempotentToolVerbs` name-heuristic with a declared per-tool property driving
  retry-safety (like `risk`/`confirmation` already are). A new mutating tool whose
  name lacks a listed verb is otherwise silently retry-unsafe.
- **B4. Reachability conformance.** Assert **every cataloged tool is executable
  through every bridge mode the runtime declares** (would have caught #39→#40).
  This is the tool analog of the runtime capability-assertion and overlaps
  [[real-boundary-test-layer-plan]] guard #3.

**Drift-guard everything spec-derived.** Each generated artifact (Hermes hints,
OpenClaw mappings, the JSON Schema) gets a CI guard that it matches the spec —
the pattern proven by #45's hints guard and the runtime-contract schema guard.

## Running order

1. **Pre-req (not generalization): replace the in-band cursor sentinel.** Four
   patches (#41–#43) prove the strip-the-symptom approach can't converge; do this
   before the refactor so it stops re-leaking through new render paths.
   *(Write-idempotency, the other pre-req, already landed in #45.)*
2. **Provider registry** (increments 1–3) — behavior-neutral; collapses the
   provider-set sites.
3. **Tool-bridge derivation** (B0–B4) — the higher-frequency win; B0 is partly done.
4. **Provider capability/scope conformance** (increment 4) + B4 reachability.
5. **Real-boundary test layer** ([[real-boundary-test-layer-plan]]) in parallel —
   cassettes, per-runtime render e2e, provider preflight.

## Tools — refine the one spec, don't build a new system

`ProviderToolSpec` is already the source. The only tool-side work is making it the
*sole* source for **every** consumer — catalog, gateway authz, policy gating,
runtime `manifest.tools`, and the Slack UI — and verifying nothing re-declares a
tool's schema/risk/scope elsewhere (the drift class). No new tool framework.

## The recipe reused + discipline

- Same recipe as the runtime edge: **single-sourced descriptor → derived
  consumers → conformance → thin adapters.** This is reuse, not new architecture.
- Apply the three hard-won lessons: **single-source to kill drift**, **conformance
  to enforce honesty** (a provider that claims a scope must have it), **real-
  boundary integration tests, not mocks**.
- Don't over-generalize: the per-provider API client stays bespoke; don't extract
  the SDK speculatively; don't touch channels (a separate edge, gated on
  multi-channel being real).

## Migration / back-compat

- `Provider` is a **persisted** value (stored connections). The registry *derives*
  the union, so adding providers is additive/safe; removing one is the
  `burble-direct`-class migration (migrate/retire stored connections first) and
  should be rare.
- Increment 1 is behavior-neutral; later increments are additive (scopes/UI/
  conformance) — no data migration unless a provider is removed.

## Non-goals

- Not rebuilding the tool spec (already declarative) or the per-provider API
  clients (idiosyncratic by nature).
- Not extracting a provider SDK until an out-of-monorepo/third-party provider needs
  it.
- Not generalizing channels (Slack) — different edge, different trigger.

## One-line summary

Two taxes: a **provider descriptor registry** collapses the ~8 hardcoded
provider-set sites, and **catalog-derived tool bridges** (the win `burble-native`
already proves) end the per-tool wiring through OpenClaw/Hermes/MCP/AI-SDK that #39–#45
kept paying. Fold in two spec fields the recent fixes proved necessary
(input-schema coercion, `idempotent`), drift-guard every generated artifact, and add
reachability + scope/capability conformance so neither a tool nor a provider can
claim access it doesn't actually have — the runtime-edge recipe applied to the
provider/tool edge, sequenced after the one remaining pre-req (replace the cursor
sentinel).
