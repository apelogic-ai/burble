# Agent Runtime And Scheduler Boundary Plan

## Purpose

Hermes and OpenClaw are failing around cron-style requests for the same reason:
Burble is letting runtime-native agent behavior own too much durable product
state. Cron jobs combine natural-language planning, schedule persistence,
provider authorization, Slack delivery, visibility policy, retries, and audit.
Those are Burble control-plane responsibilities, not runtime-specific prompt
conventions.

The goal is to merge the Hermes recovery work and the OpenClaw parity work into
one runtime-neutral design:

- runtimes own the bounded agent loop;
- Burble owns scheduler authority, provider authority, route authority, and
  visibility policy;
- future runtimes, including an OpenAI Agents SDK adapter, only need to
  implement the shared run/tool/final contract.

## External Precedent

This is a common split in mature agent systems.

- OpenAI Agents SDK runners execute a loop: call the LLM, execute tool calls,
  append tool results, and continue until final output or `max_turns`. That is
  the runtime responsibility Burble should require from Hermes, OpenClaw, and
  future adapters.
- OpenAI Agents SDK guardrails validate user input and final output around that
  loop. Burble's leaked marker/protocol rejection belongs in the same class of
  contract enforcement.
- Temporal treats schedules as first-class durable objects with APIs for
  create, list, describe, pause, trigger, update, and delete. Manual trigger is
  a scheduler command, not model prose.
- LangGraph separates runtime checkpoints from long-term application state.
  Cron jobs are application state; model/run checkpoints are not a substitute.
- NeMo Agent Toolkit documents framework-agnostic workflows, MCP integration,
  observability, and bounded parser retries. That supports a runtime-neutral
  contract rather than per-runtime cron semantics.

References:

- https://openai.github.io/openai-agents-python/running_agents/
- https://openai.github.io/openai-agents-python/guardrails/
- https://docs.temporal.io/develop/python/workflows/schedules
- https://docs.langchain.com/oss/python/langgraph/durable-execution
- https://github.com/NVIDIA/NeMo-Agent-Toolkit

## Boundary Decision

### Burble Owns

- scheduled job CRUD: list, get, create, update, delete, pause, resume;
- manual trigger and run status;
- job id, owner principal, workspace, runtime selection, and delivery route;
- provider credentials and job-scoped provider authorization;
- allowed tools, state refs, visibility policy, and declassification policy;
- audit, telemetry, retry accounting, and failure state.

### Runtime Owns

- reasoning over a user task or scheduled job body;
- choosing declared tools;
- consuming structured tool results;
- synthesizing the user-facing answer;
- bounded in-agent retry when it violates tool/final-output contract.

### Runtime Must Not Own

- durable scheduler records;
- Slack route resolution or Slack channel labels;
- provider credential policy;
- public/private output policy;
- control-plane command parsing for simple scheduler actions.

## Aigile Pipeline Ideas To Borrow

`~/dev/aigile` has a useful shape for this work. It is not directly a scheduler
system, but its durable coding pipeline has the same coordination problem:
agentic work is useful, but side effects and state transitions need a typed
owner outside the model.

Useful patterns:

- **Pure reducer plus command handlers.** Aigile's workflow reducer maps
  persisted events to a snapshot and a list of pending commands. Command
  handlers perform side effects and return the next event. Burble can use the
  same shape for scheduled jobs: scheduler events drive state; runtime/tool
  invocations are commands, not hidden model side effects.
- **Event-sourced run store.** Aigile stores ordered events plus artifacts and
  reconstructs current state by replay. Burble scheduled runs should record
  `job_triggered`, `runtime_started`, `tool_started`, `tool_completed`,
  `delivery_completed`, and terminal failure events so manual trigger/status is
  deterministic and resumable.
- **Bounded retry as state, not ad hoc loops.** Aigile counts developer attempts
  and escalates after a policy limit. Burble should model runtime contract
  retries the same way: one or two structured retries, then terminal failure
  with a reason.
- **Artifacts with provenance.** Aigile records artifacts with source, producer
  role, runtime id, model, and token usage. Burble scheduled runs should record
  provider results, generated summaries, delivery payloads, runtime id, model,
  token usage, and visibility classification as artifacts.
- **Role/runtime registry.** Aigile assigns roles to runtime profiles instead of
  hardcoding a runtime. Burble can generalize this into runtime profiles for
  `assistant`, `scheduled_job`, `coding`, and future OpenAI Agents SDK adapters.
- **Central permission policy.** Aigile classifies agent tool requests and
  applies an execution policy before allowing side effects. Burble should apply
  the same principle to provider tools, scheduler actions, delivery, and
  declassification, using Burble's runtime contract rather than adopting ACP
  unless ACP later proves to be the right adapter for a specific coding/runtime
  profile.
