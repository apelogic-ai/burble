# Plan: A real-boundary test layer

Status: working plan, motivated by an observed pattern. Companion to
[[providers-tools-generalization-plan]] and [[burble-native-harness-scope]].

## The evidence

Six consecutive PRs were all the **same class of bug** — something that passed
against mocks/probe and failed against a *real* boundary:

| PR | Bug | Real boundary that broke |
|---|---|---|
| #37 | strict-schema 400 | real request shape (`runtime.status`) |
| #38 | 401 | real auth (`x-burble-runtime-id`) |
| #39 → #40 | tools invisible to OpenClaw/Hermes | real cross-bridge reachability |
| #41a | GA Admin call failed | real provider API (invalid field mask) |
| #41b | `send_typing` crash | real platform ↔ adapter contract |
| #41c | `▉`/`■` glyph in user text | real Slack render |

This is not six unlucky bugs. It is **one systemic gap** — mock-heavy unit tests,
thin real-integration coverage — surfacing repeatedly. Each feature ships, then
sheds 2–3 real-boundary fixes. That is the patchwork loop.

## Diagnosis

The boundaries that keep breaking are exactly the ones our tests **mock or
probe**: the run-request schema, runtime auth, cross-bridge tool wiring, external
provider APIs, the runtime↔platform adapter contract, and the Slack render. A
seventh targeted fix does nothing for the eighth bug. The leverage is in building
guards at those boundaries.

## The four guards (build these instead of the seventh fix)

### 1. Provider-API contract tests (recorded-real responses)

- **Catches:** field masks, ID prefixes (`properties/…`, `presentations/…`),
  pagination, required params, error shapes, scope↔endpoint mismatches — the
  #41a class.
- **What:** cassette/VCR-style tests that replay *recorded real* provider
  responses (happy path + the common error shapes) for each tool, instead of
  hand-written mocks that can't know the real API's schema.
- **Lurking now:** the other five new GA/Slides tools (`runReport`,
  `getMetadata`, `slidesGetPresentation`, `slidesProbeTemplate`,
  `listProperties`) have identical untested exposure. Backfill cassettes for them
  first; require one for every new tool going forward.

### 2. Per-runtime → real Slack render e2e

- **Catches:** progress, streaming, typing, finalize, and cursor handling against
  each runtime's *actual* event shape — the #41b/#41c class.
- **What:** for each runtime (OpenClaw, Hermes, **burble-native**), run a real
  turn (chat + tool + stream) through the **real** Slack renderer and assert clean
  output: no stray glyphs, correct progressive text, correct finalization.
- **Lurking now:** Hermes just shed two render bugs here, and **native's render
  through real Slack is entirely untested** (flagged in the harness gap audit).

### 3. Tool-reachability + capability-honesty conformance

- **Catches:** a cataloged tool wired into some bridges but missing from others
  (the #39 → #40 class), and a manifest capability that isn't actually backed.
- **What:** extend the runtime conformance harness so that **every cataloged tool
  the manifest advertises is executable through every bridge mode the runtime
  declares** (tool_gateway / MCP / direct AI-SDK), and every claimed capability is
  exercised (already started for `toolCalls`/`scheduledProviderCalls`). Turns "a
  human notices it's broken in OpenClaw" into "CI fails."
- **Note:** `burble-native` is already catalog-driven and needs no per-tool wiring
  — it is the proof the generalization in [[providers-tools-generalization-plan]]
  removes this whole class. This guard protects the bridges that still exist.

### 4. Provider preflight / readiness

- **Catches:** the silent deploy-dependency class — required provider APIs not
  enabled (GA Admin/Data/Slides), or a user who hasn't reauthorized for new
  scopes, producing a mid-turn 403 in a real workspace.
- **What:** a provider analog of runtime readiness — verify granted scopes +
  required APIs are reachable, and surface "reconnect / enable X" instead of a
  cryptic 403 mid-turn.

## Related structural fix: replace the in-band cursor sentinel

Separate from the test layer, the Hermes streaming cursor (` ▉`/`■` embedded in
user-visible text and stripped everywhere) has now been patched **twice**
(`3a46359` trailing-only, then #41 all-glyphs). An in-band magic glyph that must
be scrubbed on every path is structurally leaky and **will** leak again. Fix the
shape, not the symptom: **do not carry the cursor in the text payload** — use a
separate streaming-state field, or have Hermes not append a visible glyph. Then
the strip-and-patch cycle ends.

## Sequencing (cheapest leverage first)

1. **Reachability/capability conformance (#3)** — extends an existing harness;
   immediately stops the wiring class and complements the providers generalization.
2. **Provider-API cassettes (#1)** — backfill the five lurking GA/Slides tools;
   then make a cassette mandatory per new tool.
3. **Per-runtime real-Slack-render e2e (#2)** — one test per runtime; closes the
   render class and the untested native path.
4. **Provider preflight (#4)** — the deploy-dependency guard.
5. **Replace the cursor sentinel** — independent, do alongside #2.

## What "done" looks like

- Adding a tool requires a cassette and passes the reachability conformance, or CI
  fails.
- Each runtime has a green "real turn → real Slack render" e2e.
- A workspace missing a required API/scope gets a clear reconnect prompt, not a
  mid-turn 403.
- The cursor glyph cannot appear in user text because it is no longer in the
  payload.

## Non-goals / discipline

- Not replacing unit tests — adding a thin real-integration layer at the
  boundaries that demonstrably break.
- Not hitting live external APIs in CI by default — record real responses once,
  replay them (live calls reserved for an opt-in nightly).
- Not over-building: these four guards map 1:1 to the six observed failures. Add a
  fifth guard only when a fifth failure class appears.

## One-paragraph summary

Six straight PRs fixed real-boundary bugs that mocks couldn't catch. The next
build is not a seventh fix but a **real-boundary test layer** — provider-API
cassettes, per-runtime real-Slack-render e2e, tool-reachability/capability
conformance, and provider preflight — plus replacing the leaky in-band cursor
sentinel. That converts a stream of reactive fix-PRs into a standing net, on the
systematic side of the patchwork-vs-systematic choice the data now decisively
favors.
