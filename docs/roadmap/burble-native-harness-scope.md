# Scope: Evolve Burble Native into a thin turn-executor harness

Status: implemented through scheduled provider calls and current-turn
attachments; deployment hardening and boundary verification are active.
Companion to [[runtime-pluggability-next-targets]] and
[[burble-direct-removal-scope]]. For the broader rationale that `burble-native`
should be Burble's contract oracle / reference runtime, see
[burble-native-reference-runtime-design.md](../architecture/burble-native-reference-runtime-design.md).

## Decision

Grow `burble-native` from a contract-conformant **skeleton** into Burble's own
**lean per-turn execution harness** — model call + tool loop + streaming + usage
— built on `@burble/runtime-sdk`. This is **option A** (a thin turn executor),
**not** a full agent framework. It is the correctly-built successor to the
in-process `burble-direct` path we removed.

Production `burble-native` runs inside OpenShell. Docker-backed startup remains
useful for local development, test harnesses, and compatibility, but the target
is an OpenShell-isolated runtime service with Burble owning product state and
policy outside the sandbox.

## The boundary (the rule that keeps A from becoming B)

The harness owns **only per-turn execution**. Everything heavy stays in Burble's
control plane, shared by all runtimes.

| Harness owns (per turn) | Control plane owns (NOT the runtime) |
|---|---|
| Provider/model call | The timer / scheduler (`nativeScheduler` stays **false** forever) |
| Burble tool-gateway loop | Conversation memory (Burble injects `recentMessages`; runtime is stateless per turn) |
| Token streaming + usage | Durable workflow state |
| Tool_call-vs-prose handling | Identity, auth, policy, visibility |

**Anti-scope-creep rule:** any time you're tempted to add a *store*, a *timer*, or
*cross-turn state* inside the runtime — stop. That belongs in the control plane.
The runtime stays stateless per turn.

## Capability → manifest → selection graduation

Build a capability, conformance-test it, **then** flip its manifest field (server
**and** descriptor, in sync), **then** it becomes selectable for the matching
workload. Never flip a field ahead of the implementation.

- **Increment 0 (done):** boots, conforms, honest minimal manifest, gated out of
  full workloads by policy
  (`reasons: ["missing tool calls", "missing scheduled provider calls"]`).
- **Increment 1 (done):** call the model directly, stream real token deltas,
  report exact usage. → `streaming`/`usageReporting` are genuinely backed.
- **Increment 2 (done):** on a model-requested `burble_provider_call`, hit the
  tool gateway (`createRuntimeToolGatewayClient`, runtime auth), feed the result
  back, loop to final. → `toolCalls` is real.
- **Increment 3 (done) — scheduled provider calls:** execute a Burble-fired scheduled
  turn (`scheduledJob` context, job-scoped auth). → flip
  `scheduledProviderCalls: true` → selectable for scheduled workloads. (Note:
  `nativeScheduler` still stays `false` — Burble fires the timer, the runtime just
  executes the turn.)
- **Attachment fetch (done):** current-turn opaque attachment references are
  fetched through `conversation.getAttachment`; `attachments: true` is backed by
  unit and contract-probe coverage.
- **Later, only if worth it:** `multimodalInput`. `memory: true`
  would mean "surfaces Burble-injected memory context," never an in-runtime store.
  `durableWorkflowState` stays control-plane.

## Reuse from the SDK (build thin, not new)

- `createRuntimeContractServer` — already wired (surfaces, fanout, run lifecycle).
- `createRuntimeToolGatewayClient` + `buildRuntimeBearerHeaders` — the tool loop.
- `parseRuntimeRunRequest` / contract event vocab — validation, single-sourced.
- Streaming semantics: `message_delta` (append) vs `message_replace` (set), and the
  tool_call-vs-prose gate — reuse, don't reinvent. Slack-side throttle/render stays
  in the app, not the runtime.

## SDK publish mode

`@burble/runtime-sdk` is intentionally **monorepo-only** for now:

- runtimes in this repo consume it through the Bun workspace package;
- Docker images copy the package from the repo build context;
- the generated JSON Schema remains the stable cross-language artifact for
  Hermes and the conformance runner.

Do **not** add npm publishing, a `dist/` build, or separate-repo compatibility
until the first runtime outside this monorepo needs it. When that happens, the
publishable package must expose built JavaScript/types and keep the JSON Schema
artifact versioned with the SDK.

