# Burble Native Reference Runtime Design

Status: draft / design note.
Companion to [burble-native-harness-scope.md](burble-native-harness-scope.md),
[agent-runtime-scheduler-boundary-plan.md](agent-runtime-scheduler-boundary-plan.md),
and [runtime-pluggability-next-targets.md](runtime-pluggability-next-targets.md).

## Purpose

As Burble moves timed jobs, one-time job definitions, execution records,
delivery, memory policy, provider authorization, and audit into the control
plane, runtimes are becoming simpler. Their core job is no longer to be a
personal orchestrator. Their core job is to execute a bounded agentic turn:

```text
Burble chat or job executor
  -> runtime /runs request
  -> model/tool loop
  -> Burble tool gateway or MCP gateway
  -> final proposed answer
  -> Burble validation, persistence, and delivery
```

That raises the design question: instead of continuously stripping OpenClaw and
Hermes down into this shape, should Burble own a purpose-built runtime that
embodies the contract directly?

The recommendation is yes. Build a **Burble-native reference runtime** as the
contract oracle. Keep OpenClaw and Hermes as compatibility/adaptation targets,
not as the place where Burble discovers its product boundary.

## Decision

Burble should treat `burble-native` as the first-class reference runtime for the
control-plane-owned architecture.

The reference runtime should be:

- small enough to run isolated instances per principal and runtime profile;
- boring enough to be the default conformance target;
- strict enough to expose contract leaks quickly;
- free of native scheduling, provider credentials, Slack delivery, or durable
  product state;
- compatible with either a direct Responses API loop or a constrained OpenAI
  Agents SDK loop.

In production, `burble-native` runs inside OpenShell. Docker-backed direct
runtime provisioning remains useful for local development, test harnesses, and
compatibility, but it is not the target production isolation model.

OpenClaw and Hermes remain useful, but they should conform to the Burble runtime
contract. They should not define that contract.

## Why Now

OpenClaw and Hermes are powerful personal-agent orchestrators. Their value is in
owning more of the world: scheduler behavior, local state, memory, tool routing,
delivery conventions, prompts, and framework-specific recovery paths.

Burble is intentionally moving those responsibilities out of runtimes:

- scheduled jobs become Burble records and Burble-triggered runs;
- provider access goes through Burble-owned credentials and scoped runtime
  tokens;
- Slack delivery and visibility policy stay in Burble;
- memory is selected and injected by Burble, not granted by runtime-local files;
- audit and usage accounting are centralized.

That makes a heavy orchestrator valuable for specialized profiles, but awkward
as the common runtime path. A Burble-native runtime lets the product boundary be
designed once, tested directly, and then applied to external runtimes.

## User Runtime Relationship

The runtime relationship should be explicit and profile-scoped:

```text
principal
  -> runtime profile
  -> runtime instance
```

For user-owned agents, the principal is currently `(workspace_id, user_id)`.
Later, the same model can represent team, workgroup, or company agents with a
different principal type.

A user may have many runtimes, but they should not be an unstructured pile of
containers. They should be selected through named runtime profiles, for example:

```text
default-assistant       -> burble-native
scheduled-job-executor  -> burble-native
coding-workspace        -> OpenClaw or Hermes
experimental-runtime    -> opt-in engine/version
```

The control-plane invariant should be:

```text
at most one active/warm runtime instance per
principal + runtime_profile + engine + state_generation
```

Jobs and conversations should bind to a runtime profile, not to an incidental
container or sandbox id. The concrete runtime instance can be stopped, replaced,
or upgraded as long as the profile binding and durable state contract are
preserved.

Separate profiles may have separate data roots, capability manifests, resource
limits, model defaults, and OpenShell policies. That gives one user a normal
assistant runtime and a heavier coding/runtime workspace without letting state
or authority bleed between them.

## Ownership Boundary

### Burble Owns

- chat routing and route identity;
- runtime profile selection and runtime instance lifecycle;
- scheduled job CRUD, trigger state, run records, retries, and status;
- provider OAuth credentials and refresh;
- tool catalog, tool policy, risk classification, and confirmations;
- skill catalog, skill approval, skill version selection, and user/workspace
  skill enablement;
- job-scoped and runtime-scoped auth tokens;
- memory source of truth, retention policy, and injected memory context;
- workspace/user configuration and effective runtime manifests;
- output visibility, declassification, and delivery;
- observability, audit, usage accounting, and runtime lifecycle.

### Runtime Owns

