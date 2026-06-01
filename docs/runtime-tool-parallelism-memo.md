# Runtime Tool Parallelism Memo

## Summary

For a user request that needs several independent provider calls, for example
GitHub + Jira + Google in one answer, parallelism is currently decided by the
agent runtime, not by MCP itself.

Burble's provider gateway can handle independent concurrent tool calls. The
current OpenClaw Burble loop serializes provider calls. Hermes is configured as
parallel-capable for MCP, but the actual planner/executor behavior lives in
Hermes core outside this repository.

## Current Behavior

### OpenClaw

The Burble OpenClaw wrapper is sequential for provider tools today.

The loop:

1. builds a planning prompt;
2. asks the model/runtime;
3. parses one planned tool call;
4. awaits that one tool call;
5. feeds that one result into the next planning step.

Relevant files:

- `runtimes/openclaw-nemoclaw/src/openclaw-cli.ts`
  - `readPlannedToolCall(...)` returns a single `PlannedToolCall`.
  - `executePlannedToolCall(...)` is awaited once per loop step.
  - planning instructions say to return exactly one `tool_call` or the final
    Slack-ready answer.
- `runtimes/openclaw-nemoclaw/skills/core.md`
  - documents the single JSON `tool_call` shape.

OpenClaw or the underlying model transport may support native parallel tool
calls, but Burble's OpenClaw provider-tool bridge does not expose that today.

### Hermes

Hermes is configured as parallel-capable for Burble MCP catalog mode:

- `runtimes/nemo-hermes/runtime/entrypoint.py`
  - writes `supports_parallel_tool_calls: true` for the Burble MCP server when
    the MCP catalog is enabled.
- `runtimes/nemo-hermes/hermes-plugins/burble-provider-tool/__init__.py`
  - registers `burble_provider_call` as an async tool.

However, Hermes core owns actual tool scheduling. From Burble source alone, we
can say Hermes is configured to allow parallel calls, but not prove that every
independent multi-tool request is executed concurrently.

### Burble MCP and Tool Gateway

Burble does not intentionally serialize provider calls globally.

Each request is independently:

1. authorized against runtime JWT / internal token;
2. checked against runtime manifest and job-scoped allowed tools;
3. routed to the appropriate provider handler;
4. audited through observability.

Relevant files:

- `src/mcp/provider-server.ts`
- `src/mcp/provider-github.ts`
- `src/mcp/provider-google.ts`
- `src/mcp/provider-jira.ts`
- `src/tool-gateway.ts`

Provider implementations may also have internal parallelism inside one tool
call. Examples include batched Google message detail reads and GitHub label
removal.

## Design Implication

If we leave parallelism entirely to runtimes, behavior will differ by runtime:

- OpenClaw provider calls remain sequential unless its Burble bridge changes.
- Hermes may parallelize if Hermes planner/executor chooses to.
- Future runtimes may behave differently again.

For predictable Burble behavior, parallel independent provider reads should be
available through a runtime-neutral Burble contract.

## Recommended Direction

Add a Burble-owned parallel read orchestration primitive instead of depending
only on runtime-native parallel tool calling.

Possible shape:

```json
{
  "tool_call": {
    "name": "burble.parallelReadTools",
    "arguments": {
      "calls": [
        { "tool": "github.listMyPullRequests", "arguments": { "limit": 3 } },
        { "tool": "jira.listAssignedIssues", "arguments": { "limit": 3 } },
        { "tool": "google.searchDriveFiles", "arguments": { "limit": 3 } }
      ]
    }
  }
}
```

Rules:

- allow read-only provider tools only;
- deny write, scheduler, conversation delivery, and confirmation-required tools;
- enforce normal runtime manifest, user policy, and job-scoped tool narrowing
  per child call;
- execute child calls with bounded concurrency, for example 3-5;
- preserve one observability event per child call plus one parent aggregate
  event;
- merge output classification using the strictest child result;
- return partial successes with structured per-call errors.

This makes OpenClaw, Hermes, and future runtimes see the same safe primitive,
while Burble keeps policy, identity, visibility, and accounting centralized.

## Open Questions

- Should the primitive be exposed as one synthetic MCP tool, or implemented only
  inside Burble's runtime bridge?
- Which provider tools are safe enough to mark `parallelReadSafe` in provider
  specs?
- What should be the default concurrency limit per runtime and per workspace?
- Should the model see this primitive always, or only when the selected tool
  groups include more than one provider?
