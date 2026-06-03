# Agent Runtime Contract Notes

Status: working thoughts.

Burble currently has two serious runtime paths:

- OpenClaw / OpenClaw Gateway
- Hermes Agent

The useful abstraction is not "Burble supports OpenClaw and Hermes." It is:

> Burble is the identity, authorization, channel, tool, policy, and visibility
> control plane. Agent runtimes are swappable execution engines that implement a
> small Burble runtime contract.

## Runtime Candidates

### Burble Native Runtime

This is the current `burble-direct` idea made explicit.

It would be the smallest reference implementation: provider call, tool loop,
classification, visibility handling, Burble tool gateway calls, optional MCP
catalog use, streaming events, and observability.

This should become the baseline contract implementation and regression oracle.
If another runtime cannot match the native runtime's basic behavior, the
adapter is probably leaking framework-specific assumptions into Burble.

### OpenClaw Gateway Runtime

OpenClaw should be treated as a resident gateway runtime, not as the CLI mode.

The old `openclaw` engine name is misleading because it maps to the
per-step CLI path. The product/runtime naming should distinguish:

- `openclaw-cli`: debug/deprecated path
- `openclaw-gateway`: real resident OpenClaw runtime path

OpenClaw is useful when we want its native agent machinery, gateway, channel
model, and agent process semantics.

### Hermes Runtime

Hermes is already shaped like a resident runtime. Burble injects a message into
an already-running Hermes gateway and receives a callback/final response.

Hermes is useful as a fast runtime candidate and as evidence that Burble's
runtime contract should not assume OpenClaw-specific concepts.

### OpenAI Agents SDK Runtime

This could be a clean SDK-based runtime with:

- tool calls
- handoffs
- partial streaming
- tracing
- model/provider configuration

It is probably a good candidate for a small Python or TypeScript runtime image
that maps OpenAI Agents events into Burble run events.

### LangGraph Runtime

LangGraph is more interesting for durable graph/state-machine agents than for
simple chat turns.

Potential fit:

- scheduled jobs
- long-running workflows
- approval flows
- checkpointed state
- retryable tool steps
- explicit recovery after crashes

It would likely need a stronger job/runtime state contract than the current
single `/runs` contract.

### Mastra Runtime

Mastra is TypeScript-native and has agent/workflow/memory/observability
primitives. That makes it an attractive candidate because Burble is already
TypeScript/Bun.

Potential fit:

- Burble-native developer ergonomics
- workflow-oriented agents
- a runtime that can share more code with Burble's tool schemas and policies

### Microsoft Agent Framework / AutoGen Runtime

This is more relevant if Burble needs multi-agent orchestration or Microsoft
ecosystem alignment.

Potential fit:

- enterprise/Microsoft customers
- multi-agent workflows
- Teams/Microsoft 365 heavy deployments

### Temporal / Restate Backed Runtime

Temporal or Restate is not an agent brain by itself. It is a durability layer.

Potential fit:

- scheduled jobs
- long-running work
- retries
- human approvals
- compensation/rollback
- crash recovery

The actual agent loop could still be OpenAI Agents SDK, LangGraph, Burble
native, or something else.

### Coding-Agent Runtime

Examples would be Claude Code or other software-development agents with file and
shell access.

This should not be the default Burble Slack/runtime path. It is useful only for
explicit software-development use cases with a strong workspace sandbox,
approval model, and egress policy.

## Runtime Container Contract

A Burble runtime should be an OCI/container process that Burble can provision
per user, workspace, or policy scope.

Expected environment:

- `BURBLE_RUNTIME_ID`
- `BURBLE_INTERNAL_TOKEN` or `BURBLE_RUNTIME_JWT`
- `BURBLE_TOOL_GATEWAY_URL`
- optional `BURBLE_MCP_GATEWAY_URL`
- optional model/provider environment
- runtime state/config/workspace paths

Expected endpoints:

- `GET /healthz`
- `GET /capabilities`
- `POST /runs`
- `GET /runs/:runId`
- `GET /runs/:runId/events`

The event endpoint can be WebSocket, SSE, or NDJSON, but the event vocabulary
should be identical.

## Runtime Transport Contract

The runtime contract should be transport-neutral, with HTTP as the minimum
integration and WebSocket as the preferred resident-runtime control channel.

Minimum required transport:

- `GET /capabilities`
- `GET /healthz`
- `POST /runs`
- `GET /runs/:runId`
- `GET /runs/:runId/events` using SSE or NDJSON