- interpreting the supplied task;
- calling the selected model;
- choosing from the declared tool surface;
- executing a structured tool loop through Burble-controlled gateways;
- consuming Burble-supplied skill instructions/assets and memory snippets for
  the current run;
- bounded retry when the model violates the tool/final-output contract;
- producing progress events and a final proposed answer;
- reporting provider usage and runtime-level diagnostics.

### Runtime Must Not Own

- native cron/timers for Burble jobs;
- durable job definitions or job status;
- Slack channel IDs as authority;
- raw provider tokens;
- tool allow/deny policy;
- skill approval or version authority;
- durable memory authority;
- public/private posting decisions;
- cross-user state;
- product audit history.

## Skills, Memory, And Tools

Skills, memory, and tools should be Burble-owned product surfaces. The runtime
receives resolved, scoped context for a run.

## Tasks, Jobs, And Tool Selection

Scheduled work should split into two concepts:

```text
Task = reusable work definition
Job  = one execution of a task, triggered manually or by a timer
```

A Task is closer to a Burble-owned skill capsule than a loose prompt. It is the
thing the user wants done, not the timer and not the delivery route. It should
carry:

- the user-facing objective;
- multimodal input parts, including text and attachment/file references;
- the selected runtime profile;
- the required provider/product tools;
- task-local tool constraints or argument templates;
- selected skill/plugin references and resolved skill instructions;
- durable state references;
- schedule definition, when the task is recurring;
- output contract and delivery policy;
- visibility and authorization policy.

A Job is an execution record for that Task. A timer fire creates a Job. A manual
"test run this task" creates a Job. The same Task can therefore run on demand or
on a schedule without changing the authority model.

This distinction matters because a runtime should not rediscover low-level
provider wiring from scratch on every scheduled fire. If a Task says "check open
PRs in the `apelogic-ai` GitHub org" and Burble has resolved that into
`github_search_issues` with an `org:apelogic-ai is:pr is:open` query shape, then
the runtime's agency is to interpret and summarize the result, not to choose
between personal PR tools and org-wide search tools.

The long-term shape is:

```text
Task spec + current runtime profile + trigger
  -> Job run envelope
  -> runtime gets a constrained task-local tool surface
  -> model/tool loop
  -> Burble validates every tool call against the Task grant
  -> final proposed answer
```

The task-local tool surface may expose higher-level aliases, for example
`check_open_prs()`, while Burble maps that alias to the concrete provider tool
and argument template. That keeps the model's useful judgment on the content of
the run, not on reconstructing Burble's product wiring.

### Distilled Runtime Lessons

The current OpenClaw and Hermes adapters already have useful pieces of the
future shape:

- `/runs` accepts `input.text`, `input.attachments`, `input.scheduledJob`,
  selected tool groups, conversation context, and provider connection summaries;
- both runtimes expose scheduled-job control tools through local Burble MCP or
  provider-bridge plugins;
- both runtimes inject scheduled-job context into the model prompt so the model
  can see `jobId`, `allowedTools`, `routeId`, `stateRefs`, and visibility
  policy;
- both runtimes can fetch current-turn attachments through a Burble
  conversation attachment tool instead of receiving raw Slack file URLs.

The gap is that `scheduledJob` is currently a grant/runtime context, not a Task
spec. Its schema contains job identity, allowed tools, route, state refs, and
visibility. It does not contain the Task objective, schedule, delivery contract,
input parts, selected skills, or task-local tool aliases/templates.

That gap is exactly what caused the heart-emoji failure mode: creation text such
as "every 15 min, to this channel" leaked into the durable executable prompt, so
the scheduled run looked like another scheduling request instead of the actual
work. The fix is structural:

```text
Task spec
  objective: "Post exactly this message: ❤️"
  schedule:  "*/15 * * * *" in UTC
  delivery:  conversation route convrt_...
  tools:     conversation.sendMessage or equivalent route delivery grant

Job run
  trigger:   schedule | manual
  taskId:    job_...
  input:     objective + multimodal parts
  context:   grant-only scheduledJob context
```

Do not encode schedule cadence or Slack delivery wording inside the executable
task text. The runtime may see them as structured context, but the model's
primary instruction for the run should be the Task objective.

Task prompt parity should match ordinary user turns. If a user can ask Burble
with text plus files, a Task should be able to persist text plus file/capability
references and replay them into a later run. Those references must be durable
Burble capabilities, not raw Slack URLs or runtime-local file paths. At run
time, Burble resolves them into the same attachment/tool surfaces a chat turn
would receive.

The target split is:

