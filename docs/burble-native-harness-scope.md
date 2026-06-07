# Scope: Evolve Burble Native into a thin turn-executor harness

Status: incremental; Increment 1 is the current implementation target.
Companion to [[runtime-pluggability-next-targets]] and
[[burble-direct-removal-scope]].

## Decision

Grow `burble-native` from a contract-conformant **skeleton** into Burble's own
**lean per-turn execution harness** — model call + tool loop + streaming + usage
— built on `@burble/runtime-sdk`. This is **option A** (a thin turn executor),
**not** a full agent framework. It is the correctly-built successor to the
in-process `burble-direct` path we removed.

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
- **Increment 1 — real single-turn provider call:** call the model directly,
  stream real token deltas, report exact usage. → `streaming`/`usageReporting`
  become genuinely backed. Still gated out of scheduled workloads. Now a real
  (basic) chat runtime.
- **Increment 2 — Burble tool loop:** on a tool call, hit the tool gateway
  (`createRuntimeToolGatewayClient`, runtime JWT), feed the result back, loop to
  final. → `toolCalls` becomes real.
- **Increment 3 — scheduled provider calls:** execute a Burble-fired scheduled
  turn (`scheduledJob` context, job-scoped auth). → flip
  `scheduledProviderCalls: true` → selectable for scheduled workloads. (Note:
  `nativeScheduler` still stays `false` — Burble fires the timer, the runtime just
  executes the turn.)
- **Later, only if worth it:** `attachments`, `multimodalInput`. `memory: true`
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