Recommended resident-runtime transport:

- `POST /runs` starts a run or schedules run creation.
- `GET /runs/:runId/events` remains available as a simple stream/fallback.
- `WebSocket /runtime` carries bidirectional runtime control and events.

WebSocket is useful because resident runtimes need more than one-shot request
handling:

- Burble can send cancel, pause, resume, policy refresh, config reload, and
  runtime restart warnings.
- Runtimes can stream status, deltas, tool calls, tool results, usage,
  heartbeat, liveness, and diagnostics over one ordered channel.
- Native scheduled jobs can report job start, completion, failure, and
  job-scoped metadata without Burble polling.
- Burble can apply backpressure, throttle work, and stop accepting work when a
  runtime is unhealthy.
- Runtime liveness becomes a real connection heartbeat instead of a passive
  `/healthz` poll.

WebSocket should not be the only transport:

- Custom runtimes are easier to build with HTTP.
- Some proxies and deployment environments make long-lived connections harder.
- One-shot and simple runtimes do not need a resident bidirectional channel.

The important constraint is that transport choice must not move the trust
boundary. Runtimes still receive no raw provider OAuth tokens. Tool access still
goes through Burble's tool gateway or MCP gateway with runtime-scoped and
job-scoped auth.

## Run Request Contract

`POST /runs` should carry:

- `runId`
- `principal`
  - `workspaceId`
  - `slackUserId`
- `executionMode`
- `runtime`
  - `id`
  - `engine`
  - auth-safe runtime metadata
- `input`
  - user text
  - conversation route
  - bounded recent context
  - attachments
  - selected tool groups
  - provider connection summary

The runtime should not receive raw provider tokens from Burble. It should call
Burble's tool gateway or MCP gateway with runtime-scoped auth.

## Run Event Contract

Runtime events should stay small and stable:

- `status`
- `message_delta`
- `tool_call`
- `tool_result`
- `usage`
- `heartbeat`
- `final`
- `error`

Final response:

- `classification`
- `text`
- optional `blocks`
- optional `attachments`
- optional `usage`
- optional `telemetry`

This keeps Burble responsible for channel delivery and visibility enforcement,
while allowing the runtime to provide rich progress and usage details.

## Scheduled And Background Work Contract

Scheduled/background work must be explicit in the runtime contract. It is not
enough for a runtime to support interactive `/runs`.

Scheduled job execution needs:

- durable job id
- delegated principal
- runtime id and runtime engine
- conversation/delivery route capability
- allowed tool list or allowed tool groups
- output visibility policy
- optional state references
- expiry/renewal policy
- job-scoped runtime JWT claims

Native runtime schedulers may own timer execution, but Burble owns the authority
envelope. The runtime can schedule and run the work, but provider calls and
channel delivery still go through Burble-controlled capabilities.

For provider-backed scheduled jobs:

- the runtime registers the job capability before creating or updating the
  native scheduled job;
- the job prompt or runtime job metadata includes the returned job-scoped
  provider-call instruction;
- every scheduled provider tool call includes the scheduled job id;
- Burble validates that the job id is allowed to call that provider tool;
- Burble enforces output visibility before delivery.

This is the lesson from OpenClaw/Hermes divergence: native schedulers can be
useful, but their tool surfaces and job prompts must be contract-tested against
Burble's provider bridge.

## Tool Access Contract

Burble should own provider credentials and enforce policy.

Runtime access should go through one of:

- Burble internal tool gateway
- Burble MCP gateway

The runtime should get:

- a route-scoped conversation capability when needed
- allowed tool groups or exact allowed tools
- runtime JWT claims for job-scoped limits
- no direct provider OAuth tokens

This makes the runtime swappable without moving the trust boundary.

The Burble-facing tool bridge should be canonical even if runtime adapters
expose it differently internally:

- OpenClaw may discover provider tools via MCP/tool catalog.
- Hermes may expose native aliases such as `google_get_drive_file`.
- another runtime may expose SDK tool objects.

Those are adapter details. From Burble's perspective all provider calls should
resolve to the same policy-checked operation:

- runtime-scoped auth
- optional job-scoped auth
- exact tool name
- structured input
- structured result
- classification
- observability event

Runtimes may offer native aliases for model ergonomics, but aliases must map
back to canonical Burble tool names.

The canonical runtime-to-Burble provider bridge envelope is:

