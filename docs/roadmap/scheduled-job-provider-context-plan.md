# Scheduled Job Provider Context Plan

## Problem

Runtime-native scheduled jobs can deliver messages back through Burble, but provider-backed work inside those jobs must also execute with Burble's provider identity and policy.

The concrete failure mode:

- An interactive agent turn created a Google Drive scratchpad and updated a native cron job to use it as mutable state.
- The later cron run delivered a Slack message through Burble.
- The same cron run did not call Burble's Google provider bridge, and instead reported a Google Drive `401` / sign-in-required fallback.

That means scheduled delivery is working, but scheduled provider access is not yet a first-class Burble capability.

## Diagnosis

Interactive turns and scheduled turns can have different execution context.

Interactive turns have a Burble request envelope:

- workspace and principal
- conversation route
- runtime id
- provider connection state
- selected tool hints
- Burble provider bridge access

Runtime-native scheduled jobs are owned by their agent runtime. They can wake up and deliver through the Burble channel/platform adapter, but provider access must not depend only on whatever context, prompt, and native tools that runtime includes in the job execution. That is advisory and runtime-specific.

The missing invariant is:

> Every scheduled job that uses provider tools must execute with an explicit Burble job context and a fresh, scoped provider-tool authorization path.

## Correct Fix

Create a structured Burble job execution context for scheduled/background runs.

Each scheduled job should have durable metadata:

```json
{
  "jobId": "ai-news-hourly-pacific-window",
  "ownerPrincipal": "T0B0BH273RR:U0B46E59T6K",
  "workspaceId": "T0B0BH273RR",
  "runtimeType": "openclaw",
  "deliveryRouteId": "convrt_...",
  "allowedTools": [
    "google.searchDriveFiles",
    "google.getDriveFile",
    "google.appendToDriveTextFile",
    "conversation.sendMessage"
  ],
  "stateRefs": [
    {
      "provider": "google",
      "kind": "drive_file",
      "id": "..."
    }
  ],
  "visibilityPolicy": {
    "maxOutputVisibility": "public",
    "privateToolOutput": "no_public_post_without_declassification"
  }
}
```

At each execution, Burble or the runtime adapter should mint a fresh job-scoped execution context:

- `job_id`
- principal/workspace
- delivery route
- allowed tool list
- token expiry
- output visibility policy

The runtime can still own planning and generation, but Burble owns the authority boundary.

## Execution Model

There are two viable implementation paths.

### Option A: Burble-owned job runner

Burble stores schedules and triggers runtime runs with a structured job envelope.

Pros:

- Strongest durability.
- Central place for policy, audit, retries, and route validation.
- Works across OpenClaw, Hermes, and future runtimes.

Cons:

- More product and infra surface.
- Requires migration from runtime-native cron jobs.

### Option B: Runtime-native scheduler with Burble job context

Supported runtimes keep their own schedulers, but every scheduled execution asks Burble for a fresh job-scoped context before running provider tools.

Pros:

- Smaller near-term change.
- Preserves runtime-native cron behavior.

Cons:

- More runtime-specific adapter work.
- Durability and policy still need careful enforcement.

Near-term recommendation: start with Option B for all supported runtimes, but keep the data model compatible with Option A.

## Required Enforcement

Prompting alone is not enough. The following must be enforced in code:

- Scheduled jobs may only call tools listed in their job capability.
- Provider tool calls must include a fresh runtime/job identity.
- Delivery route must match the approved route or an approved route alias.
- Output visibility must be derived from the tools actually used.
- Private provider data must not be posted publicly unless the job has an explicit declassification rule.
- Job execution must be observable as a first-class trace with tool calls, usage, failures, and delivery outcome.

## Role Of Skills

Skills are useful, but they are not the security boundary.

Use skills for:

- Teaching the agent how to structure a provider-backed scheduled workflow.
- Reminding the agent to use the runtime's Burble provider-tool adapter for Google/Jira/GitHub/Slack.
- Explaining provider-specific workflow patterns, such as Drive scratchpad state.
- Providing examples of safe scheduled job design.

Do not rely on skills for:

- Tool authorization.
- Provider credential access.
- Route authorization.
- Visibility policy.
- Durable job identity.

A skill can say:

> Use Burble provider tools for Drive state; do not ask for Google tokens or local config.

But the runtime must still be prevented from using undeclared tools or posting private-derived output to the wrong place.

## Runtime Types And Capability Profiles

