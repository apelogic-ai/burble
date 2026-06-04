# OpenClaw Compaction Thrash — Diagnosis & Fix Plan

Status: working plan, 2026-06-04. Step 1 implemented locally in
`codex/openclaw-ephemeral-turn-sessions`; remaining items below are still open.
Companion to
[[openclaw-startup-optimization-plan]] (that doc covers *startup*; this one
covers *steady-state per-turn latency*, which is a distinct and now-larger
problem). Evidence: two live "hello" traces (cold 17:29, warm 17:37) on
`engine=openclaw`, `model=openai/gpt-5.4`.

## Symptom

A no-tool "hello" turn costs **44s warm / 65s cold** and **~43k tokens** to emit
an 11-token reply. The reply is fully generated early but withheld until a
post-answer compaction finishes.

Warm trace (17:37:57.600 → 17:38:41.984, 44.4s):

| Segment | Window | Cost |
|---|---|---|
| context + MCP `tools/list` (56 tools) | …57.6–57.7 | ~0.1s |
| harness + embedded run setup | …57.7–05.1 | ~7s |
| **actual answer model call** | 05.1 → `stream_done` 08.0 | **~3s** |
| → answer exists (`run done`, 7 deltas) | 08.0 | — |
| idle gap | 08.1–15.7 | ~7.6s |
| **`cli_budget` compaction** | 15.8 → `stream_done` 41.9 (`elapsedMs=23057 events=2215`) | **~26s** |
| flush `Hello — how can I help?` | 41.97 | — |

Token receipts (both traces): `inputTokens≈22.3k outputTokens=11
totalTokens≈43.2k`. The `total − (input+output)` gap is **exactly 20,864 tokens
in both traces** — the compaction's own model call, byte-identical because it
reprocesses the same frozen history every turn.

## Root cause

Three facts from the code (`runtimes/openclaw-nemoclaw/src/`):

1. **Stable per-channel session → cross-turn accumulation.** The gateway HTTP
   body (`openclaw-cli.ts:728`) sends only `input: prompt` plus a stable
   `x-openclaw-session-key`. `buildBurbleChannelSessionKey` (`:4002`) keys on
   `(runtime.id, workspaceId, routeId, rootId)` — stable per Slack thread — so
   the old `buildRunSessionId` → `burble-channel-<hash>` and step 1 →
   `burble-step-<hash(...:step:1)>` were **identical on every turn**. OpenClaw
   accumulated each turn's prompt+response under that one key
   (`messages=21, roleCounts=user:10,assistant:10,compactionSummary:1`).

2. **Fat prompts get persisted.** Each turn's `input` is the full
   `buildOpenClawPrompt` (`:2577`): skills preamble + policy boilerplate + the
   **entire 56-tool catalog** (`formatToolCatalog`) + baseline + recent-Slack
   context + user text ≈ 8–10k chars. The three bloat contributors in the logs
   (10659/10312/9437 chars) are prior *prompts*, not the recent-Slack context
   (capped at 12×300 chars, `:44-45`). ~10 turns × ~8.7k ≈ the observed 87k.

3. **No compaction/context budget is configured.** Neither `openai.json5` nor
   `buildOpenClawLlmPatch` (`llm-config.ts`) sets any `context`/`compaction`
   keys, so OpenClaw uses its default `cli_budget`, which trips at ~22k tokens —
   far below gpt-5.4's real window. Compaction preserves a verbatim recent
   window that is itself several fat prompts, so it can never get under budget
   and re-fires every turn (thrash).

**Net:** Burble injects a fat, mostly-static prompt every turn → OpenClaw
persists each into a stable session → history bloats with repeated boilerplate →
the tiny default budget trips → compaction fires every turn, can't converge, and
blocks the flush.

### Why the accumulation is dead weight (investigation result)

Continuity is **prompt-threaded, not session-threaded**, in both directions, so
OpenClaw's session store is never read back by Burble:

- **Within a turn:** the step loop (`openclaw-cli.ts:137-160`) rebuilds the full
  prompt each step with `executedTools` inlined, and uses a *distinct* session
  key per step (`buildStepSessionId(sessionId, step+1)`). Steps do not rely on
  OpenClaw memory.
- **Across turns:** `formatRecentSlackContext` re-injects `recentMessages` every
  turn.
- **qmd memory** (`memory.qmd`, manifest memory flags) is a *separate* subsystem
  from session history and is unaffected by the session key.

The per-step ephemeral design is clearly intended; the channel-stable root
defeats it across turns. This is effectively an accidental accumulation bug.

## Fix plan (ranked)

### 1. Ephemeral per-turn OpenClaw session — kills the thrash (primary) — DONE

Make the session key unique per turn so history never accumulates across turns.
Within-turn steps still chain correctly (they share the per-turn root; only the
cross-turn collision goes away), and prompt-threaded continuity is unchanged.

- Incorporated a per-turn nonce (`request.runId`) into the session-id
  derivation used for the gateway session key, even in channel scope. Native
  routed turns now use `burble-turn-<hash(channelKey:runKey)>` as the step base,
  so `agent:main:explicit:…` differs each turn. `messageChannel=burble` routing
  stays intact because it is derived independently from the active route.
- Expected effect: `compactions=0`, `historyTextChars` ≈ one prompt (~8k) per
  turn, input tokens ~8k instead of ~22k, and **−26s** wall-clock (no compaction
  on the flush). Removes ~20.9k tokens/turn.
- Risk: low. Unit coverage now asserts two turns in the same Slack thread keep
  Burble channel routing but get different OpenClaw session keys; gateway HTTP
  retries also use fresh session keys per attempt so failed attempts do not
  re-bloat the step history. Still confirm with the E2E in step 5.
