# Agent Deterministic Traps Backlog

## Context

Burble still has several deterministic traps around natural-language agent
behavior. These were added incrementally to solve real failures, but they now
compete with the desired model:

- Slash commands and App Home buttons may use deterministic handlers.
- Ordinary chat should be handled by the LLM agent loop.
- Provider/task intent should be discovered through model planning and
  structured tool calls, not regex classifiers.
- Runtime guards may reject unsafe output, but they should not guess user
  intent from prose.

Recent failure mode:

```text
User: list docs in all my shared google drives and also drives and files shared with me
Burble: I still need one more Drive query to list docs/files shared with you directly.
```

The agent knew another tool call was needed but stopped anyway. The fix should
not be another regex trap for phrases like "I still need one more query". The
right fix is an agent-side planning/completeness contract: for compound
requests, track required sub-results and do not final-answer while a known
requested sub-result is still missing and a relevant tool is available.

## Policy

Allowed deterministic behavior:

- Slash command routing.
- App Home button/modal handlers.
- Structural validation of explicit IDs, schemas, MIME types, route IDs, cron
  syntax, timestamps, and config.
- Runtime output safety checks that prevent leaking tool protocol or internal
  progress text to users.

Disallowed deterministic behavior for ordinary chat:

- Regex intent classification.
- Local fast paths that execute provider tools and answer without the agent.
- Keyword-only tool selection that hides tools required by the user's actual
  request.
- Text-based "repair" that guesses the intended tool from assistant prose.

## Inventory

### Conversation-Level Intent Traps

- `src/conversation/orchestrator.ts`
  - `classifyDeterministicIntent`
  - Regex routes text into `connect_*`, GitHub identity/issues/PRs, or help.
  - Risk: steals turns from the LLM and misclassifies multi-intent requests.

- `src/conversation/orchestrator.ts`
  - `shouldForceAgentDelegation`
  - Regex detects jobs/tasks/provider mutations.
  - Risk: still heuristic routing; acceptable only as a temporary bridge if it
    always delegates to the agent rather than bypassing it.

- `src/conversation/local-tool-fast-paths.ts`
  - `localToolFastPaths`
  - Regex fast-paths Gmail, Drive, and Jira "latest/recent" requests.
  - Risk: executes tools and returns answers outside the full agent loop.
  - Target: remove for ordinary chat; keep only equivalent explicit App Home or
    slash-command actions if needed.

### Tool-Surface Selection Traps

- `src/agent/tool-groups.ts`
  - `selectRuntimeToolGroups`
  - Keyword matching selects GitHub/Google/HubSpot/Jira/scheduler/Slack/web
    groups.
  - Risk: wrong or missing keywords hide needed tools.
  - Target: make this advisory/observable only, or replace with an LLM planner
    that can request expanded tool groups.

- `src/scheduler/job-capabilities.ts`
  - Scheduled job capability inference uses `selectRuntimeToolGroups`.
  - Risk: scheduled tasks inherit keyword mistakes as durable capability
    metadata.
  - Target: derive task tools from the LLM-created task plan/tool specs, not
    from prompt keywords.

- `docs/runtime-tool-skill-filtering-plan.md`
  - Current doc says "Deterministic First, Optional LLM Later".
  - Risk: conflicts with this policy.
  - Target: revise that plan so filtering is model/planner-driven, with
    deterministic code limited to enforcement and validation.

### Runtime Provider Intent Traps

- `runtimes/openclaw-nemoclaw/src/runner.ts`
  - `isSupportedProviderRequest`
  - `runGitHubRequest`
  - `runJiraRequest`
  - Regex decides GitHub/Jira handling and executes canned provider flows.
  - Risk: a second deterministic agent inside the runtime.
  - Target: retire or confine to explicit compatibility tests; provider access
    should go through structured tool calls.

- `runtimes/nemo-hermes/runtime/entrypoint.py`
  - `infer_safe_hermes_provider_tool_from_text`
  - Infers a provider tool from words like GitHub, Jira, Drive, Gmail,
    HubSpot.
  - Risk: recovers some failures by guessing, but can select the wrong tool.
  - Target: replace with structured planner retry that asks the model to choose
    from the actual tool catalog.

