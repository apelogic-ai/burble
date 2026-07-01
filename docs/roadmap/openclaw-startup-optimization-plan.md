# OpenClaw Startup Optimization Plan

Status: working plan. **Updated 2026-06-03 with real traces** — see "Re-measurement"
and the **"Clean separated measurement + revised plan"** below, which supersede the
single-sample numbers in the rest of this doc. Three things changed the picture:
agent-identity is now *gone* (the plan's biggest lever, done); the duplicate setup
pass is *not* closed by the cache (~16s); and — the key new finding — for
`engine=openclaw` the gateway starts **lazily on the first message**, so ~35s of
cost lands on the user's first reply, not on startup. The #1 fix is now **make the
gateway eager / `/healthz` honest**.

Related: [[runtime-cold-start-timing-analysis]] (the timing sample),
[[runtime-startup-readiness-notes]] (the readiness-contract picture). Both of
those predate the setup cache described below and should be read with that
caveat.

## Re-measurement (2026-06-03 — real cold-start trace)

Live trace of `engine=openclaw` (`burble-rt-34b5…`), process start → gateway ready.
This replaces the single pre-cache sample the rest of this doc was built on.

| Phase | Original (~85s sample) | **This trace** | Δ |
|---|---|---|---|
| **Phase 1: boot → `/healthz`** | 44.6s | **17.2s** | **−27s** |
| ↳ onboard | 6.3s | 6.0s | — |
| ↳ config patch ×2 | ~9s | ~9.2s | — |
| ↳ **`agents set-identity`** | **25.2s** | **0s — step removed** | **−25s** |
| ↳ validate | 3.4s | 2.0s | — |
| **Phase 2: duplicate setup** | 31.2s | **17.1s — still a full re-run** | −14s |
| ↳ agent identity (2nd pass) | 13.2s | **0s — removed** | −13s |
| **Phase 3: gateway boot** | 8.7s | **19.7s** | **+11s** |
| ↳ burble-channel plugin load | 1.1s | **9.9s** | **+8.8s ⚠️ regression** |
| **Total (process → gateway ready)** | **~85s** | **~54.9s** | **−30s** |

What the trace establishes:

1. **The agent-identity step is eliminated** (no `agent identity start/finish`
   lines). This was the plan's highest-leverage item (Tier 2) and the timing doc's
   "gating unknown." Folding identity into the declarative config patch worked. It
   is the entire ~30s improvement. **Done.**
2. **The duplicate Phase 2 setup still runs (~17s).** `onboard start` fires 0.9s
   after `runtime listening`, and the full chain (onboard → patch ×2 → validate)
   repeats. There is **no `OpenClaw setup cached` log line**, so the setup cache is
   either not in this deployed image or its key is not matching across the two
   passes. This is now the **#1 remaining waste** — and it contradicts the
   "duplicate-setup problem closed" claim further down (see correction below).
3. **New regression: the burble-channel plugin load is 9.9s** (`loaded 1 plugin in
   9897.8ms`), up from 1.1s in the original sample. It now dominates gateway boot
   (the gateway's own "http server listening (17.3s)" is mostly this). Not in the
   original plan because it didn't exist then.

### Correction to "the setup-runs-twice finding is closed"

The section below titled *"Consequence: the 'setup runs twice' finding is
effectively closed"* is **wrong as of this trace.** The duplicate Phase 2 pass is
still happening for `engine=openclaw`, and the cache is not short-circuiting it.
Treat that section as the *intended* design, not the *observed* behavior, until the
cache is verified to hit (see Tier 1, item 0 below).

### Re-ranked remaining work (post-trace)

| Rank | Item | Est. win | Status vs plan |
|---|---|---|---|
| 1 | **Kill the duplicate Phase 2 setup** — make the cache actually hit | ~17s | was doc finding #1; still open |
| 2 | **Investigate the 9.9s plugin load** (was 1.1s) | ~8s | new — not in original plan |
| 3 | Take `config validate` off the critical path | ~4s (2s × 2) | Tier 1, open |
| 4 | Fix burble-channel plugin metadata warning | cosmetic | Tier 1, open |
| — | Eliminate `agents set-identity` | ~38s | **Tier 2 — DONE** |

## Clean separated measurement + revised plan (2026-06-03, later trace)

A second trace separated the two paths that the first trace ran together. For
`engine=openclaw` the gateway is **lazy** — it (and a *second* full setup pass)
fire on the **first message**, not at boot. So the cost splits cleanly:

### Startup (boot → `/healthz` green): ~17.9s

| Step | Time |
|---|---|
| onboard | 6.67s |
| config patch ×2 | 9.18s |
| validate | 2.01s |
| **→ runtime listening / `/healthz` green** | **+17.88s** |

No identity, no gateway. **But this "ready" is dishonest for `engine=openclaw`** —
the agent stack has not started; `/healthz` is green while nothing can serve a turn.

### First message (wake → first model token): ~49.6s

| Segment | Time | Note |
|---|---|---|
| **Duplicate setup** (onboard + patch ×2 + validate, again) | **16.4s** | pure waste, on the user's critical path |
| **Gateway cold boot** | **18.8s** | incl. **plugin load 9.4s** |
| Agent / MCP / cold-extension warm-up + planning | ~12.6s | MCP init 0.4s; rest is cold loads of openai / memory-core / harness + planning |
| Actual model call (fetch → 200) | **1.76s** | the only "real work" |
| **Total wake → first token** | **~49.6s** | |

### The finding: lazy gateway makes `/healthz` lie and dumps ~35s on the first reply

`/healthz` is green at **17.9s**, but the first reply costs **~49.6s** to first token,
of which only **~1.8s** is the LLM call. ~35s of that (duplicate setup + gateway boot +
cold extension warm-up) is deferred startup cost paid on the user's first message.
This is the exact failure mode [[runtime-startup-readiness-notes]] warns about —
`engine=openclaw` is currently the **worst of both**: reports `wrapper-up` early
*and* makes the first turn pay `whole-stack-up`. (Stability check: the 9.4s plugin
load is real, not noise — a *warm* re-load later in the same log is **6.9ms**.)

### Revised plan (ranked by first-message impact)

| Rank | Change | Mechanism | Win |
|---|---|---|---|
| **1** | **Make the gateway eager / `/healthz` honest** | Start the gateway at boot (or run `engine=openclaw-gateway`, which already does this) and report `/healthz` ready only when the whole stack is ready | Moves gateway boot (~18.8s) **and** cold extension warm-up (~9s) off the first message into startup. First-message latency → roughly planning + model call (~6–8s). Cost: startup-to-true-ready ~37s, paid once, off the user's path |
| **2** | **Kill the duplicate setup** | Make the setup cache hit on pass 2 (verify it's deployed and the key matches across passes), or simply don't re-run setup when the gateway lazily starts | −16.4s off the first message (it is *on* the critical path, not background) |
| **3** | **Profile / fix the 9.4s plugin cold-load** | Investigate what `burble-channel/index.js` does at module load; warm re-load is 6.9ms, so it is entirely cold first-load cost | −~9s (subsumed by #1 if the gateway boots at startup, but still worth fixing) |
| **4** | **`config validate` off the critical path** | `OPENCLAW_VALIDATE_ON_START=false`, or validate after the port opens | −~2s per setup pass |
| **5** | Fix burble-channel plugin metadata warning | fill `selectionLabel`, `docsPath`, `blurb` | cosmetic |

**Net:** #1 is the structural fix — it converts "fast-but-fake `/healthz` + 49.6s first
reply" into "honest ~37s startup + ~6–8s first reply." #2 is independently worth 16.4s
and should land regardless. Together they take first-message latency from ~49.6s to
single digits. The earlier-ranked "duplicate setup" item is re-confirmed but its
*severity is higher than first thought* — it is time the user waits through, not
background work.

## Cross-runtime image rollout requirement

This is not OpenClaw-specific, but it becomes important before any runtime work
ships to production: Burble needs a controlled way to update runtime images
without disrupting already-running personal runtime containers.

Current dev behavior is intentionally blunt: `deploy-personal-runtimes.sh`
rebuilds the selected runtime image and removes existing `burble-rt-*`
containers so the next turn creates a container from the latest local image.
That is useful for hand testing, but it is not a production rollout model.

Target production behavior:

1. **Image identity must be explicit.** Runtime records should know the image
   reference or image digest they were created with, not only the engine.
2. **Existing containers keep running.** Publishing a new runtime image should
   not kill active containers immediately. New runtimes should use the new image;
   old runtimes can drain naturally, restart on idle, or restart when explicitly
   requested.
3. **Rollout policy must be configurable.** Burble should support at least:
   `new-runtimes-only`, `restart-idle`, and `force-recreate` modes. Production
   should default to non-disruptive rollout; dev can default to force-recreate
   for fast feedback.
4. **Compatibility must be checked.** If a new image changes the runtime
   capability manifest or policy hash semantics, Burble should record that and
   decide whether affected runtimes can continue, need graceful restart, or must
   be blocked.
5. **Dev should model production.** The dev deploy script should compare the
   selected runtime image before and after rebuild. If the runtime image ID is
   unchanged, it should rebuild/restart only Burble and keep existing personal
   runtime containers. If the runtime image ID changes, it should rebuild the
   image and restart only the existing runtime containers that were actually
   created from the previous image. Keep a force-reset path explicit for local
   testing, but do not make blanket runtime deletion the default lifecycle.

This likely belongs in the runtime factory layer, not in individual runtime
images. OpenClaw, Hermes, and future runtimes should all get the same rollout
semantics from Burble's control plane.

## What changed since the timing docs were written

The two timing docs were captured from pre-cleanup logs. Two things in the
committed code now change the picture materially:

1. **A setup cache exists.** `ensureOpenClawSetup`
   (`runtimes/openclaw-nemoclaw/src/setup.ts:12`) computes a SHA-256 key over
   `{ engine, command, agent, stateDir, configPath, workspaceDir,
   configPatchPath, patchHash, generatedLlmPatchHash, validateOnStart, llmModel,
   ollamaBaseUrl, fastMode }` (`setup.ts:265`) and writes a marker to
   `<stateDir>/.burble-openclaw-setup.json` (`setup.ts:324`). On a matching key
   it returns early with `OpenClaw setup cached` (`setup.ts:28-32`), skipping
   onboard + patches + identity + validate entirely.

2. **The marker lives on a persistent volume.** The container factory mounts
   `{ source: <dataRoot>/<runtimeDataId>, target: "/data/openclaw" }`
   (`src/agent/container-runtime-factory.ts:524`) and the state dir defaults to
   `/data/openclaw/state` (`runtimes/openclaw-nemoclaw/src/config.ts:82`). So the
   marker **survives container restarts for the same runtime**.

### Consequence: the cold-start landscape is now bimodal

| Scenario | Setup chain (~44s) | Gateway boot (~9s) | Total |
|---|---|---|---|
| **New runtime** (fresh volume) | runs in full | runs | ~53s |
| **Restart** (existing volume, cache hit) | **skipped** | runs | **~9s** |

### Consequence: the "setup runs twice" finding is effectively closed

[[runtime-cold-start-timing-analysis]] finding #1 ("OpenClaw does the entire
setup chain twice", ~31s of duplicate work) only ever applied to
`engine=openclaw` (the per-step CLI path). For `engine=openclaw-gateway` — the
real resident runtime path — the gateway is spawned only for that engine
(`gateway.ts:34`) and `prepareNativeOpenClaw` is a no-op (`index.ts:24-34`), so
there was never a duplicate pass there. For the `openclaw` CLI engine the second
pass is now a cache hit. **No further work is needed on the duplicate-setup
problem.**

## Where the time actually goes now (cold start, new runtime)

`ensureOpenClawConfig` runs strictly sequentially (`setup.ts:82-116`):

| Step | ~Cost | Per-runtime variance | Source |
|---|---|---|---|
| `onboard` | 6s | **none** (static workspace + generic flags) | `setup.ts:37-67` |
| config patch #1 (static `/etc/openclaw` patch) | ~4.5s | none | `setup.ts:82-89` |
| config patch #2 (generated LLM patch) | ~4.5s | **yes** (model/tokens/URLs) | `setup.ts:91-95` |
| `agents set-identity` | ~25s | **none** (`--name Burble --theme "Slack assistant" --emoji :robot_face:`) | `setup.ts:199-230` |
| `config validate` | ~3s | none | `setup.ts:103-116` |
| gateway boot | ~9s | none (inherent NemoClaw startup) | `gateway.ts` |

The decisive observation: **onboard + `set-identity` (~31s, ~60% of cold start)
are byte-identical for every runtime.** Only the generated LLM patch is
per-runtime. Everything static is a candidate to move to build time or a
one-time seed.

These numbers come from a single pre-cache sample (see the timing doc's "Sample
caveat"). Tier 0 below replaces them with real per-phase measurements before we
commit to the expensive changes.

## The gating unknown

**What does `agents set-identity` actually do for ~25s, and where does it
write?** This is the timing doc's top open question, still unanswered, and it
decides the Tier 2 mechanism:

- **Local (file/keygen) writing outside the mounted volume** (e.g. under `HOME`,
  which `process-env.ts:2` forwards) → bake it into the image.
- **Local writing into the mounted `/data/openclaw` volume** → a baked copy is
  shadowed by the mount; seed-on-first-boot instead.
- **Network call (registration/key exchange)** → result is still static; do it
  once at build time or cache globally rather than per runtime.

Separately: an earlier cleanup attempt folded identity into the declarative
config (`buildOpenClawNemoClawAgentConfig` carries an `identity` block,
`setup.ts:149-156`) but it was reverted, and openclaw-backed engines still apply
`buildOpenClawLlmPatch` (`setup.ts:237`), not the agent-config builder. If the
patch route *can* set identity, that deletes the 25s CLI call with no Dockerfile
change — the cleanest possible fix. **Find out why it was reverted.**

## Plan

### Tier 0 — Instrument before optimizing further (do first)

Optimize against real data, not the single pre-cache sample.

- Wrap each step in `ensureOpenClawConfig` with `Date.now()` deltas; emit
  `openclaw.setup.phase` events (onboard / patch1 / patch2 / identity / validate
  / gateway) plus `cacheHit: boolean` and `engine`.
- Capture **cold (fresh volume) vs warm (restart)** for `openclaw-gateway`
  specifically.
- This satisfies the timing doc's "split the observability" ask and confirms
  whether identity is still the long pole after the cache.

### Tier 1 — Cheap, safe, no investigation required

Ship together; each is independent and low-risk.

1. **Take `config validate` off the critical path** (~3s). Gated by
   `OPENCLAW_VALIDATE_ON_START` (`setup.ts:98`, default true). Either set it
   false in production, or run it after the port opens (fire-and-forget, log
   failures) so it does not block readiness.
2. **Parallelize the two patches with `set-identity` if independent**
   (`setup.ts:82-96`). `onboard` must precede them, but patch application and
   identity may be concurrent → up to ~9s. Confirm independence with the Tier-0
   timings before landing.
3. **Bump `gatewayReadyTimeoutMs` 60s → 120s** (`gateway.ts:27`). Pure
   reliability headroom; the gateway reports ready ~9s in, but variance is real.
4. **Fix `burble-channel` plugin metadata** (`selectionLabel`, `docsPath`,
   `blurb`). Cosmetic; removes the warning on every cold start.

Expected reclaim: ~12–15s plus reliability headroom.

### Tier 2 — The big lever ✅ DONE (as of 2026-06-03 trace)

> **Resolved: the `agents set-identity` step is gone** — see Re-measurement above.
> The "Best case" mechanism below (declarative identity via the config patch) is
> what landed, saving ~38s across both passes / ~30s of total cold start. The
> open question "what does set-identity do for 25s" is now moot. The remaining
> Tier 2 ideas (bake onboard into the image, mount narrower subpaths) are
> *optional further* wins, no longer the critical path.

**Move the static setup (onboard + identity) out of every cold start; leave
only the per-runtime LLM patch at runtime.** Target: ~53s → ~18s (patch +
gateway) for a new runtime.

Mechanism depends on the investigation result:

- **State lives outside the mounted volume:** add `RUN openclaw onboard … &&
  openclaw agents set-identity …` to the `Dockerfile` (today it bakes nothing —
  just copies `src`, `runtimes/openclaw-nemoclaw/Dockerfile`), mount only the
  per-runtime `state`+`config` subpaths instead of all of `/data/openclaw`, and
  set `OPENCLAW_SETUP_ON_START=false` so runtime does only the LLM patch +
  gateway.
- **State must live in the mounted volume:** bake a template tree into the image
  and have the entrypoint copy it into an empty volume on first boot. A file
  copy is far cheaper than 25s of CLI work; the setup cache then keeps it skipped
  on restarts.
- **`set-identity` is a network call:** do it once at build time (preferred) or
  cache the artifact globally instead of per runtime.
- **Best case — declarative identity works:** make the applied patch set
  identity (revisit the reverted `buildOpenClawNemoClawAgentConfig` route) and
  delete the `set-identity` CLI invocation outright. No Dockerfile change.

Expected reclaim: ~25–31s on new-runtime cold start.

### Tier 3 — Readiness-contract change (optional, hold for now)

The [[runtime-startup-readiness-notes]] "lazier setup-on-start" idea: open port
8080 before `ensureOpenClawSetup`, do setup on first `/runs` (Hermes-style).
Makes `/healthz` green fast but moves the wait onto the first turn and adds a
first-turn race.

**Recommendation: hold.** With the setup cache, restarts are already ~9s, so the
only beneficiary is brand-new runtimes, which Tier 2 attacks more honestly. If
revisited, also make the runtime contract *specify* what `/healthz` means
(whole-stack-up vs wrapper-up) so OpenClaw and Hermes stop diverging.

## Recommended sequencing

1. Tier 0 instrumentation — validate/replace the one-sample numbers, confirm
   identity is still the long pole post-cache.
2. Tier 1 quick wins — independent, low-risk, ship together.
3. Identity investigation — the gate for Tier 2.
4. Tier 2 per the investigation result — the big new-runtime win.

## One-paragraph summary

The setup cache plus the persistent volume already turned the common case
(restart) into ~9s and closed the duplicate-setup problem the timing doc flags
as #1. The real remaining target is the **first cold start of a new runtime
(~53s)**, and within it the **~31s of fully-static work (onboard + set-identity)**
that has no reason to run per-runtime. Tier 1 reclaims ~12–15s safely now; Tier 2
reclaims the static ~31s once we know what `set-identity` actually does. The
agent-identity step remains the single highest-leverage unknown — exactly the
timing doc's conclusion, now scoped to new-runtime creation rather than every
boot.

## Open questions

- What does `agents set-identity` do during its ~25s — local file/keygen, or a
  network call? Where does it write (mounted volume vs `HOME` vs elsewhere)?
- Why was the declarative-identity approach (`buildOpenClawNemoClawAgentConfig`
  identity block) reverted? Did the applied patch fail to set identity, or did
  `config validate` reject it?
- Are the two config patches and `set-identity` truly independent, so they can
  run concurrently?
- How much of `onboard` is genuinely image-bakeable vs runtime-specific given
  the `/data/openclaw` volume mount shadows baked content?
- Post-cache, what are the real cold-vs-warm numbers for `openclaw-gateway`
  (the production engine), across several boots rather than one sample?
