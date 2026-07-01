# Autonomous Agent Authority Model

## Problem

Personal runtimes can act as the connected user because the runtime principal is
the user. Workgroup and company agents need a different model: they may run
without an interactive user turn, survive the original creator, and act on
workspace resources rather than personal resources.

This document defines the authority model for agents that are not simply
"Burble acting as the current Slack user."

## Principal Types

```text
human principal
  workspaceId: T123
  slackUserId: U123
  source: slack

personal agent
  workspaceId: T123
  slackUserId: U123
  runtimeId: rt_...
  authority: user

delegated job
  workspaceId: T123
  delegatedBy: U123
  jobId: job_...
  authority: scoped-user-delegation

workgroup agent
  workspaceId: T123
  agentId: pr-monitor
  ownerGroup: engineering
  authority: workspace-approved-agent

company agent
  workspaceId: T123
  agentId: security-auditor
  ownerGroup: workspace-admins
  authority: organization-approved-agent
```

## Authority Rules

- Personal agents run as the user and consume that user's connected-provider
  grants.
- Delegated jobs run with a narrowed grant derived from a user approval.
- Workgroup and company agents must have their own service principal or
  workspace-approved provider grants.
- Workgroup/company agents must not silently borrow one user's OAuth tokens.
- Agents cannot expand their own grants.
- Every autonomous action must identify `actor`, `authority`, and
  `onBehalfOf` when applicable.

## Capability Grants

Agent grants should be explicit and resource-scoped.

```json
{
  "workspaceId": "T123",
  "agentId": "pr-monitor",
  "grants": [
    {
      "provider": "github",
      "capability": "pull_requests.read",
      "resources": ["github:org/apelogic-ai"]
    },
    {
      "provider": "slack",
      "capability": "messages.post",
      "resources": ["slack:channel:C123"]
    },
    {
      "provider": "memory",
      "capability": "readwrite",
      "resources": ["memory:agent/pr-monitor"]
    }
  ],
  "expiresAt": null
}
```

Higher-risk write grants should require one or more of:

- explicit workspace-admin approval;
- confirmation before each action;
- dry-run output;
- resource allowlists;
- expiry and renewal;
- rate limits.

## Provider Credentials

Provider auth should match the authority tier:

- Personal agent: user OAuth.
- Delegated job: user OAuth plus scoped job grant.
- Workgroup/company agent: provider app installation, service account, or
  workspace-approved shared connector where the provider supports it.

If a provider only supports user OAuth, Burble should represent this honestly
as a delegated user grant, not as a true workspace agent credential.

## Memory And State

Memory is scoped by authority.

- User memory: private to a user.
- Job memory: private to a delegated job.
- Workgroup-agent memory: shared with the workgroup owner/admins.
- Company-agent memory: workspace-owned and admin-managed.

Agent memory can guide behavior but cannot grant tools or change resource
scopes.

## Runtime Placement

Possible placements:

- Personal agent runs inside the user's personal runtime.
- Delegated job can run inside the user's runtime or a job runtime with the
  delegated grant attached.
- Workgroup/company agent should run in a dedicated agent runtime or workspace
  runtime pool.

The runtime configuration system consumes the effective principal and grants.
It should not infer workgroup/company authority from a Slack user.

## Audit

Audit records should include:

```json
{
  "actor": "agent:pr-monitor",
  "authority": "workspace-approved-agent",
  "onBehalfOf": null,
  "configuredBy": "slack:U123",
  "workspaceId": "T123",
  "tool": "github_list_pull_requests",
  "resources": ["github:org/apelogic-ai"],
  "createdAt": "2026-05-28T00:00:00.000Z"
}
```

For delegated jobs:

```json
{
  "actor": "job:job_123",
  "authority": "scoped-user-delegation",
  "onBehalfOf": "slack:U123",
  "tool": "slack_post_message"
}
```

## Open Questions

- Which providers support app/service-account auth cleanly enough for true
  workspace agents?
- How should workspace admins create and inspect workgroup agents in Slack?
- Should workgroup agents have a dedicated App Home surface?
- How should autonomous agents request additional grants?
- Which write tools require per-action confirmation even for service agents?