```ts
type TaskSpec = {
  taskId: string;
  title: string;
  objective: string;
  inputParts: Array<
    | { type: "text"; text: string }
    | { type: "attachment_ref"; attachmentId: string; purpose?: string }
    | { type: "state_ref"; provider: string; kind: string; id?: string }
  >;
  schedule?: {
    kind: "cron";
    expression: string;
    timezone: string;
  };
  runtimeProfile: string;
  toolContracts: Array<{
    alias: string;
    providerTool: string;
    required: boolean;
    inputTemplate?: Record<string, unknown>;
  }>;
  skillRefs?: Array<{
    id: string;
    version: string;
  }>;
  delivery?: {
    routeId: string;
    visibilityDefault: "public" | "user_private" | "restricted";
  };
  visibilityPolicy: {
    maxOutputVisibility?: "public" | "user_private" | "restricted";
    allowPrivateToolDeclassification?: boolean;
  };
};
```

The existing `scheduledJob` run context should remain grant-focused:

```text
jobId, allowedTools, routeId, stateRefs, visibilityPolicy
```

Task details belong beside it in the Burble-owned run envelope, not inside that
grant object and not buried in natural-language prompt suffixes.

### Recoverable Tool Errors

Not every tool failure should terminate the run. A model selecting the wrong
tool is different from a Task carrying the wrong grant.

Runtime-visible, recoverable errors should be fed back into the agent loop as
structured tool results/errors:

```json
{
  "code": "tool_not_allowed_for_task",
  "requestedTool": "github_list_my_pull_requests",
  "allowedTools": ["github_search_issues"],
  "hint": "This task is for org-wide open PR search. Use the allowed GitHub search tool."
}
```

The runtime may retry the model loop a small bounded number of times. If the
model corrects itself, the run continues normally. If it repeats the violation,
Burble records a terminal contract failure with the structured reason.

Task-spec errors are handled differently. If the Task objective requires a tool
that is not granted, or the stored argument template is invalid, retrying the
model is not the fix. Burble should expose inspection and repair surfaces:

- `show task <id>`: objective, schedule, runtime profile, delivery, grants,
  state refs, and recent runs;
- `validate task <id>`: static intent-vs-grant checks and required-tool
  analysis;
- `repair task <id>`: proposed spec/grant/template changes;
- `test task <id> --dry-run`: validation without provider side effects;
- `update task <id> ...`: explicit user-approved spec edits.

This preserves the useful agentic loop without making Burble catch every phrase
permutation with regexes or silently rewriting low-level tool calls in the
control plane.

### Skills

Burble owns:

- global and workspace skill catalogs;
- source allowlists and signature/trust policy;
- approved versions;
- workspace enablement;
- user enablement within workspace policy.

The runtime may receive:

- selected skill instructions;
- selected skill assets;
- tool-use guidance from enabled skills.

A skill can guide behavior, but it cannot grant tools or bypass policy. Runtime
containers may cache skill files for performance, but cache contents are not the
source of truth.

### Memory

Burble owns durable memory:

- user memory;
- workspace memory;
- job memory;
- retention and deletion policy;
- memory read/write authorization.

The runtime may receive selected memory snippets in the run envelope and may
propose memory writes as structured output or tool calls. Burble validates and
stores accepted writes. Runtime-local memory is scratch/session cache unless a
future runtime profile deliberately grants a separate memory authority.

### Tools

Tools split into two groups:

```text
provider/product tools -> Burble tool gateway or MCP gateway
sandbox-local tools    -> OpenShell sandbox policy
```

Provider/product tools execute through Burble-controlled gateways with scoped
runtime or job credentials. They do not live in the runtime with raw provider
OAuth tokens.

Sandbox-local tools may run inside OpenShell when the runtime profile grants the
needed filesystem, process, or network policy. They are still bounded by the
profile's capability manifest and OpenShell policy.

## Runtime Shape

The reference runtime should expose the same HTTP contract as other managed
runtimes:

```text
GET  /healthz
GET  /capabilities
POST /runs
GET  /runs/:id/events
```

The implementation can use the existing runtime contract server/helper layer
where possible.

Production `burble-native` should run as an OpenShell sandbox workload:

```text
Burble control plane
  -> OpenShell sandbox
  -> burble-native runtime HTTP service
```

The preferred production launch model is an image entrypoint service exposed by
OpenShell, not a long-lived service started through an `ExecSandbox` shim.
Burble should pass runtime profile, manifest, and gateway credentials as
environment/config input, then reach the runtime through the exposed service.

