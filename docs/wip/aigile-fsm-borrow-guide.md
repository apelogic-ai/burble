# Borrowing FSM Patterns from aigile

Status: working note for the Burble dev team.
Companion to [agent-runtime-scheduler-boundary-plan.md](../roadmap/agent-runtime-scheduler-boundary-plan.md)
and [burble-native-reference-runtime-design.md](../architecture/burble-native-reference-runtime-design.md).

## Why read this

`~/dev/aigile` is a sibling project (TS/bun monorepo) that drives autonomous
coding tasks (Linear issue → plan → develop → verify → review → merge) through a
**pure, event-sourced FSM**. It has already shipped the durable-FSM shape Burble
is now building for scheduled tasks. The two projects are complementary halves of
the same machine:

- **aigile** = the *macro lifecycle* FSM (one unit of work across many agent
  turns, with retry-as-state, escalation, reconcile). Mature reducer/engine;
  **no typed multi-step plan** — its "plan" is a flat advisory document.
- **Burble** = the *micro typed plan* (`src/workflow/`): a validated, idempotent
  multi-step DAG (provider_call/model/transform/delivery). Strong plan
  validation; but the run-lifecycle reducer only *projects* state, drives
  nothing, and is currently unwired.

So: borrow aigile's *driving* FSM + durability + provenance; we already have the
typed plan it lacks.

## The one thing to take first: a command-emitting reducer

This is the highest-value borrow and the root of several smaller ones.

- **aigile** (`packages/workflow/src/reducer.ts`): the reducer is a pure function
  `transitionWorkflow(snapshot, event, policy) → { snapshot, commands }`. It
  performs **no side effects** — it returns a list of *commands* (e.g.
  `start_developer_attempt`, `run_verification`). A separate driver
  (`packages/workflow/src/engine.ts`) executes each command's handler and feeds
  the resulting *event* back through the reducer. The FSM is the orchestration
  authority.
- **Burble today** (`src/workflow/task-workflow.ts`): the reducer is
  `applyTaskWorkflowEvent(state, event) → state` — a **projection only**. It
  tells you the status; it does not decide what to do next. The imperative
  `src/scheduler/run-executor.ts` decides that, separately, so the FSM observes
  but never drives.

**Action:** reshape `task-workflow.ts` to emit commands
(`{ state, commands }`) and build a driver over it modeled on aigile's
`engine.ts`. Then `run-executor` becomes a thin command-handler host instead of
the orchestrator. This is exactly the "small durable FSM that decides when/how to
invoke the runtime loop" the boundary plan called for.

## Borrow map

| Pattern | aigile reference | Burble target | What to do |
|---|---|---|---|
| **Command-emitting reducer + driver loop** | `packages/workflow/src/reducer.ts`, `engine.ts` | `src/workflow/task-workflow.ts`, `src/scheduler/run-executor.ts` | Reducer returns `{state, commands}`; driver runs handlers, feeds events back. Make the FSM drive. |
| **Substrate-agnostic durable-step bridge** | `packages/restate/src/fsm-executor.ts` (`ctx.run(name, fn)`), `issue-workflow.ts` (`ctx.promise` durable awaits) | the `WorkflowRunner` interface in the boundary plan | Adopt the `ctx.run` interface now with an **in-process** impl; same reducer runs on Restate later with zero reducer changes. aigile proved the reducer stays pure across both. |
| **Artifact-with-provenance** | `packages/types/src/domain.ts` → `RuntimeArtifactProvenance { runtimeId, model, tokenUsage, command, worktreeCheckpoint }` | Sprint 5 usage/audit (no column today) | Record per-run runtime/model/token provenance on each artifact/run. Domain-neutral shape, lift as-is. |
| **Reconcile via event ingestion** | `packages/watch/src/reconcile.ts` | the missing stuck-run reconciler | Import external reality into the event log as events (with a dedup/signal id), then re-drive the FSM. Burble variant: stuck `running` past TTL → append an `attempt_failed` event. aigile does NOT mark-failed imperatively — it ingests an event and lets the reducer decide. |
| **Role → runtime registry + permission firewall** | `packages/roles/src/runner.ts` (role→runtime indirection), `acp-runner.ts` (execution policy; **commits/PRs are the platform's job, never the agent's**) | runtime-profile registry; the "writes go through Burble, not the runtime" boundary | The acp-runner's "agent never commits, the platform does" is the most battle-tested form (1373-line test) of our write-gating boundary. Model the profile registry on `runner.ts`. |
| **Event-sourced run store (interface)** | `packages/workflow/src/run-store.ts` (append-only log, state derived by replay) | `src/db.ts` (Sprint 5 event store) | Take the `EventStore<TEvent,TArtifact>` *shape* (append event, replay to state, list resumable). We supply a better backend (SQLite) than their JSON-file store. |