```json
{
  "toolName": "google.getDriveFile",
  "input": {
    "fileId": "file-123",
    "jobId": "job-123"
  }
}
```

Runtime adapters may expose that as a native `burble_provider_call` tool, an
SDK helper, or a direct alias. The contract is the envelope, not the native
tool spelling. For scheduled/background work, `input.jobId` is mandatory and
must match the job-scoped runtime token when one is used. Burble strips the job
id before forwarding the call to the provider implementation.

Direct provider aliases are still allowed when a runtime exposes them, but they
must preserve the scheduled job id through the adapter layer. A provider call
that loses `jobId` is not equivalent to a scheduled provider bridge call,
because Burble cannot apply the stored job capability.

## Runtime Capability Manifest

Each runtime should publish a small capability manifest so Burble can reason
about support level without hardcoding runtime-specific assumptions.

Suggested fields:

- runtime type and version
- supported transports: HTTP, SSE, NDJSON, WebSocket
- supports streaming
- supports cancellation
- supports native scheduler
- supports scheduled provider calls
- supports tool calls
- supported tool bridge modes: `tool_gateway`, `mcp`, or both
- usage reporting: `exact`, `estimated`, or `none`
- supports multimodal input
- supports multimodal output
- supports memory
- supports durable workflow state
- supports attachments
- supports conversation send
- supports job-scoped auth

The manifest should be advisory, not a replacement for policy. Burble still
enforces runtime policy and tool permissions.

## User Runtime Choice

User-selected runtimes fit directly into this contract, but only after the
contract is executable.

The effective runtime for a request should be resolved by Burble from:

- workspace/admin policy: which runtime engines are allowed in this workspace;
- user preference: which allowed runtime the user prefers;
- request/job constraints: whether the task needs scheduler, multimodal input,
  exact usage reporting, provider tools, job-scoped auth, or another capability;
- runtime health: whether the preferred runtime is currently available;
- fallback policy: which runtime to use when the preference is unavailable or
  unsupported for the requested capability.

The selected runtime changes execution behavior, not authority. Provider OAuth,
tool policy, route delivery, visibility, runtime JWTs, scheduled job
capabilities, and observability remain Burble-owned.

Example effective policy:

```yaml
workspace:
  runtimes:
    allowed:
      - openclaw-gateway
      - hermes
    default: openclaw-gateway
    fallback: openclaw-gateway

users:
  U123:
    runtime:
      preferred: hermes
```

Resolution examples:

- User A prefers Hermes and Hermes passes the required contract checks: use
  Hermes.
- User B has no preference: use the workspace default.
- User C prefers Hermes, but the request requires a capability Hermes does not
  advertise: use the workspace fallback or ask for confirmation, depending on
  policy.
- User D prefers a runtime not allowed by the workspace: ignore the preference
  and report the effective runtime in App Home/settings.

Runtime selection should be exposed through user settings, not admin-only
configuration:

```text
/agent config get runtime
/agent config set runtime hermes
```

The admin surface should control the allowed set and defaults. The user surface
should only choose within that allowed set.

## Runtime Adapter Compatibility Matrix

Current rough shape:

| Capability | OpenClaw Gateway | Hermes | Target |
| --- | --- | --- | --- |
| `/runs` | yes | yes | required |
| `/runs/:id/events` | yes | yes | required |
| resident process | yes | yes | recommended |
| WebSocket control | no | no | recommended |
| provider tools | MCP/tool gateway | provider plugin/tool gateway | required |
| scheduled provider tools | yes | yes after bridge pinning | required |
| conversation delivery | Burble channel connector | platform adapter send | required |
| usage reporting | exact/provider diagnostics | exact/provider diagnostics | required |
| tool filtering | partial | partial | required |
| multimodal input | partial | unknown/partial | required later |
| runtime memory | runtime-specific | runtime-specific | optional/manifested |

The goal is not to make runtime internals identical. The goal is to make them
contract-identical.

## Contract Test Harness

The runtime contract should become executable. Every runtime image should pass
the same small harness before it is considered supported.

Test cases:

- health check passes;
- `POST /runs` accepts a simple turn;
- status and final events stream correctly;
- message delta events are delivered when supported;
- final response includes classification and text;
- usage is present when the runtime claims usage support;
- provider tool call works through Burble's gateway;
- scheduled job provider call works with `jobId`;
- conversation send works through a route capability;
- runtime cannot access provider tools outside its allowed set;
- runtime cannot use raw provider credentials;
- cancellation or timeout behavior is observable;
- observability events include runtime id, run id, principal, and tool name.

