# Runtime Contract Implementation Roadmap

This document captures the remaining work to turn Burble's runtime contract from
an advertised schema into the normal way Burble integrates with native agent
runtimes.

The goal is not ten small PRs. The useful boundaries are the places where a
regression would be user-visible and where hand-testing matters beyond unit and
contract tests.

## Current State

Already landed or in flight:

- shared runtime schemas for run requests, run events, final responses, usage,
  and capability manifests;
- `/capabilities` on OpenClaw/NemoClaw and Hermes runtimes;
- a runtime contract HTTP client that can discover resident runtime
  capabilities;
- Burble managed runtime execution that discovers capabilities before posting
  to `/runs`;
- runtime type mismatch protection for managed runtimes;
- compatibility handling for older runtimes that return `404` or `405` for
  `/capabilities`;
- a smoke-harness contract test against the OpenClaw/NemoClaw deterministic
  handler.
- a Burble-side managed runtime adapter seam, with the previous
  OpenClaw/NemoClaw runner name retained as a compatibility export;
- `AGENT_RUNTIME_URL` / `managedRuntimeUrl` as the canonical configured runtime
  endpoint, with `OPENCLAW_NEMOCLAW_URL` retained as a compatibility alias;
- `native-runtime` as the canonical execution mode for native runtime turns.

## PR 1: Runtime Adapter Unification

Define one Burble-side `RuntimeAdapter` interface and put OpenClaw/NemoClaw and
Hermes behind it.

Scope:

- normalize capability discovery, health, run start, streaming, final response
  parsing, and fallback behavior;
- keep runtime-specific details behind adapter implementations;
- remove direct call-site knowledge of OpenClaw-vs-Hermes where Burble only
  needs the runtime contract;
- extend shared contract tests to both adapters where possible.

Current PR slice:

- `RuntimeAdapter` is now the Burble-side seam used to wrap managed runtime
  implementations as `AgentRunner`s;
- the current HTTP/WebSocket contract path is exposed as the managed runtime
  adapter and still supports the old OpenClaw/NemoClaw export name;
- Burble app config and Slack runtime setup use managed-runtime naming while
  preserving legacy env/config aliases;
- the request contract accepts canonical `native-runtime` execution mode.

Likely regression points:

- agent replies stop returning correctly;
- streaming and progress updates regress;
- route handling diverges between runtimes;
- runtime lifecycle UI shows stale or wrong state;
- scheduled jobs still execute but callback/final delivery breaks.

Hand-test checklist:

- basic chat on OpenClaw/NemoClaw;
- basic chat on Hermes;
- one GitHub, Jira, and Google provider call on each runtime;
- a long-running turn with progress updates;
- App Home runtime restart;
- an existing scheduled job posts back to Slack.

## PR 2: Unified Provider Bridge And Scheduled Job Contract

Make provider calls from scheduled jobs use the same Burble-controlled provider
authority path as interactive runs.

Scope:

- choose one canonical runtime-to-Burble provider bridge shape;
- ensure interactive runs and runtime-native scheduled jobs use that same
  bridge;
- normalize `jobId`, allowed tools, route binding, visibility policy, and
  job-scoped auth;
- remove runtime-specific prompt hacks where possible;
- add conformance coverage for scheduled jobs invoking GitHub, Jira, and Google
  tools.

Current PR slice:

- `burble_provider_call` is the runtime-neutral provider bridge envelope for
  scheduled/background provider calls: `{ toolName, input }`;
- OpenClaw/NemoClaw now accepts that envelope in addition to direct provider
  tool names, and preserves `jobId` when direct provider aliases are used;
- Hermes has a contract test proving the same envelope is forwarded to the
  Burble tool gateway with `jobId` intact;
- `scheduledJob.registerCapability` returns runtime-neutral bridge examples
  instead of runtime-specific prompt branches;
- job-scoped MCP runtime tokens now require matching `jobId` in the provider
  call arguments, closing the "allowed tool but no job argument" gap.

Likely regression points:

- scheduled jobs can no longer call provider tools;
- provider calls work interactively but fail inside cron;
- job-scoped JWTs reject valid calls or allow too much;
- job output lands in the wrong Slack route;
- private provider-derived data is posted too broadly.

Hand-test checklist:

- create a scheduled job that uses Google Drive state;
- verify scheduled job reads and appends the Drive file;
- create or update a scheduled job that uses GitHub;
- create or update a scheduled job that uses Jira;
- manually trigger a job and wait for a natural scheduled trigger;
- confirm denied scheduled-job tool calls fail with useful diagnostics;
- confirm output lands in the intended Slack conversation.

## PR 3: Runtime Selection, Conformance Gate, And Observability Parity

Make runtime pluggability operational for users and workspaces.

Scope:

- user/workspace runtime selection, for example user A on Hermes and user B on
  OpenClaw/NemoClaw;
- App Home and `/agent config` surfaces for selected runtime and capability
  status;
- compatibility checks before a runtime is selectable;
- a reusable conformance harness for runtime images;
- comparable observability for usage, tool calls, errors, lifecycle events, and
  runtime capabilities.

Likely regression points:

- one user's runtime choice affects another user;
- existing runtime containers are orphaned or incorrectly reused;
- switching runtimes loses state unexpectedly;
- usage accounting differs between engines;
- App Home shows stale capability data.

Hand-test checklist:

- user A runs Hermes while user B runs OpenClaw/NemoClaw;
- switch a user's runtime and verify container/state behavior;
- App Home shows the selected runtime and discovered capabilities;
- provider calls still work after a runtime switch;
- token usage appears for both runtimes;
- observability files contain comparable events for both runtimes.

## Sequencing

The recommended sequence is:

1. Runtime Adapter Unification.
2. Unified Provider Bridge And Scheduled Job Contract.
3. Runtime Selection, Conformance Gate, And Observability Parity.

This keeps the risky boundaries clear: adapter routing first, scheduled provider
authority second, per-user runtime selection third.
