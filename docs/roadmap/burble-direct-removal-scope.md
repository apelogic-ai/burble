# Scope: Remove `burble-direct` as a first-class runtime

Status: scoped, ready to implement. Companion to
[[runtime-pluggability-next-targets]].

## Decision

Drop `burble-direct` (the in-process, gateway-bypass "low-latency Slack path")
as a user/ops-selectable engine. It is a contract-bypassing special-case that the
future SDK-based **Burble Native Runtime** will supersede properly. Removing it
now simplifies the engine matrix and removes debt the native runtime would
otherwise have to reconcile.

This is a **pure removal** — no new runtime is built here. The native runtime is
a later slice (extract `@burble/runtime-sdk`, then build it on top).

## Why

- **Not a default.** Engine defaults to `openclaw`; `burble-direct` is only
  reached via explicit `AGENT_RUNTIME_ENGINE=burble-direct` (or the
  `direct-provider` alias). Dropping it doesn't touch the common path.
- **Bypasses the contract.** It calls the provider directly instead of going
  through the runtime gateway, so it carries a divergent code path and a
  divergent trust boundary — ~16 references in `openclaw-cli.ts` alone.
- **Placeholder for the real thing.** The owned-code regression-oracle benefit
  (the reason the roadmap liked `burble-direct`) is preserved by building the
  native runtime fresh on the SDK — not by keeping this branch.

## Removal inventory

Counts are non-test references found at scoping time; treat as the checklist.

### Burble control plane (`src/`)
- `src/runtime-engines.ts` (1) — remove `"burble-direct"` from `runtimeEngines`.
  This auto-shrinks `agentRuntimeEngineSchema` (`z.enum(runtimeEngines)`) and the
  `AgentRuntimeEngine` union (re-exported through `db.ts`).
- `src/agent/runtime-descriptors.ts` (4) — remove the `burble-direct` descriptor
  entry. Keep `directRuntimeDefaultImages` (still used by `deterministic`).
- `src/config.ts` (2) — remove the `direct-provider` → `burble-direct` alias.
- `src/db.ts` — no code change needed (`normalizeAgentRuntimeEngine` derives from
  `isAgentRuntimeEngine`), but see **Migration gate**.

### OpenClaw runtime (`runtimes/openclaw-nemoclaw/src/`)
- `openclaw-cli.ts` (~16) — the `engine === "burble-direct"` branches plus the
  direct-provider path: `runBurbleDirectProviderRequest`, `buildDirectModelRequest`,
  `directPlanningSystemPrompt`, and the related logging/error strings.
- `config.ts` (4), `runtime.ts` (3), `types.ts` (1), `server.ts` (1) — engine
  acceptance/validation/branching.

### Deploy
- `deploy/dev/compose/deploy-personal-runtimes.sh` (2) — drop from supported
  engine cases / help text.
- `deploy/dev/README.md` (2) — remove the "low-latency Slack path" section.

### Tests (10 files, update/remove the `burble-direct` cases)
`tests/slack.test.ts`, `tests/config.test.ts`,
`tests/runtimes/openclaw-nemoclaw/{openclaw-cli,gateway,config,runtime,setup}.test.ts`,
`tests/agent/{runtime-descriptors,runtime-factory}.test.ts`,
`tests/e2e/runtime-readiness.test.ts`.

### Docs/assets (update where they describe it as a *current* option)
`docs/openclaw-runtime-flows.md` (+ `burble-direct-flow.svg`,
`engine-routing-overview.svg`), `runtimes/openclaw-nemoclaw/README.md`. Leave
historical plan/notes docs as-is unless they read as current capability.

## Migration gate (the one real risk)

`burble-direct` is a persisted `AgentRuntimeEngine` value (the `agent_runtimes`
`engine` column and scheduled-job `runtimeType`). After it leaves the enum,
existing rows fail validation. **Before deleting:**

1. Check for any persisted/pinned use — DB rows or prod/staging env with
   `engine=burble-direct` (or a workspace selection).
2. If found, migrate those records to `openclaw` (or `deterministic`) first.
3. Only then remove from the enum.

If nothing is pinned (expected, given it's a documented dev path), this is a
straight removal with no data migration.

## Non-goals

- Not building `@burble/runtime-sdk` or the native runtime (separate slices).
- No change to `openclaw`, `openclaw-gateway`, `hermes`, or `deterministic`.
- No streaming/contract behavior changes.

## Naming note

Do **not** resurrect the name `burble-direct` for the future native runtime — use
a fresh slot (`burble-native` or similar) so the first-class SDK runtime isn't
conflated with the in-process branch removed here.

## PR shape

One PR: remove the enum value + descriptor + alias + the runtime branches +
direct-provider path + deploy/docs, and update tests in the same change (it's all
engine-gated, so a half-removal has little value). Gate the merge on the
migration check above.