- **Idempotent side-effect handlers.** Aigile's PR publishing handler first
  checks for existing side effects before creating new ones. Burble manual
  trigger, job create/update, and delivery should be idempotent by job/run id.
- **Reconciliation loop.** Aigile has a watcher that reconciles external GitHub
  and Linear state back into the workflow. Burble should have a scheduler
  reconciliation path that can mark stuck runs failed, import/migrate native
  runtime jobs, and repair missing delivery/run status.

Mapping to Burble:

```text
Aigile issue workflow     -> Burble scheduled job workflow
WorkflowEvent             -> ScheduledJobEvent
WorkflowCommand           -> Scheduler/runtime/provider/delivery command
WorkflowArtifact          -> Provider result, generated summary, delivery record
RunStore                  -> Scheduled job run store
RoleRuntimeRegistry       -> Runtime profile / capability profile registry
Agent permission policy   -> Provider/scheduler/delivery policy gate
Verifier                  -> Runtime conformance and job-output verifier
```

This suggests the scheduler implementation should be a small durable FSM rather
than another layer of prompt text. The FSM does not replace the agent loop; it
decides when and how to invoke the runtime loop. ACP is only a source of design
ideas here; it should not be brought into Burble unless a later runtime adapter
has a concrete need for that protocol.

## Practical Request Routing

Simple scheduler commands should bypass LLM runtimes:

- "do we have cron jobs configured?"
- "list my jobs"
- "run the existing AI news job"
- "did the manual run finish?"
- "pause/delete/resume that job"

Complex job authoring may use a runtime:

- "create an hourly job that finds fresh AI news, summarizes it, and posts here"
- "update that job to also check GitHub issues"
- "repair the job so it uses the Drive scratchpad"

In that flow, the runtime drafts the job body, required tools, destination, and
visibility. Burble validates and persists the scheduler record.

When a job fires, Burble supplies a structured scheduled-job envelope. The
runtime executes the task under that envelope. Burble enforces the envelope on
provider calls and delivery.

## Merge Plan

### Track 0: Deterministic Scheduler Commands And Contract Gate

This should start before the runtime-specific merge work because it fixes the
currently broken user-visible path with the least runtime risk.

Add conservative deterministic routing for unambiguous scheduler control-plane
intents:

- list/get jobs;
- trigger an existing job;
- check latest run status;
- pause/resume/delete a job.

The router must stay narrow. Ambiguous phrasing should fall through to the
runtime rather than becoming another brittle prose parser.

These commands should call the same scheduler/tool-gateway implementation that
runtime tools call. There should not be separate Slack-command and runtime-tool
implementations that can drift.

In parallel, create the first shared conformance checks and make them a hard
gate for runtime work:

- scheduler list does not invoke an LLM;
- scheduler trigger records exactly one run;
- one logical tool call produces exactly one provider execution;
- leaked tool-call protocol text is not accepted as final output;
- provider calls without matching scheduled `jobId` are rejected.

### Track 1: Finish Hermes Contract Guardrails

Source branch: PR 72, `codex/hermes-structured-tool-retry`.

Keep the Hermes work that hardens the runtime contract:

- provider protocol retry when Hermes emits prose instead of structured calls;
- rejection of leaked tool-call protocol fragments such as
  `cronjob: "list"`;
- Slack operational notice filtering from agent context;
- standalone scheduled delivery fixes that do not make Hermes the scheduler
  authority.

Drop or disable Hermes work that makes Burble a second executor for the same
runtime turn:

- app-side marker/prose bridges that execute provider tools on behalf of Hermes;
- TS-side interceptors that execute runtime tool calls and return before the
  runtime loop synthesizes a final answer;
- Python immediate-execution/recovery paths that call provider tools as a
  substitute for a structured runtime tool call.

Under this plan, a marker/prose tool attempt is a contract violation. The
runtime may get a small bounded retry. If it still does not cross the structured
tool boundary, the run fails loudly with telemetry. Burble validates the
contract; the runtime owns the loop.

Before relying on leaked-protocol rejection as a guardrail, tighten it:

- avoid broad line-prefix matches that can catch ordinary content such as
  `to=` examples or JSX tags;
- prefer detecting exact protocol envelopes/markers;
- when safe, strip obvious standalone leaked protocol fragments before hard
  failing;
- keep hard failure for genuine control-protocol final answers.

### Track 2: Bring OpenClaw Parity Into The Shared Contract

Source tree: `~/dev/burble-openclaw-parity`.