## Lessons baked in as constraints (don't re-debug OpenClaw)

- **Per-turn ephemeral session.** Hold no cross-turn state; Burble injects context
  each turn. (Avoids the OpenClaw session-accumulation → compaction thrash.)
- **No bootstrap/onboarding/identity flow** in the runtime. (Avoids the
  BOOTSTRAP.md loop.)
- **No in-runtime compaction or scheduler.** Context budget and timing are the
  control plane's. (Avoids the per-turn compaction tax and cron↔interactive
  contention.)
- **Usage exact from the provider,** including `input_tokens_details.cached_tokens`,
  so cached-token reporting works.
- **Streaming gated for tool_call vs prose** before emitting to the user.

## Definition of done (per increment)

1. Capability implemented + unit tests.
2. Boot-smoke E2E (already exercises the run contract) green; graduate to the full
   readiness/conformance gate once it's a full runtime.
3. Manifest field flipped to `true` in **both** the server and the descriptor.
4. Selection-policy test updated: runtime becomes selectable for the matching
   workload class; honest-manifest test still passes.

## Non-goals

- Not building memory / scheduler / durability **into** the runtime (control plane).
- Not matching OpenClaw feature-for-feature; OpenClaw/Hermes stay for what isn't
  worth reimplementing. Pluggability means you don't have to.
- Not a multi-agent / orchestration framework. If it starts growing one, that's
  option B — out of scope.

## Notes / observations (parked, not roadmap)

### Data layer lock-in (`bun:sqlite`) — escape cost is async, not dialect

We use Bun's built-in `bun:sqlite` directly (`src/db.ts`, `src/workflow/task-workflow-sqlite-store.ts`, the shadow DB in `src/slack.ts`) — no ORM, no DB dependency in `package.json`. Triple lock-in: Bun runtime, SQLite-only, **synchronous API**.

If/when we want an external DB (Postgres) or to introduce Drizzle, the real cost is **not** Drizzle and **not** the SQL dialect — it's the synchronous→asynchronous flip:

- `db.ts` is one ~3070-line `createTokenStore()` factory with ~67 methods, all synchronous; **0** store calls are `await`ed anywhere. Every external driver (pg, Drizzle's pg/mysql/libsql) is async, so async-ifying ripples transitively through every caller (scheduler loops, run-executor, FSM driver, maintenance/oracle loops, MCP providers).
- The dangerous part: much of the code's safety reasoning is *"bun:sqlite is single-threaded + synchronous, so calls can't interleave"* (e.g. claim-then-shadow-write, no `busy_timeout`/WAL, two handles to one file). Async **dissolves that invariant** — real interleaving, lost-update races, explicit transactions/locks needed. Every "safe because sync" spot must be re-audited.
- Dialect is small/mechanical (~25 SQLite-isms: `ON CONFLICT` ~13×, `PRAGMA user_version`/`table_info` migrations, `AUTOINCREMENT`, `INSERT OR IGNORE`, `RETURNING`; no JSON1). This is exactly what Drizzle abstracts well. Drizzle does **not** solve async — its bun-sqlite driver is sync, but pg/mysql/libsql are async.

Positives in current shape: callers already depend on narrow `Pick<TokenStore, …>` slices (11 sites) — a clean seam. The workflow store (`TaskWorkflowEventStore` interface + in-memory **and** sqlite backends) is the **template** for what `db.ts` should look like.

De-risked sequence if we ever do it (separate the axes; don't do Drizzle+Postgres+async in one change):
1. Extract a hand-declared `TokenStore` interface (replace the `ReturnType<>` inference) — nothing to implement against today.
2. Make the interface **async while the impl stays `bun:sqlite`** — pay the async-ripple tax once, decoupled from the swap, behavior still on SQLite so we can diff; re-audit the sync-safety assumptions here.
3. Split the monolith into per-aggregate repos behind the interface.
4. Introduce Drizzle on SQLite first (validate parity), then add a Postgres adapter.

ROI caveat: justified if we need Postgres for HA / scale / multi-region; thin if it's only lock-in aversion (`bun:sqlite` is fast + zero-ops). A cheap hedge is steps 1–2 alone — breaks the hard part of the lock-in without committing to Drizzle or an external DB.