## What we already have that they don't (don't re-borrow it)

- **Failure-pause circuit breaker** — `task-workflow.ts` already models
  `failureCounts` → `paused_after_failures` → task `needs_repair`. That's the
  circuit breaker the timer is missing; it just needs **wiring**, not building.
- **Trigger idempotency in the reducer** — `applyTaskTriggered` already dedups by
  `triggerKey`. Keep it.
- **`notificationPending`** — already tracks "this failure must notify the user".
- **Typed plan + validation** (`task-workflow-plan.ts`, `template.ts`):
  per-step idempotency keys, template binding/expression validation, `foreach`,
  tool-grant checks. aigile has nothing like this — it's ours to offer them, not
  borrow.

## Caveats — don't over-borrow

- **aigile's Restate integration is thin** (small tests, no deployed serve
  wiring). Borrow the *bridge pattern* (`ctx.run`), not a battle-tested Restate
  setup. We'd mature it together, and only after the in-process runner proves
  insufficient.
- **Their run store is JSON-file/in-memory**, full read-modify-write rewrite, not
  concurrency-safe. Take the interface, not the backend — use our SQLite store.
- **The state/event/command vocabularies don't transfer.** aigile's
  states (plan/develop/verify/review/merge) are coding-domain; ours are
  scheduled-run-domain. Only the *mechanics* (reducer driver, event store,
  durable-step bridge, provenance type, registry) are shareable.
- **No shared package yet.** Burble's reducer is projection-shaped; reshape it to
  command-emitting first by reading aigile as a reference, with no shared
  dependency. Extract a common `fsm-kernel` only once both designs settle —
  pattern-share now, code-share later.

## Concrete next steps for Burble

1. Reshape `task-workflow.ts` to a command-emitting reducer (`{state, commands}`)
   and add a driver engine modeled on aigile `engine.ts`; convert `run-executor`
   into command handlers.
2. Define the `ctx.run`-style durable-step interface; implement it in-process;
   leave Restate as a later swap.
3. Add the provenance fields (runtime id, model, token usage) to the run/artifact
   records (Sprint 5 usage/audit).
4. Wire the already-built `failurePauseThreshold` / `needs_repair` path into the
   timer + run-executor, and add a reconcile pass that ingests stuck-run events
   (aigile `reconcile.ts` shape).

## Files to read (aigile)

- `packages/workflow/src/reducer.ts` — the pure command-emitting reducer (start here)
- `packages/workflow/src/engine.ts` — the driver loop (command → handler → event → reduce)
- `packages/workflow/src/run-store.ts` — append-only event store + replay
- `packages/restate/src/fsm-executor.ts`, `issue-workflow.ts` — substrate-agnostic durable bridge
- `packages/watch/src/reconcile.ts` — external-reality → event ingestion
- `packages/roles/src/runner.ts`, `acp-runner.ts` — role→runtime registry + permission firewall
- `packages/types/src/domain.ts` — artifact-with-provenance and the event/state types