Cherry-pick in small groups onto a fresh integration branch from updated
`main`:

1. OpenClaw stream reliability: hung-stream detection, idle bounds, failed
   response handling, retry/backoff, and replay harness.
2. Runtime-neutral scheduled job context: `scheduledJob` envelope,
   `scheduledJob.registerCapability`, route/destination validation, allowed
   tools, state refs, and visibility policy.
3. Tool-gateway enforcement: provider calls with `jobId`, job-scoped auth,
   denied calls with useful diagnostics, and telemetry for blocked attempts.
4. Runtime prompt/catalog hints only after code enforcement exists.

Do not let this become an OpenClaw-only scheduler design. Any useful behavior
must land behind the shared runtime contract or Burble control-plane API.

### Track 3: Burble-Owned Scheduler Authority

Add deterministic Burble paths for:

- `scheduledJob.list`
- `scheduledJob.get`
- `scheduledJob.trigger`
- `scheduledJob.create`
- `scheduledJob.update`
- `scheduledJob.delete`
- `scheduledJob.pause`
- `scheduledJob.resume`

Then route obvious scheduler intents to those paths before invoking a runtime.
This is the fix for cron questions that currently depend on random model/tool
behavior.

Job CRUD should stay plain and direct. The durable FSM should be scoped to job
run execution, delivery, and recovery, not every metadata edit.

Add migration/reconciliation for jobs that currently live only inside
runtime-native scheduler state:

- discover native Hermes/OpenClaw jobs where possible;
- import or mirror them into Burble scheduler records;
- preserve owner, destination, schedule, and task prompt when known;
- mark jobs that cannot be safely imported as `needs_repair`;
- prevent native-only jobs from silently continuing without Burble job context.

### Track 4: Shared Runtime Conformance

Create a conformance harness that can run the same scenarios against Hermes,
OpenClaw, Burble-native, and a future OpenAI Agents SDK adapter:

- scheduler list does not invoke the LLM;
- manual trigger does not invoke the LLM unless the job body requires a runtime
  run;
- create/update may invoke the runtime for task synthesis but Burble persists
  the job;
- scheduled execution receives `scheduledJob` context;
- provider calls without matching `jobId` are rejected;
- leaked protocol text fails contract;
- one logical tool call produces exactly one provider execution;
- runtime contract violation retries at most a small bounded count, then fails
  loudly;
- final delivery records route, visibility, token/tool usage, and errors.

## Test Plan

Local testbed should cover most behavior before AWS:

- unit tests for deterministic scheduler command routing;
- tool-gateway tests for scheduled job registration and provider enforcement;
- runtime contract tests for leaked protocol text and retry behavior;
- OpenClaw replay tests for response stream failures and LLM gateway errors;
- Hermes tests for marker/protocol rejection and structured retry;
- scheduler integration tests that create, trigger, and inspect a job record
  without contacting Slack;
- one end-to-end local test with a fake provider and fake Slack delivery.

AWS should be reserved for:

- real Slack Socket Mode behavior;
- real OpenShell networking/policy behavior;
- real provider credentials;
- runtime cold-start and long-running execution behavior.

## Success Criteria

- `list/run/status` cron requests produce deterministic Burble answers.
- Creating a job records a Burble-owned scheduled job with route, tools, and
  visibility policy.
- Manual trigger creates an observable run record and either posts output or
  stores a terminal failure.
- Hermes and OpenClaw both use the same scheduled-job envelope for provider
  calls.
- No runtime can publish `cronjob: "..."`, JSON tool calls, or other protocol
  fragments as a final answer.
- No tool call is executed twice by different owners.
- A new runtime adapter can pass conformance without implementing scheduler
  semantics internally.

## Non-Goals

- Replacing runtime-native agent loops.
- Making prompts the security boundary.
- Teaching each runtime a bespoke cron product surface.
- Solving public declassification for private provider-derived output without
  a separate approval design.

## Near-Term Sequence

1. Add deterministic scheduler command paths for list/status/trigger and the
   first conformance checks.
2. Land only the Hermes guardrails in PR 72 and stop deploying old branch heads.
3. Remove or disable app-side runtime executors that duplicate runtime tool
   execution.
4. Create a new integration branch from `main`.
5. Cherry-pick OpenClaw reliability and scheduled-context commits in reviewable
   groups.
6. Add Burble-owned scheduler authority for create/update/delete/pause/resume.
7. Add migration/reconciliation for runtime-native scheduled jobs.
8. Deploy to AWS only after local conformance is green.
9. Hand-test Slack:
   - list jobs;
   - create hourly AI news job;
   - manually trigger it;
   - inspect run status;
   - run a provider-backed scheduled job.
