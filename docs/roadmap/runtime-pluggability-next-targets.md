# Runtime Pluggability: Next Targets

Status: working thoughts. Companion to [agent-runtime-contract-notes.md](../architecture/agent-runtime-contract-notes.md)
and [runtime-contract-implementation-roadmap.md](runtime-contract-implementation-roadmap.md).

We introduced pluggable runtimes via a contract and now run OpenClaw and Hermes
behind it. The next question is how we add more runtimes through the same
contract — and which one to target next.

## TL;DR

The plumbing is roughly 80% ready for any HTTP-contract runtime, but adding one
today still means editing ~5 hardcoded per-engine sites, not dropping in a
plugin. The highest-leverage next move is **not** another third-party framework.
It is making the **Burble Native Runtime (`burble-native`) real on top of an
extracted `@burble/runtime-sdk`**. That both:

- turns the runtime "registry" from hardcoded switches into something additive, and
- gives us the lean, fast-cold-start, enterprise-isolation-friendly runtime that
  the cost argument below points at.

Only after that should the first external target be the **OpenAI Agents SDK**
(lightest, most contract-shaped). LangGraph / Temporal / AutoGen are deferred
until there is a durable-job contract.

## What "supporting a runtime via the contract" actually requires

The contract is small and already language-neutral — OpenClaw (Bun/TS) and Hermes
(Python/aiohttp) prove it. A runtime is a container that:

1. Implements four client-facing surfaces — `GET /capabilities`, `GET /healthz`,
   `POST /runs` (async), `GET /runs/:id/events` (WebSocket / SSE / NDJSON) —
   matching `RuntimeContractClient` (`src/agent/runtime-contract-harness.ts`).
2. Speaks the fixed event vocabulary:
   `status | message_delta | tool_call | tool_result | usage | heartbeat | final | error`
   (`src/agent/runtime-contract.ts`).
3. Calls back into Burble's tool gateway (`/internal/tools/:tool/execute`) and/or
   MCP gateway with runtime-scoped / job-scoped JWTs — never touching raw provider
   OAuth (`src/tool-gateway.ts`, `src/runtime-jwt.ts`).
4. Publishes an honest capability manifest (`src/agent/runtime-contract.ts`).

That is the whole boundary. The trust model — Burble owns identity, auth, policy,
and visibility; the runtime is a replaceable execution worker — is what makes
pluggability real instead of cosmetic.

## Is the plumbing ready? Green / yellow / red

### Green — ready

- Shared Zod schemas for run request, run events, final response, usage, and
  capability manifest.
- HTTP + WebSocket client with capability discovery, runtime-type mismatch
  protection, and 404/405 back-compat
  (`src/agent/runtime-contract-http-client.ts`, `src/agent/runners/managed-runtime.ts`).
- Executable smoke harness: manifest → health → run → events → final → usage
  (`src/agent/runtime-contract-harness.ts`).
- Reverse channel: tool gateway + MCP gateway + job-scoped runtime JWTs.
- Docker provisioning with health-poll and idle-reap
  (`src/agent/container-runtime-factory.ts`).

### Yellow — works, but hardcoded per-engine (every new runtime edits these)

- **Closed engine enum** `agentRuntimeEngineSchema` (`src/agent/runtime-contract.ts`),
  referenced from config, policy, and the factory.
- **Hardcoded manifests** in `src/agent/runtime-policy.ts` — `knownRuntimeCapabilityManifest`
  is a chain of `engine === "openclaw" || ...` booleans; a new engine falls
  through to the hermes-shaped default.
- **Per-engine env blocks** in `src/agent/container-runtime-factory.ts`
  (`if (engine !== "hermes")` … `if (engine === "hermes")`), plus a hardcoded
  `/data/openclaw` mount and a per-engine config filename via
  `nativeAgentConfigFileName`.
- **Image map** `defaultAgentRuntimeImages` in `src/config.ts`.
- **Per-runtime server boilerplate is hand-rolled twice already** (TS for
  OpenClaw, Python for Hermes). A third runtime is a third hand-roll of routing,
  WebSocket framing, the event vocabulary, the tool-gateway client, and JWT handling.

### Red — genuinely missing for some candidates

- No `@burble/runtime-sdk` package — the thing that would make adapters thin.
- No **durable job / state contract** beyond single-shot `/runs`
  (`scheduledJobContext` rides inside `/runs`). LangGraph / Temporal want
  checkpointing, retries, and resume — they would strain the current contract.
- No generic **capability-assertion conformance** beyond the smoke contract. The
  image-level runner validates protocol shape; it should also exercise claimed
  capabilities before external runtimes are selectable.

Net: ready for a lean HTTP runtime we control; not yet a true drop-in plugin
registry; not yet ready for durability-heavy frameworks.

## The cost argument for enterprise, isolated runtimes

Established frameworks were designed as personal agents. Their cost in our model
is concrete and is **multiplied per isolated tenant container**:

- **Cold start and image size.** We already track this
  (`runtime-cold-start-timing-analysis.md`, `openclaw-startup-optimization-plan.md`),
  so startup is a live pain. Heavy Python dependency trees (LangChain, AutoGen)
  make per-tenant cold start worse.
- **Resident memory footprint.** Every isolated runtime pays the framework's
  baseline RAM, times N tenants.
- **Opinion conflict.** These frameworks ship their own memory, tool-auth,
  orchestration, and cloud tracing. In Burble's model that is either dead weight
  or actively fighting the control plane — their tracing wants to phone home,
  their tool layer wants raw credentials.