The harness should run against:

- Burble native runtime as the reference implementation;
- OpenClaw Gateway runtime;
- Hermes runtime;
- future SDK runtimes.

## SDK Idea

Create a small Burble Runtime SDK, not a full agent framework.

Possible packages:

- `@burble/runtime-sdk`
- later: `burble-runtime-sdk` for Python

SDK contents:

- TypeScript request/response/event schemas
- auth header helpers
- `/runs` server helper
- event streaming helper
- tool gateway client
- MCP gateway client
- conversation send/getAttachment helpers
- classification/visibility helpers
- contract test harness

Runtime adapters can then stay thin:

- `burble-runtime-native`
- `burble-runtime-openclaw`
- `burble-runtime-hermes`
- `burble-runtime-openai-agents`
- `burble-runtime-langgraph`
- `burble-runtime-mastra`

## Near-Term PR Shape

The next unification PR should avoid rewriting runtime internals. It should make
the contract explicit and testable:

1. Add shared TypeScript schemas for run request, run events, final response,
   tool calls, scheduled job context, usage, and runtime capability manifests.
2. Add a runtime contract test harness.
3. Add a reusable HTTP/WebSocket contract client so the harness can run against
   resident runtime containers.
4. Make the OpenClaw Gateway adapter pass the harness.
5. Make the Hermes adapter pass the same harness.
6. Document runtime-specific caveats that remain after the harness passes.

After that, a WebSocket runtime-control PR can add the resident control channel
without breaking HTTP/SSE runtimes.

The first adapter-unification implementation keeps existing deployments and
runtime images compatible while moving the Burble-facing names to runtime-neutral
terms:

- `RuntimeAdapter` is the Burble-side seam; the existing managed HTTP/WebSocket
  runtime path is the first implementation;
- `AGENT_RUNTIME_URL` / `managedRuntimeUrl` is the canonical static runtime
  endpoint, while `OPENCLAW_NEMOCLAW_URL` remains an alias;
- `native-runtime` is the canonical execution mode for native agent runtime
  turns, while `openclaw-native` remains an accepted wire alias for existing
  OpenClaw/NemoClaw code and tests.

## Implementation Roadmap

Recommended sequence:

1. **Contract foundation.** Land shared schemas, parser helpers, and the
   contract smoke harness. This PR should be mostly additive and behavior-neutral.
2. **Runtime conformance tests.** Run the same harness against OpenClaw Gateway
   and Hermes containers in CI or an integration test profile. The first
   local slice should keep dependencies light: run the shared smoke harness
   against the TypeScript OpenClaw/NemoClaw runtime handler in deterministic
   mode, and validate Hermes' advertised manifest through the Python entrypoint
   probe. Full Hermes HTTP/WebSocket conformance should run against the built
   runtime image because the local TypeScript test environment does not install
   Hermes' Python HTTP stack.
3. **Tool bridge unification.** Make each runtime call one canonical Burble tool
   bridge shape, even if the runtime exposes ergonomic aliases internally.
4. **Generated runtime tool catalog.** Generate OpenClaw and Hermes tool aliases
   from provider specs so aliases do not drift.
5. **Runtime selection policy.** Add workspace-allowed runtime engines, user
   runtime preference, effective runtime resolution, and App Home/settings UI.
6. **Runtime control channel.** Add optional WebSocket `/runtime` control for
   pause, resume, cancel, config reload, liveness, and diagnostics.

## Product Proposition

The runtime contract gives Burble a clear product boundary:

> Bring your own agent runtime. Burble supplies identity, tools, channel
> delivery, permissions, visibility, deployment lifecycle, and auditability.

This is stronger than saying Burble is another MCP gateway or another agent
framework.

Burble becomes the control plane for user-scoped agents. Runtimes become
replaceable execution workers.

## Open Questions

- Should `/runs/:runId/events` standardize on WebSocket, SSE, or both?
- Do scheduled jobs need a separate durable job contract instead of only
  `/runs`?
- Should runtime health include dependency health, such as resident gateway
  process status?
- Should tool access be expressed as exact tool names, tool groups, or both?
- What minimum contract tests must a third-party runtime pass before Burble can
  safely run it?
- Should the SDK include a reference native runtime, or only protocol helpers?