Runtime type and capability profile should be separate concepts.

Runtime type answers:

> Which agent runtime executes the work?

Examples:

- `openclaw`
- `hermes`
- future custom runtimes

Capability profile answers:

> What is this runtime, turn, or job allowed to do?

Examples:

```yaml
profiles:
  assistant:
    description: Default Slack assistant profile.
    toolsets:
      - burble
      - web
      - cronjob
    provider_tools: allowed_by_manifest
    scratch_files: true
    code_exec: bounded
    terminal: false
    repo_mounts: false
    delivery: current_route

  workbench:
    description: Cross-provider analysis profile.
    toolsets:
      - burble
      - web
      - file
      - code
    provider_tools: allowed_by_manifest
    scratch_files: true
    code_exec: bounded
    terminal: false
    repo_mounts: optional

  coding:
    description: Explicit repo/code automation profile.
    toolsets:
      - burble
      - web
      - file
      - code
      - terminal
    repo_mounts: explicit
    terminal: sandboxed
    requires_confirmation: true
    observability: required

  scheduled_job:
    description: Background execution profile.
    toolsets: explicit_per_job
    provider_tools: explicit_per_job
    scratch_files: optional
    code_exec: optional
    terminal: false
    delivery_route: required
    visibility_policy: required
```

This avoids global decisions like "this runtime has code" or "this runtime does not have code." Instead:

- Any supported runtime with `assistant` can answer ordinary Slack/provider questions safely.
- Any supported runtime with `workbench` can use isolated scratch files and bounded code for moderate cross-provider data processing.
- Any supported runtime with `coding` can be granted repo and terminal capabilities when the user explicitly wants coding work.
- Any runtime with `scheduled_job` must use job-scoped provider capabilities and route policy.

For per-principal isolated runtimes, constrained file/code access is acceptable earlier than broad terminal access, but it still needs profile-level policy:

- file access must be confined to runtime-owned scratch/state paths
- code execution must be bounded by time, output, and resource limits
- code execution should not have network, subprocess, or ambient secret access by default
- scratch state must be observable and either ephemeral or explicitly promoted to durable state
- scheduled jobs must not read arbitrary old scratch files unless their job capability grants that state reference

## Runtime-Neutral First Slice

For the implementation PR:

1. Introduce capability profile metadata for scheduled/background runs, starting with `scheduled_job`.
2. Add a `scheduledJob.registerCapability` provider tool that native agents call before creating or updating provider-backed scheduled jobs.
3. Store the job capability in Burble with principal, workspace, runtime, allowed tools, optional delivery route, state refs, and visibility policy.
4. Return a `scheduledPromptInstruction` that the agent must include verbatim in the native scheduled-job prompt.
5. Enforce `jobId` / `scheduledJobId` on provider calls through both the internal tool gateway and MCP provider server.
6. Expose the registration affordance through thin runtime adapters:
   - OpenClaw: direct Burble tool executor + scheduler-shaped prompt/catalog hints.
   - Hermes: `burble_provider_call` alias + scheduler-shaped prompt hints.
7. Keep the runtime-native scheduler in control of timers; Burble owns provider authority, route/state grants, and enforcement.
8. Mint or refresh scoped auth for scheduled execution instead of relying on stale/static runtime context.
9. Emit observability events:
   - `scheduled_job.run.started`
   - `scheduled_job.tool.started`
   - `scheduled_job.tool.completed`
   - `scheduled_job.delivery.completed`
   - `scheduled_job.run.completed`
10. Add tests proving scheduled job provider calls are allowed only inside the registered capability.

## Open Questions

- Should existing runtime-native cron jobs be migrated automatically into Burble job records?
- Should user-created scheduled jobs require explicit approval when provider tools are involved?
- What is the default max output visibility for jobs using Google Drive, Gmail, Jira, Slack search, or private GitHub data?
- Should Burble allow arbitrary channel delivery, or only routes where the job was created until a route grant UI exists?
- How much scheduled-job state should live in Burble DB versus runtime-local state?

## Success Criteria

A provider-backed scheduled job is correct when:

- The scheduled run calls Burble provider tools, visible in `tool.gateway.*` observability events.
- The run is tied to a `job_id`, principal, route, runtime, and policy hash.
- A Google Drive scratchpad read/write from a scheduled run succeeds when it succeeds interactively.
- If provider auth fails, the error identifies the provider/tool path and does not silently fall back without recording the failure.
- Delivery respects the approved route and computed output visibility.