## Canonical Run Envelope

The useful contract pressure is in the `/runs` envelope. Burble should make the
runtime's context explicit enough that no runtime needs hidden channel,
scheduler, or provider assumptions.

Proposed shape:

```ts
type BurbleRuntimeRunRequest = {
  runId: string;
  kind: "chat" | "scheduled_job" | "manual_job_trigger";
  principal: {
    workspaceId: string;
    slackUserId: string;
  };
  runtimeProfile: {
    id: string;
    engine: "burble-native" | "openclaw" | "hermes";
    stateGeneration: string;
  };
  route?: {
    routeId: string;
    transport: "slack";
    visibilityDefault: "public" | "user_private" | "restricted";
  };
  conversation?: {
    channelId?: string;
    threadTs?: string;
    messageTs?: string;
    isDirectMessage: boolean;
    recentMessages?: Array<{
      role: "user" | "assistant";
      text: string;
      at?: string;
    }>;
  };
  job?: {
    jobId: string;
    runId: string;
    title: string;
    body: string;
    trigger: "schedule" | "manual";
    allowedTools: string[];
    stateRefs?: Array<{
      id: string;
      provider: string;
      description?: string;
    }>;
  };
  input: {
    text: string;
  };
  manifest: RuntimeManifest;
  skills?: Array<{
    id: string;
    version: string;
    instructions?: string;
    assetRefs?: string[];
  }>;
  memory?: {
    enabled: boolean;
    snippets: Array<{
      id: string;
      text: string;
      source: "user" | "workspace" | "job";
    }>;
  };
  gateways: {
    toolGatewayUrl: string;
    mcpGatewayUrl?: string;
    bearerToken: string;
  };
};
```

This does not need to land exactly as written. Its purpose is to make the
boundary testable: any state the runtime needs should be named, scoped, and
supplied by Burble.

## Event Model

The runtime should stream the existing Burble run-event vocabulary, with
conformance tests focused on behavior rather than framework internals.

Minimum event semantics:

```ts
type ReferenceRuntimeEvent =
  | { type: "status"; status: "started" | "running" }
  | { type: "message_delta"; text: string }
  | { type: "tool_call"; callId: string; toolName: string; input: unknown }
  | { type: "tool_result"; callId: string; toolName: string; output: unknown }
  | {
      type: "tool_error";
      callId: string;
      toolName: string;
      error: RuntimeToolError;
    }
  | { type: "usage"; usage: RuntimeUsage }
  | { type: "final"; response: RuntimeFinalResponse }
  | { type: "error"; message: string; retryable: boolean };
```

Rules:

- Do not emit user-visible prose until the runtime knows the model is not
  trying to call a tool.
- Every tool call gets exactly one terminal result event or one terminal error.
- Recoverable tool errors are returned to the model loop, not thrown past it, up
  to a bounded retry count.
- Final output is a proposal. Burble still decides whether and where to post it.
- Tool-call protocol leakage in final prose is a contract violation.

## Implementation Options

### Option A: Direct Responses API Loop

Burble-native owns the loop directly:

1. call the model with instructions, context, and tool schemas;
2. detect tool calls;
3. call Burble's tool gateway or MCP gateway;
4. append tool results or recoverable tool errors;
5. continue until final output or `max_turns`.

This is the thinnest implementation and gives Burble maximum control over event
mapping, retry policy, usage accounting, and contract strictness.

Use this if the priority is minimal runtime surface area.

### Option B: Constrained OpenAI Agents SDK Runtime

Burble-native uses OpenAI Agents SDK as the internal agent loop, but wraps it in
the same Burble HTTP contract.

The SDK is a good fit for model/tool loops, guardrails, sessions, MCP tool
integration, and tracing. The constraint is that Burble-native must not expose
SDK-native scheduling, identity, provider credential, memory, or delivery
authority as product authority.

Use this if the priority is quickly getting a robust agent loop, tool handling,
guardrails, and tracing while still keeping Burble as the control plane.

### Recommendation

Start with the smallest path that can pass the full Burble conformance suite. If
the direct loop stays simple, keep it. If retry/guardrail/tracing complexity
starts growing, move the internal loop to OpenAI Agents SDK behind the same
contract.

The runtime contract should not reveal which option was chosen.

References:

- OpenAI Agents SDK overview: https://openai.github.io/openai-agents-python/
- Agents SDK running agents: https://openai.github.io/openai-agents-python/running_agents/
- Agents SDK guardrails: https://openai.github.io/openai-agents-python/guardrails/