- `runtimes/nemo-hermes/runtime/entrypoint.py`
  - provider protocol retry path:
    - `_provider_protocol_retry_tool_name`
    - `_build_provider_protocol_retry_message`
    - `_retry_provider_protocol_violation`
  - Risk: when the model writes tool intent as text, the runtime may infer and
    force a specific tool.
  - Target: keep bounded retry, but do not infer the tool from text; retry with
    the catalog and require the model to emit the structured call.

### Bootstrap / Progress / Protocol Text Guards

These are traps in the broad sense, but most are safety checks rather than
intent classifiers. Keep them narrow and well-tested.

- `runtimes/openclaw-nemoclaw/src/openclaw-cli.ts`
  - `isBootstrapSetupAnswer`
  - `shouldRejectDirectOpenClawResponse`
  - `sanitizeBootstrapFragments`
  - Risk: regex rejects/strips some legitimate prose if it resembles bootstrap
    text.
  - Target: keep only if still needed; prefer explicit runtime status fields
    over prose detection.

- `src/agent/runtime-control-notices.ts`
  - `isRuntimeProgressOnlyMessage`
  - `isRuntimeProgressOnlyResponseText`
  - Detects internal progress/control text.
  - Target: keep as runtime contract guard, but do not expand it into intent
    completion checks.

- `src/agent/runners/managed-runtime.ts`
  - `assertManagedRuntimeFinalResponse`
  - Rejects empty output, leaked tool protocol, and progress-only final output.
  - Target: keep as safety validation.

- `src/scheduler/output-spec.ts`
  - `validateRenderedOutput`
  - Rejects progress-only output, leaked tool protocol, and configured
    forbidden content.
  - Target: keep as scheduled-output validation.

- `src/scheduler/run-executor.ts`
  - progress-only scheduled-run retry/failure path.
  - Risk: string-based retry can mask a real agent planning issue.
  - Target: keep only as output safety; long-term fix should be structured
    runtime events that distinguish progress from final answers.

- `runtimes/nemo-hermes/hermes-plugins/burble-platform/adapter.py`
  - `_strip_hermes_tool_protocol`
  - Refuses leaked Hermes tool protocol in outbound Burble messages.
  - Target: keep as publish-time safety guard.

## Replacement Direction

### Agent Planning Contract

For ordinary chat, the runtime prompt/tool protocol should require:

1. Build a short internal plan from the user's request.
2. Identify required sub-results.
3. Call tools until each required sub-result is satisfied, impossible, or
   explicitly out of scope.
4. If a tool result reveals another required query, continue the tool loop.
5. Final answer only when all required sub-results are complete or explicitly
   impossible.

This directly addresses the "I still need one more query" failure without
matching that phrase.

### Tool Catalog Strategy

Tool filtering should not permanently hide tools based only on keywords.
Acceptable options:

- Start with a broad enough catalog for ordinary chat.
- Let a planner select or request tool groups.
- If the model reports missing capability, retry once with expanded groups.
- Log selected groups and retry reasons.

### Scheduled Task Strategy

Scheduled tasks should use the task's persisted plan/tool specs as the source
of truth. Keyword inference can help propose a draft, but must not be the final
capability boundary for a saved task.

## Cleanup Order

1. Remove or disable `localToolFastPaths` for ordinary chat.
2. Replace `classifyDeterministicIntent` with LLM-led handling except for
   explicit connect/help commands.
3. Rework `selectRuntimeToolGroups` from a hard selector into advisory planning
   metadata or an expandable first-pass filter.
4. Stop using keyword inference as durable scheduled-job capability metadata.
5. Replace Hermes provider-tool text inference with catalog-based model retry.
6. Review bootstrap/progress guards and keep only safety validators.
7. Update `docs/runtime-tool-skill-filtering-plan.md` to match this policy.

## Acceptance Criteria

- A normal Slack message is not answered by local regex fast paths.
- A compound provider request can make multiple tool calls before final answer.
- If the assistant knows another required tool query is needed, the runtime
  continues rather than final-answering.
- App Home and slash commands still work deterministically.
- Runtime safety checks still reject leaked tool protocol/progress-only final
  output.
- Tool selection decisions are logged and debuggable.