- **Decision check:** confirm product intent — Burble owning conversation memory
  (via `recentMessages`) is the current de-facto behavior, so this formalizes
  it rather than changing it.

### 2. Slim the per-turn prompt — token hygiene (secondary)

Even ephemeral, each turn ships an ~8–10k-char prompt dominated by the 56-tool
catalog and static boilerplate.

- Tools are already exposed to the agent via MCP (`tools/list count=56`).
  Audit whether `formatToolCatalog(...)` pasted into the prompt is redundant
  with the MCP tool registry; if so, drop or shrink it (names only, or rely on
  MCP). Move static skills/policy text to `systemPromptOverride`
  (`llm-config.ts`) — system instructions are not re-billed as conversational
  turns the way the `input` is.
- Expected effect: smaller per-turn input regardless of session strategy; also
  shrinks each step in multi-step tool turns.

### 3. Right-size the compaction/context budget — defense in depth

So a legitimately long *single* turn (multi-step tool loop) doesn't hit the tiny
default `cli_budget`.

- Add a model-sized context/compaction policy to the config patch
  (`buildOpenClawLlmPatch` / `openai.json5`). **Action item:** confirm the exact
  OpenClaw config schema keys against the installed version
  (`/usr/local/lib/node_modules/openclaw`) — the keys are not in this repo.
- Expected effect: compaction only when genuinely near the model limit; never on
  normal turns. Complements (not replaces) step 1.

### 4. Compaction off the response flush — latency (likely moot after 1–3)

The answer exists at 08s but is held until 41.97s behind a post-answer
compaction. If steps 1 & 3 land, compaction won't fire on normal turns so this is
moot; if upstream still runs maintenance compaction post-answer, investigate an
async/background-compaction option in OpenClaw so it never blocks the flush.
Note: the compaction fetch logs `timeoutMs=undefined` (unbounded) vs the real
call's `120000` — worth hardening regardless.

### 5. Verify + regression guard

- Add an E2E that sends N sequential turns in one channel and asserts
  `compactions=0` and `historyTextChars` stays bounded (no growth across turns).
- Capture before/after token + wall-clock for a "hello" turn and 1 multi-step
  tool turn.

## Expected outcome

| Metric (warm "hello") | Now | After step 1 | After 1+2 |
|---|---|---|---|
| Wall clock | ~44s | ~10–12s | ~8–10s |
| Total tokens | ~43k | ~9k | ~3–4k |
| Compactions/turn | 1 (every turn) | 0 | 0 |

Step 1 is the structural fix and the one that matters; 2–4 are hygiene and
hardening. None of this overlaps the startup plan — it is the dominant
steady-state cost after cold start.

## Cross-runtime comparison — is this OpenClaw-specific?

Yes. OpenClaw is the **only** engine that lets the runtime accumulate
server-side history under a stable cross-turn key. The others already follow the
"Burble owns conversation memory; runtime session is per-turn ephemeral" pattern
— which is exactly what fix #1 makes OpenClaw do.

| Engine | Session model | Cross-turn history | Thrash risk |
|---|---|---|---|
| `openclaw` / `openclaw-gateway` | **per-turn** session key after step 1 (`buildBurbleChannelSessionKey` still routes the Burble channel independently) | ephemeral after step 1; previously accumulated under a stable channel key | Fixed by step 1; verify with E2E |
| `nemo-hermes` | **per-run** `threadId` by default (`HERMES_BURBLE_SESSION_SCOPE="run"`, `entrypoint.py:506-516`) | ephemeral; none unless scope flipped | No (default) |
| `burble-direct` | **stateless** single call (`buildDirectModelRequest`, `instructions`+`input`, no session) | none — Burble owns 100% via prompt | No |
| `deterministic` | no LLM call | n/a | No |

Key observations:

- **Hermes already solved this.** It injects bounded recent context
  (`MAX_HERMES_CONTEXT_MESSAGES=12 × 300 chars`, same as OpenClaw) and defaults
  its thread to `run_id` (per-turn), so each turn is a fresh thread with no
  accumulation. It even reports `memory: False` in its capability manifest.
  OpenClaw's `buildBurbleChannelSessionKey` is effectively hardwired to Hermes's
  *non-default* `scope="conversation"` mode — the one that *would* accumulate.
- **`burble-direct` is the limit case** — fully stateless, Burble owns
  everything via the prompt. No server-side history, no compaction, ever.
- **Latent footgun in Hermes:** setting `HERMES_BURBLE_SESSION_SCOPE=conversation`
  would reintroduce the same stable-thread accumulation. If that mode is ever
  used, Hermes needs the same history-bounding guard (it has no compaction of
  its own — it relies on staying per-turn).

### Recommended cross-runtime invariant

Make this an explicit runtime contract for OpenClaw, Hermes, and any future
agent: **the runtime session/thread is per-turn ephemeral by default; Burble
owns conversation memory and re-injects bounded recent context each turn.** A
runtime may opt into owning durable memory only if it (a) bounds/compacts it and
(b) does not re-bill the full history on every turn. Today only OpenClaw
violates this; the fix aligns it with Hermes. New runtimes should default to
run-scope like Hermes, not channel-scope like OpenClaw.

## Open items

- Confirm OpenClaw config keys for an explicit context/compaction budget
  (step 3) against the deployed package version.
- Confirm no native-exec / scheduled-job path reads OpenClaw cross-turn session
  memory (step 1 risk check) — fold into the step-5 E2E.
- Decide whether the in-prompt tool catalog (step 2) can be dropped in favor of
  the MCP registry without regressing tool selection.