## Capabilities

Initial reference-runtime capability target:

```ts
{
  runtimeType: "burble-native",
  streaming: true,
  toolCalls: true,
  scheduledProviderCalls: true,
  nativeScheduler: false,
  memory: false,
  durableWorkflowState: false,
  attachments: false
}
```

Interpretation:

- `scheduledProviderCalls: true` means "can execute a Burble-fired scheduled-job
  run envelope with job-scoped tools." It does not mean the runtime owns a
  scheduler.
- `memory: false` means no runtime-owned memory store. The runtime may consume
  Burble-injected memory snippets.
- `durableWorkflowState: false` means retry/resume state belongs to Burble.

## Persistent Data

The reference runtime should minimize local durable data.

Allowed per-runtime mounted data:

- transient engine config generated from the effective manifest;
- optional model/session cache if it is safe to discard;
- workspace scratch files when a task explicitly needs them;
- logs and diagnostics.

Not allowed:

- job definitions;
- provider credentials;
- durable memory source of truth;
- Slack route authority;
- global tool policy.

Because production `burble-native` runs inside OpenShell, durable product state
must not depend on sandbox-local files unless OpenShell provides an explicit
durable volume or snapshot contract that Burble records and manages. The default
assumption is that sandbox-local files are disposable. Burble-owned data remains
in Burble's database and object/state stores; runtime files are generated,
cached, or scratch data.

This makes runtime image upgrades less risky. The data that must survive an
upgrade remains in Burble's database or in clearly scoped runtime data
directories.

## Conformance Role

`burble-native` should be the conformance oracle:

- new runtime contract fields are first proven in `burble-native`;
- OpenClaw and Hermes are considered conforming only when they match the same
  behavior;
- runtime-selection policy should prefer the reference runtime for baseline
  chat and scheduled-job workloads;
- external runtimes cannot claim a capability until the conformance suite
  exercises that capability.

Minimum conformance tests:

- health and capability discovery;
- chat run reaches a final response;
- streaming emits valid event order;
- one logical tool call produces one Burble gateway execution;
- denied tool calls fail closed;
- scheduled-job envelope preserves `jobId`;
- job-scoped credentials cannot be reused outside the job;
- final output visibility classification is present;
- protocol leakage is rejected;
- usage accounting is emitted when the model provider returns usage.

## Relationship To OpenClaw And Hermes

OpenClaw and Hermes should remain supported, but their role changes:

- they are adapters to Burble's runtime contract;
- they may provide richer profiles for coding, workspace-heavy, or specialized
  autonomous tasks;
- they should not own Burble scheduler state, provider auth, Slack delivery, or
  policy;
- adapter work should be prioritized by customer/runtime value, not by the need
  to make Burble's core path work.

This avoids making Burble's architecture depend on successfully suppressing
features in heavier orchestrators.

## Sequencing

1. Declare `burble-native` as the reference runtime in docs and capability
   planning.
2. Model runtime selection as principal + runtime profile + engine +
   state generation.
3. Lock the canonical `/runs` envelope for chat and Burble-fired scheduled-job
   runs.
4. Package production `burble-native` as an OpenShell entrypoint-service
   workload.
5. Finish the tool loop and scheduled-job execution path in `burble-native`.
6. Add Task/Job inspection and validation for scheduled work.
7. Add capability-level conformance tests and make claimed capabilities gated by
   those tests.
8. Make OpenClaw and Hermes conform to the same tests where their claimed
   capabilities overlap.
9. Decide whether the internal loop remains direct Responses API code or moves
   behind OpenAI Agents SDK.
10. Revisit heavier runtime profiles only after the reference path is boring.

## Open Questions

- Should Burble-native use a direct Responses API loop first, or start directly
  on OpenAI Agents SDK?
- Should `kind` be enough to distinguish chat, scheduled job, and manual job
  trigger, or should each have a separate envelope variant?
- How much of the runtime event server belongs in `@burble/runtime-sdk` versus
  only in the reference runtime?
- What is the minimum capability conformance suite required before a runtime can
  be selected by a workspace admin?
- What durable-volume or snapshot guarantees, if any, should Burble require from
  OpenShell before allowing runtime-local state to survive upgrades?

## Execution Plan: Finishing The Current Scheduler PR

The current `codex/scheduler-control-plane` branch already lands the right
boundary: one control plane invoked by both the deterministic Slack router and
the runtime tool-gateway, app-side executors retired, Burble-owned runtime
selection, job-scoped provider auth. What it ships today is a control plane with
a **status-flag run model, not a durable run lifecycle**. The PR does not need to
become the full durable core, but it must stop being able to lose runs or report
false success, and it must not paint the envelope into a non-profile corner.