- **Supply-chain / CVE surface.** A large transitive dependency tree per tenant
  is an enterprise audit liability.

The frameworks that look most attractive as personal agents are exactly the ones
whose value-add — memory, orchestration, durability, observability — we have
deliberately hoisted into Burble. We would import their weight and use a fraction
of it.

## Scheduling and autonomous workflows

A natural worry is whether candidate runtimes can run cron / scheduled tasks and
autonomous recurring workflows. They differ, but the conclusion is that
**scheduling should not drive the runtime choice**, because Burble already owns
it.

- **Burble owns the timer.** Cron jobs are already supported, `scheduledJobContext`
  is part of the run contract, and `nativeScheduler` is an *optional* capability
  flag (`src/agent/runtime-contract.ts`). The committed model is "native
  schedulers may own timer execution, but Burble owns the authority envelope."
  Burble can drive any scheduled turn itself by firing `POST /runs` with a
  `scheduledJob` context on its own timer, leaving the runtime stateless per turn.

- **OpenAI Agents SDK — no native scheduler.** `Runner.run()` is a single
  agent-loop invocation (tool calls, handoffs, guardrails, sessions, tracing);
  there is no built-in cron or durable long-running execution. Their canonical
  production answer for durability/scheduling is to bring an external layer
  (Temporal `OpenAIAgentsPlugin`, or Dapr). For Burble this is a *feature*: the
  runtime brings no scheduler, Burble drives the timer, nothing to reconcile.
  Autonomous workflows exist in the orchestration sense (multi-agent loops,
  handoffs), not as autonomous scheduled execution.

- **Mastra — native scheduler + durable workflows, with a host cost.** Workflows
  take a `schedule` field with cron expressions (multiple cadences), plus durable
  snapshots (pause/resume) and a Temporal integration. But the built-in scheduler
  is a polling loop that requires a long-lived host process and a concurrent-safe
  storage adapter (`@mastra/libsql`); on serverless it does not fire and must be
  swapped for `@mastra/inngest`. In a per-tenant isolated container that is a
  second scheduler and a second state store overlapping Burble's — exactly the
  personal-agent tax this doc warns about, now as a reconciliation problem.

So scheduling does not favor Mastra. It reinforces the ranking: a lean,
stateless runtime with Burble-owned scheduling first. Both frameworks point at
the same gap on our side — the moment we want the *runtime* to own durable,
resumable, retryable scheduled execution, both reach for Temporal. That is the
"durable job / state contract" item in the red section, and it is the precondition
for the LangGraph / Temporal class of runtimes.

## Which to target next — ranked

### 1. Burble Native Runtime (`burble-native`) + extract `@burble/runtime-sdk` — do this next

- It is the **regression oracle**. If the contract cannot host a runtime we fully
  control, the contract is leaking framework assumptions (already called out in
  `agent-runtime-contract-notes.md`).
- It is the **lowest-cost, fastest-cold-start, smallest-image** runtime — it
  directly answers the enterprise-isolation cost concern.
- Building it **forces the SDK extraction**, which is the real unlock: it turns
  the yellow hardcoded sites into a registered descriptor plus a thin adapter,
  and makes every future runtime a small image instead of a third boilerplate
  hand-roll.
- It de-risks: we prove the contract on owned code before importing anyone's
  framework.

### 2. OpenAI Agents SDK — first external "bring your own runtime" proof

- Lightest and most contract-shaped of the named options: tool calls, handoffs,
  partial streaming, tracing. Crucially unopinionated about identity, memory, and
  orchestration, so it does not fight Burble.
- Small image, available in both TS and Python (we have proven both transports).
- Best marketing proof of swappable runtimes with the least plumbing strain.

### 3. Mastra — second external, if TS code-sharing wins

- Attractive because Burble is Bun/TS and we could share tool schemas, but it is
  more framework than SDK. Revisit after the native runtime defines what a thin
  adapter looks like.

### Defer: LangGraph, Temporal / Restate, AutoGen

These are durability / orchestration layers, not the part we are missing for chat
turns. They are worth it only after a durable job / state contract exists — and at
that point Temporal-as-durability-under-a-thin-agent-loop is more interesting than
LangGraph-as-the-brain. We should not pay their cost to run single-shot turns.

## Suggested sequencing

Each slice is independently shippable.

1. **Open the registry.** Replace the per-engine `if (engine === …)` sites with a
   data-driven runtime descriptor (manifest + env-builder + image + config
   filename) keyed by engine. Removes the yellow friction; behavior-neutral for
   OpenClaw and Hermes.
2. **Extract `@burble/runtime-sdk`** (TS first): schemas, auth header helpers,
   `/runs` + WebSocket server helper, tool-gateway client, MCP client, smoke
   harness. Retrofit OpenClaw onto it to prove it.
3. **Ship the Burble Native Runtime** on the SDK as the reference image and the
   conformance oracle in CI.
4. **OpenAI Agents SDK runtime** as a thin adapter on the SDK — the first true
   third-party.
5. Only then revisit a **durable job contract** to unlock the LangGraph / Temporal
   class.

## Open questions

- Should the runtime descriptor live in config/data or in code, given that
  manifest, env-builder, and image selection currently sit in three files?
- Does the Burble Native Runtime share the OpenClaw image base, or start from a
  minimal Bun image to win on cold start?
- Should the SDK ship a reference native runtime, or only protocol helpers (see
  the same open question in `agent-runtime-contract-notes.md`)?
- What is the minimum conformance set a third-party runtime must pass before a
  workspace can select it?
