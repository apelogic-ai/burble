# Runtime Tool and Skill Filtering Plan

## Context

Burble runtime requests currently expose too much agent surface by default.

A simple conversational turn such as `hello again` can still preload provider
skills and expose a large MCP tool catalog. Recent traces showed:

- `catalogTools=50`
- `promptChars` above 40k
- large channel history attached to the run
- `skills` filter effectively disabled

This makes simple turns slower, increases model confusion, and gives the agent
too many irrelevant choices. The goal is to keep the runtime agent path, but
hand it a smaller workbench for each request.

This is different from the old deterministic fast-track. Filtering should reduce
the agent's visible tool and skill surface without bypassing the agent.

## Goals

- Reduce prompt/tool bloat for simple and narrow requests.
- Reduce wrong-provider and over-eager tool calls.
- Keep provider policy enforcement authoritative.
- Make filtering decisions observable and debuggable.
- Allow bounded fallback when a first-pass filter was too narrow.

## Non-Goals

- Do not replace runtime policy enforcement.
- Do not reintroduce deterministic provider execution as the primary path.
- Do not make the model responsible for seeing every provider tool on every
  turn.
- Do not remove existing provider MCP tools.

## Proposed Model

Introduce declarative tool and skill groups.

Example shape:

```yaml
groups:
  conversation:
    always: true
    tools:
      - conversation_*

  github:
    triggers:
      - github
      - repo
      - repository
      - pr
      - pull request
      - issue
      - branch
      - review
    tools:
      - github_*
    skills:
      - github

  google:
    triggers:
      - google
      - drive
      - docs
      - doc
      - gmail
      - email
      - calendar
    tools:
      - google_*
    skills:
      - google

  jira:
    triggers:
      - jira
      - atlassian
      - ticket
      - sprint
      - project
    tools:
      - jira_*
      - atlassian_*
    skills:
      - atlassian-jira

  scheduler:
    triggers:
      - cron
      - schedule
      - recurring
      - reminder
      - every
    tools:
      - scheduler_*
      - conversation_*
    skills:
      - scheduler
```

The exact tool names should match the generated MCP names and the runtime bridge
names after normalization.

## Request Filtering Flow

1. Burble receives a Slack message.
2. Before runtime invocation, Burble computes selected tool groups from:
   - deterministic trigger words
   - Slack message metadata
   - attachments
   - explicit `ask agent` phrasing
   - user/workspace policy
   - job-scoped capability metadata for scheduled runs
3. Burble passes selected groups to the runtime request payload.
4. Runtime MCP bridge filters `tools/list` to only selected provider tools.
5. Runtime skill preloader injects only selected skill docs.
6. Existing runtime policy still filters and enforces allowed tools at call time.

For example:

| User request | Selected groups |
| --- | --- |
| `hello again` | `conversation` or none |
| `list my latest PRs` | `github`, `conversation` |
| `create a Jira ticket` | `jira`, `conversation` |
| `summarize this attachment` | `conversation` |
| `create a cron job to check GitHub PRs` | `scheduler`, `github`, `conversation` |

## Deterministic First, Optional LLM Later

Start with deterministic filtering.

Deterministic rules are:

- fast
- explainable
- easy to log
- safe to tune in tests

A tiny classifier model can be added later for ambiguous requests, but it should
produce the same structured group output and should not bypass policy.

## Fallback Strategy

Filtering can be too narrow. Use a bounded fallback:

1. First pass runs with selected groups.
2. If the model explicitly indicates a missing capability, retry once with an
   expanded group set.
3. Log the retry reason and newly enabled groups.
4. Do not retry repeatedly.

Example log:

```text
runtime_filter_retry runId=... reason=missing_tool requested=github expandedGroups=github,conversation
```

This keeps normal turns cheap while preserving flexibility.

## Skill Filtering

Tool filtering is not enough. Runtime traces show provider skills being
preloaded even when no matching provider is needed.

The skill preloader should receive the same selected groups and only inject
matching skill docs.

Expected behavior:

- General chat: no provider skill docs.
- GitHub request: GitHub skill docs only.
- Jira request: Jira skill docs only.
- Multi-provider request: only relevant provider skills.

## MCP Tool Filtering

The MCP gateway may still list all policy-allowed tools. The runtime bridge
should apply a per-run visibility filter before exposing tools to OpenClaw or
another runtime engine.

Filtering should happen at two places:

- `tools/list` visibility: reduce prompt/tool catalog.
- `tools/call` enforcement: reject calls outside the selected run groups unless
  policy explicitly permits fallback expansion.

The call-time check is defense-in-depth. Workspace/user/job policy remains the
final authority.

## Observability

Every runtime run should log the filter decision:

```text
runtime_tool_filter runId=... groups=github,conversation skills=github tools=8 reason=keyword:pr promptTools=8
```

Useful fields:

- selected groups
- selected skills
- selected tool count
- original tool count
- final prompt tool count
- trigger reasons
- whether fallback was used

This lets us compare latency, prompt size, and wrong-tool behavior over time.

## Policy Interaction

Filtering is not authorization.

Examples:

- If GitHub group is selected but `github_create_pr` is disabled, it remains
  unavailable.
- If a scheduled job JWT allows only specific tools, filtering cannot widen it.
- If a workspace disables a provider, trigger words should not expose it.

The intended order is:

1. Workspace and user policy define the maximum allowed tool surface.
2. Job-scoped policy narrows it when applicable.
3. Per-run filtering narrows it further based on intent.

## Testing Plan

Add tests for:

- trigger word to group mapping
- ambiguous/general chat selecting no provider groups
- attachment-only requests selecting conversation tools
- scheduled GitHub requests selecting scheduler + GitHub + conversation
- user-disabled tools remaining unavailable after group selection
- fallback expansion logging and one-retry behavior
- prompt/tool catalog count reduction in runtime bridge tests

## Open Questions

- Should `conversation` tools always be present, or only when Slack delivery or
  attachments are needed?
- Should `ask agent` force full agent mode but still filtered tools?
- Should provider aliases from user config influence trigger matching?
- Should group definitions live with provider YAML specs or in a separate runtime
  filtering YAML?
- How should filtering work for autonomous scheduled jobs whose prompt has no
  fresh Slack message?

## Expected Impact

For simple turns:

- `catalogTools` should drop from roughly 50 to 0-2.
- Provider skill docs should usually be omitted.
- Prompt size should drop materially.
- Latency should become more stable.

For provider turns:

- The agent should see the relevant provider tools only.
- Wrong-provider tool calls should become rarer.
- Existing MCP/policy enforcement remains intact.