Scope the PR to the slice below. Anything marked _deferred_ is a deliberate,
tracked follow-up (a Sprint, not a silent gap), not part of this PR.

Do not add new app-side provider executors or low-level tool-name remapping to
finish this PR. The acceptable close-out state is strict enforcement, truthful
terminal status, bounded retry where the runtime already supports it, and clear
telemetry. The Task/Job capsule and recoverable tool-error loop belong to the
reference-runtime work below, where they can be tested as first-class behavior.

### P0 — Block merge (correctness)

0. **Make scheduler NL resolution the scheduler front door.** Scheduler CRUD must
   route through a Burble-owned semantic resolver and validated control-plane
   command before any agent runtime sees the message. The resolver may use an LLM,
   but its output is constrained JSON: intent, confidence, selected task/job id,
   and for create/update a validated spec with title, executable prompt,
   schedule, and delivery target. If it recognizes scheduler CRUD but cannot
   produce a complete spec, Burble asks for clarification or rejects the request;
   it must not fall through to Hermes/OpenClaw native scheduler behavior. This is
   the fix for prompts like "create new task to send heart emoji to this channel
   every 30 min" being handled by Hermes as an internal cron job.
1. **Stop reporting false success.** A suppressed/progress-only runtime result is
   currently recorded `status: "succeeded"` while delivering nothing
   (`src/scheduler/run-executor.ts`). Record a terminal `failed` (or a distinct
   `no_output` terminal state) and a failure reason so "did the run finish?" tells
   the truth and the user is notified.
2. **Make manual trigger idempotent.** `triggerJob` mints a fresh run with no
   dedup (`src/scheduler/control-plane.ts`). Return/attach to an existing active
   run for the job instead of creating a second; a double-click or retry must not
   double-execute or double-deliver.
3. **Reconcile stuck runs.** A crashed executor leaves a run `running` forever;
   `listQueuedAgentJobRuns` is written but has zero callers (`src/db.ts`). Wire a
   reconciliation pass that transitions runs stuck past a real heartbeat TTL to
   `failed`, and drains orphaned `queued` runs on startup. This is the minimum
   durability floor; full event sourcing is deferred to Sprint 5.
4. **Tighten the contract guardrail matchers.** `/^Calling /i` and `/^Agent is /i`
   in `src/agent/runtime-control-notices.ts` hard-fail legitimate one-line answers.
   Anchor/narrow them (require real protocol context) and prefer strip-and-salvage
   over failing the whole run on one suspect line.

### P0 — Block merge (forward-compatibility, cheap)

5. **Make the run envelope a subset of the canonical `BurbleRuntimeRunRequest`.**
   Align `src/agent/scheduled-job-context.ts` field names to this doc's envelope
   (`kind`, a `runtimeProfile` block — `engine`-only for now is fine, plus a
   placeholder `id`/`stateGeneration`), so it grows into the canonical shape
   instead of being renamed in Sprint 1. Reference jobs by something
   profile-ready, not a bare `engine` string where a profile id will go.
6. **Keep skills and memory entirely out of this PR.** They are owned surfaces in
   this design but are not prerequisites for the scheduler reference path.

### P1 — Should land before merge (observability + maintainability)

7. **Emit terminal telemetry on every job-scoping 403.** The denials in
   `validateAndStripScheduledJobToolGatewayInput` (`src/tool-gateway.ts`) return
   without a `tool.gateway.failed` event, so blocked-attempt telemetry — the exact
   security signal the boundary plan calls for — is missing. Route all 403 paths
   through `emitToolGatewayFailedBestEffort`.
8. **Collapse the duplicated detectors.** De-dup `isRuntimeProviderProgressMarker`
   (defined in both `managed-runtime.ts` and `slack.ts`) and the three-way
   control-notice handling (assert-throw / slack-strip / executor-suppress) behind
   one shared helper with a single "is this a deliverable final?" policy. Move the
   Hermes-specific `cronjob:` regex out of the "neutral" `runtime-text-protocol.ts`.
9. **Wire the scheduler in the composition root.** The timer/control-plane/executor
   are constructed inside `createSlackRuntime`; the timer is started but never
   returned and never stopped on shutdown. Surface the timer handle and stop it in
   `index.ts` shutdown (await the in-flight tick), matching the runtime reaper.

