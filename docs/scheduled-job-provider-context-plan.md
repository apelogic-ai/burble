# Scheduled Job Provider Context Plan

## Problem

Hermes scheduled jobs can deliver messages back through Burble, but provider-backed work inside those jobs is not reliably executed with Burble's provider identity.

The concrete failure mode:

- An interactive Hermes turn created a Google Drive scratchpad and updated a cron job to use it as mutable state.
- The later Hermes cron run delivered a Slack message through Burble.
- The same cron run did not call Burble's Google provider bridge, and instead reported a Google Drive `401` / sign-in-required fallback.

That means scheduled delivery is working, but scheduled provider access is not yet a first-class Burble capability.

## Diagnosis

Interactive turns and scheduled turns currently have different execution context.

Interactive turns have a Burble request envelope:

- workspace and principal
- conversation route
- runtime id
- provider connection state
- selected tool hints
- Burble provider bridge access

Hermes scheduled jobs are native Hermes jobs. They can wake up and deliver through the Burble platform adapter, but provider access depends on whatever context, prompt, and tools Hermes includes in that job execution. That is advisory and runtime-specific.

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
  "runtimeType": "hermes",
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

Hermes/OpenClaw keep their own schedulers, but every scheduled execution asks Burble for a fresh job-scoped context before running provider tools.

Pros:

- Smaller near-term change.
- Preserves runtime-native cron behavior.

Cons:

- More runtime-specific adapter work.
- Durability and policy still need careful enforcement.

Near-term recommendation: start with Option B for Hermes, but keep the data model compatible with Option A.

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
- Reminding the agent to use `burble_provider_call` for Google/Jira/GitHub/Slack.
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

## Hermes-Specific First Slice

For the next implementation PR:

1. Add a Hermes scheduled-job execution envelope that includes Burble job context.
2. Ensure `burble_provider_call` is available in scheduled job execution, not only interactive turns.
3. Include a scheduled-job system hint that explicitly names available provider tools and state refs.
4. Mint or refresh scoped auth for scheduled execution instead of relying on stale/static runtime context.
5. Emit observability events:
   - `scheduled_job.run.started`
   - `scheduled_job.tool.started`
   - `scheduled_job.tool.completed`
   - `scheduled_job.delivery.completed`
   - `scheduled_job.run.completed`
6. Add tests proving a scheduled Hermes job calls Burble's Google provider bridge for a Drive scratchpad read/write.

## Open Questions

- Should existing Hermes-native cron jobs be migrated automatically into Burble job records?
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