### P0 — The invariant test (block merge)

10. **Add the "one logical tool call = one provider execution" test.** This is the
    regression class the entire pivot exists to prevent and it is currently
    asserted nowhere. Land it against the existing fake gateway now, with an
    explicit TODO to re-home it against `burble-native` in Sprint 3. Also add
    "scheduler list does not invoke the LLM" if not already covered for every
    deterministic command, and "trigger does not invoke the LLM unless the job body
    requires it."

### Deferred out of this PR (tracked, not silent)

- Event-sourced run store and bounded retry-as-state → **Sprint 5**.
- Task/Job separation, task-local tool aliases/templates, and task validation →
  **Sprint 1/Sprint 2**.
- Recoverable `tool_not_allowed_for_task` feedback into the model loop →
  **Sprint 2/Sprint 3**.
- Native-runtime job migration / `needs_repair` → **Sprint 5**.
- Usage/audit recording on scheduled runs (no column today) → **Sprint 5**.
- Orchestrator decomposition (presenters out of `orchestrator.ts`) →
  fast-follow cleanup, not blocking. The scheduler NL classifier itself is P0
  because it is the control-plane boundary, not presentation cleanup.
- Gateway-IP allowlist → config (`openShellHostAllowedIps` hardcoded) → **Sprint 2**
  (folds into OpenShell packaging).
- Cron/calendar schedules (interval-only today) → backlog.

**PR exit criteria:** a scheduled run either delivers output or records a terminal
failure; manual trigger is idempotent; stuck runs are reconciled; legitimate
short answers are not rejected by the guardrail; the run envelope is
canonical-shaped; one logical tool call provably hits a provider once.

## Sprint Plan: Reference Runtime And Profiles

Each sprint is independently shippable and gated by testable exit criteria. The
ordering follows this doc's Sequencing section and assumes the PR above has
landed. Skills and memory are explicitly out of scope until Sprint 6+.

### Sprint 1 — Lock the contract: canonical envelope + profile model

Goal: make the boundary a typed, tested contract before building a new runtime
against it.

Slices:

- **1a. Canonical `/runs` envelope.** Promote `BurbleRuntimeRunRequest` to the
  shared runtime-sdk type. Make the existing scheduled-job context and the chat
  path both emit it. One envelope with `kind`; optional `job`/`conversation`
  blocks (do not fork into per-kind variants yet — see Open Questions).
- **1b. Task/Job data model.** Introduce Task as the durable work definition and
  Job as the execution instance. Migrate today's scheduled-job rows into the
  compatibility shape: one Task with one scheduled trigger and Job records for
  each fire/manual test run. Preserve existing job ids as aliases during
  migration so Slack commands keep working.
- **1c. Runtime profile data model.** Introduce `runtime_profile` as a first-class
  concept: `(principal, profile_id, engine, state_generation)`. Map the current
  engine-only selection (`runtime-policy.ts` precedence ladder, the scheduled job's
  `runtimeType`) onto profiles. Jobs and conversations bind to a profile, not a
  container/sandbox id.
- **1d. Task validation surface.** Add `show task`, `validate task`, and dry-run
  validation for required tools, provider grants, argument templates, delivery
  route, visibility policy, and runtime profile selection. This is diagnostic
  first; repair writes remain explicit.
- **1e. Enforce the warm-instance invariant.** Replace the ad-hoc
  `stopOtherActiveRuntimes` dance (and its cross-engine thrash race) with a
  per-`(principal, profile, engine, state_generation)` lock guaranteeing at most
  one warm instance. `state_generation` change = clean replace/upgrade.

Exit: chat and scheduled runs go out as the canonical envelope; selection is
profile-based; Task and Job can be listed independently; concurrent interactive +
scheduled runs for one principal no longer thrash each other's runtimes.

### Sprint 2 — `burble-native` as an OpenShell entrypoint service (Option A)

Goal: the thinnest runtime that can pass conformance, running the production way.

Slices:

- **2a. Direct Responses API loop** (Option A): call model → detect tool calls →
  Burble tool/MCP gateway → append results → continue to final or `max_turns`.
  Reuse `@burble/runtime-sdk` server helpers for `/healthz`, `/capabilities`,
  `/runs`, `/runs/:id/events`. Reconcile with the existing in-process
  `createAiSdkAgentRunner`: keep it for local-dev/tests; the OpenShell HTTP service
  is the production form, same contract.
- **2b. OpenShell entrypoint packaging.** Image-entrypoint service exposed by
  OpenShell (not an `ExecSandbox` shim). Burble passes profile, manifest, and
  gateway credentials as env/config; reaches the runtime through the exposed
  service. Fold the hardcoded `openShellHostAllowedIps` allowlist into config here.
- **2c. Event model + emission rules.** Emit the canonical event vocabulary with
  the rules enforced in code: no user-visible prose until the model is not calling
  a tool; exactly one terminal result/error per tool call; final is a _proposal_;
  protocol leakage in final prose is a contract violation.
- **2d. Task-local tool surface.** For scheduled/manual Task runs, expose only the
  Task's allowed operations, preferably as task-local aliases with validated
  argument templates. The model should not choose from the workspace-wide provider
  catalog when the Task already resolved the required operation.
- **2e. Recoverable tool-error loop.** Convert grant/argument failures that are
  model-correctable into structured tool errors returned to the model loop, with
  `max_tool_error_retries` enforced by the runtime. Spec/grant mismatches become
  Task validation failures, not model retries.

Exit: `burble-native` runs as an OpenShell workload, serves a chat run and a
scheduled-job run end to end through the gateways, emits a clean event stream,
and can recover once from a wrong tool choice without losing the run.

### Sprint 3 — Conformance oracle

Goal: make `burble-native` the contract oracle and gate capabilities on tests.

Slices:

- **3a. Cross-runtime conformance suite** that runs the same scenarios against a
  _real_ `burble-native` instance in CI (not a hand-rolled fake): health/capability
  discovery, chat reaches final, valid event order, **one logical tool call = one
  gateway execution** (re-home the PR's invariant test here), denied calls fail
  closed, scheduled envelope preserves `jobId`, job-scoped creds unusable outside
  the job, visibility classification present, protocol leakage rejected, usage
  emitted when the provider returns it.
- **3b. Task/Job conformance checks:** list Tasks independently from Jobs, manual
  and scheduled triggers create Job records from the same Task, task-local aliases
  execute exactly one provider operation, a disallowed model-selected tool is
  returned as a recoverable error once, and a bad Task grant fails validation
  before runtime execution.
- **3c. Capability gating.** A runtime cannot claim a capability the suite does not
  exercise. Selection policy prefers the reference runtime for baseline chat and
  scheduled-job workloads.

Exit: the suite is green against `burble-native`; capabilities are test-gated; the
double-execution invariant is enforced against a real runtime, closing the
fixtures-never-run-against-a-real-runtime gap.

### Sprint 4 — Make Hermes and OpenClaw conform

Goal: demote the heavy orchestrators to adapters; retire remaining band-aids
under test.

Slices:

- **4a. Run the same suite against Hermes and OpenClaw** for their overlapping
  claimed capabilities. Where they fail, fix the adapter — not Burble.
- **4b. Retire band-aids gated by conformance.** Marker-recovery/prose paths and
  the per-runtime regex notice lists get removed once the conformance suite proves
  the runtime crosses the structured boundary; what remains is contract validation
  only, ideally one shared matcher source.

Exit: Hermes and OpenClaw pass the shared suite for their declared capabilities;
no runtime-specific execution path remains in Burble's core.

### Sprint 5 — Durable workflow state

Goal: make "durable scheduler" literally true (this is where `durableWorkflowState`
authority is realized — on Burble's side).

Slices:

- **5a. Event-sourced run store** (`job_triggered`, `runtime_started`, `tool_*`,
  `delivery_completed`, terminal). Status becomes a projection; runs are resumable.
- **5b. Bounded retry-as-state.** A contract violation or transient failure retries
  a small bounded count tracked in the run, then fails loud — replacing today's
  fail-only behavior.
- **5c. Reconciliation + native-job migration.** Promote the PR's minimal
  reconciler to a full loop; add `needs_repair` and import/migration of any
  runtime-native jobs. Record usage/audit (runtime id, model, tokens, route,
  visibility) per run.

Exit: a process crash mid-run is recoverable from events; retries are bounded and
observable; no run is orphaned; scheduled runs carry full usage/audit.

### Sprint 6+ — Deferred surfaces and the Option A/B decision

- Skills and memory as Burble-owned product surfaces (catalog, approval, injection
  into the run envelope) — only after the reference path is boring.
- Decide whether `burble-native`'s internal loop stays direct Responses API
  (Option A) or moves behind the OpenAI Agents SDK (Option B). The contract must
  not reveal which was chosen; switch only if retry/guardrail/tracing complexity
  justifies it.
- Heavier runtime profiles (coding/workspace) revisited last.
