# Runtime Cold-Start Timing Analysis

Status: working notes. Empirical analysis from a single cold-start sample of
each runtime image.

Related: [[runtime-startup-readiness-notes]] — the architectural picture
behind these numbers.

## Sample

Two real cold-start log captures, one per runtime, taken on 2026-06-03.
OpenClaw container `burble-rt-…` running `engine=openclaw`. Hermes container
`burble-rt-083c19517356d3f7291325ea146b572f`.

## Terminology — two "Burbles"

There are two distinct things called "Burble" in this analysis. Disambiguation
matters because the cost lives in one of them, not the other:

1. **Burble the app** — the main TS/Bun service in its own container
   (`burble-app`, talks to runtimes over HTTP). Owns Slack, orchestration,
   the tool gateway. Its cold start is a separate problem; it is not in
   either of these logs.
2. **The Burble-facing wrapper inside the runtime container** — the contract
   adapter that exposes `/healthz`, `/capabilities`, `/runs`. For OpenClaw
   this is a Bun/TS process (`runtimes/openclaw-nemoclaw/src/index.ts`).
   For Hermes this is a Python aiohttp process
   (`runtimes/nemo-hermes/runtime/entrypoint.py`). Both runtimes have one
   of these. When this doc says "wrapper" it means this second thing.

## OpenClaw — annotated timeline

```
06:32:31.133  process start, runtime config read
06:32:31.140  onboard start                            ┐
06:32:37.395  onboard finish                           │  Phase 1: boot-time
06:32:37.396  config patch /etc/openclaw/.../openai.json5
06:32:42.153  patch finish                             │  ensureOpenClawSetup
06:32:42.160  config patch /data/.../burble-llm.json   │
06:32:47.055  patch finish                             │
06:32:47.055  agent identity start agent=main          │
06:33:12.294  agent identity finish                    │  ◀── 25.2s
06:33:12.303  config validate start                    │
06:33:15.664  config validate finish                   ┘
06:33:15.724  Burble runtime listening on :8080        ◀── /healthz green at +44.6s

06:33:16.352  onboard start                            ┐
06:33:23.207  onboard finish                           │
06:33:23.208  config patch /etc/openclaw/.../openai.json5
06:33:27.755  patch finish                             │  Phase 2: prepareNativeOpenClaw
06:33:27.756  config patch /data/.../burble-llm.json   │  (triggered by first /runs)
06:33:32.375  patch finish                             │  THE WHOLE SETUP, AGAIN
06:33:32.376  agent identity start agent=main          │
06:33:45.578  agent identity finish                    │  ◀── 13.2s
06:33:45.578  config validate start                    │
06:33:47.530  config validate finish                   ┘
06:33:47.531  gateway start                            ┐
06:33:48.957  [gateway] loading configuration…         │
06:33:49.263  [gateway] starting...                    │  Phase 3: NemoClaw binary
06:33:50.969  [gateway] starting HTTP server…          │  comes up
06:33:55.848  [plugins] loaded 1 plugin in 1085.8ms    │
06:33:55.875  [gateway] http server listening (6.6s)   │
06:33:56.225  [gateway] ready                          ┘  ◀── total +85.1s
```

**Total wall-clock from process start to gateway-ready: ~85 seconds.**

## Hermes — same scale, for contrast

```
06:42:41  model config provider=openai-api model=gpt-5.4
06:42:41  gateway started pid=7         ◀── Popen returns, no wait
06:42:41  Burble runtime listening      ◀── /healthz green at <1s
06:42:42  run start runId=6e2a6247      ◀── first /runs at +1s
06:42:42  run inject start
06:42:42  run events attached
[Hermes Gateway Starting... banner appears HERE — after /runs was accepted]
Burble Hermes platform adapter listening on 127.0.0.1:8766
```

## Findings

### 1. OpenClaw does the entire setup chain twice

Phase 1 (`ensureOpenClawSetup` at boot, `runtimes/openclaw-nemoclaw/src/index.ts:20`)
and Phase 2 (`ensureOpenClawSetup` inside `prepareNativeOpenClaw`,
`index.ts:37`) both run:

- the same `onboard` against the same workspace
- the same two config patches against the same paths
- the same agent-identity step
- the same `config validate`

Phase 1 takes 44.6s. Phase 2 takes 31.2s. About **31 seconds of cold start
is provably duplicate work**, paid right after the first `/runs` hits.

The user-perceived "OpenClaw is slow" is two distinct waits stacked:
- 44s before `/healthz` (visible to orchestrator) — wrapper running OpenClaw
  CLI setup commands once
- 31s before first turn (invisible until a user sends a message) — wrapper
  running the same OpenClaw CLI setup commands again
- ~9s gateway boot — wrapper spawning the OpenClaw binary as a resident
  gateway

Splitting these in observability would make the diagnosis obvious without
log spelunking.

### 2. Agent identity dominates everything else

25.2s on first pass, 13.2s on second pass — together ~38 seconds, or **~45%
of the total OpenClaw boot**. The second pass being faster (13s vs 25s)
suggests partial caching but not idempotency.

This time is spent **inside the OpenClaw binary** executing whatever the
agent-identity subcommand does. The TS wrapper is `await`-ing the subprocess.
What that subcommand actually does is unknown from the logs alone.
Hypotheses:

- network call (identity provisioning, registration, key exchange) — would
  be cacheable across container restarts;
- local crypto (key generation, identity setup) — should be cacheable by
  config hash, or pre-baked at image build time;
- combination of both.

Even halving this step would shave ~19s off cold start. **Highest-leverage
individual investigation target.** Optimization has to happen inside the
binary or by avoiding the invocation; the wrapper has no room to make this
faster on its own.

### 3. The resident NemoClaw gateway boots fast — but the binary is invoked many times before that

Once `gateway start` actually runs at 06:33:47.531, it reaches
`[gateway] ready` at 06:33:56.225 — **8.7 seconds total** for the resident
gateway boot, including a 1.1s plugin load and a 6.6s "http server listening"
duration.

But the 76 seconds before that is not idle TypeScript work. The TS wrapper's
own code is small (parse env, write JSON patch files, log lines). What it is
doing during those 76 seconds is **awaiting short-lived invocations of the
OpenClaw binary as one-shot CLI commands**:

- `openclaw onboard` — sets up the workspace.
- the agent-identity step — almost certainly a `openclaw <…>` subcommand.
- `openclaw config validate` — runs the validator.

Each invocation pays its own startup overhead inside the binary (load
configuration, resolve auth, etc.) on top of whatever work that subcommand
actually does. The 25.2s "agent identity" cost is wall-clock spent **inside
the OpenClaw binary**, not inside the TS wrapper.

Then, finally, the binary is invoked one more time — as `openclaw gateway
run` — and that invocation stays resident.

A more accurate restatement:

> **76 of the 85 seconds is the TS wrapper invoking the OpenClaw binary as
> short-lived CLI commands during setup (in two duplicate passes), before
> finally spawning it as a resident gateway. The wrapper's own TS code is
> fast; the cost is in the underlying binary being invoked many times
> instead of once.**

This matters for tweak design: optimizations live inside the binary's
behavior or in the wrapper's ability to skip invocations entirely. The TS
wrapper code itself has almost no slack to recover.

### 3a. Why Hermes does not have this shape

Hermes' Python wrapper does its setup too — `_install_plugin()` and
`_ensure_gateway_config()` run before the port opens — but these are pure
Python operations (copy a plugin directory, write a config file). There is
no equivalent of "shell out to the `hermes` CLI for onboard / identity /
validate" before the resident gateway is started. The NemoHermes binary
does its own internal setup as it boots the gateway.

So the structural asymmetry is:

|                                                  | OpenClaw         | Hermes |
|--------------------------------------------------|------------------|--------|
| Wrapper-side pure work (file IO, config write)   | small            | small  |
| Pre-gateway one-shot invocations of the binary   | **many, ~75s**   | **none** |
| Resident gateway sub-process                     | spawned at end, waited for | spawned at end, not waited for |
| `/healthz` green when                            | resident gateway reports ready | port binds |

This is a product-architecture difference, not a Burble integration choice.
OpenClaw ships as a CLI binary with subcommands (`onboard`, `agent`,
`config validate`, `gateway run`), and the documented provisioning model
is to compose those steps. NemoHermes ships as a binary that does all of
its own internal setup inside `gateway run`. The wrappers are faithfully
following each runtime's intended provisioning model.

### 4. Setup steps are strictly sequential when some could parallelize

Phase 1 ordering: onboard → patch1 → patch2 → identity → validate, each
waiting on the previous. The two config patches touch independent paths
(`/etc/openclaw/...` and `/data/openclaw/...`). If agent identity does not
depend on the patches, identity + patches could run concurrently and save
about 10s.

### 5. Hermes accepts /runs while its gateway is still booting

The "Hermes Gateway Starting..." banner appears between "run start" and "run
events attached" in the same logical second. The platform adapter
(`127.0.0.1:8766`) reports listening **after** `/runs` was accepted.

So Hermes is not "instant startup" — Burble accepted the first turn before
the NemoHermes binary was ready, and the turn raced through the gateway's
own startup. That race may be working by accident today and silently
failing some percentage of cold first turns.

### 6. Plugin metadata warning (cosmetic)

`[gateway] [plugins] channel "burble" registered incomplete metadata;
filled missing selectionLabel, docsPath, blurb` — the Burble channel plugin
at `/runtime/openclaw-plugins/burble-channel/index.js` is missing those
fields. Not a perf issue, just noise on every cold start.

## Tweaks worth doing, ranked

1. **Skip the duplicate Phase 2 invocations when nothing changed.** A marker
   file (`/data/openclaw/state/.setup-complete` with a config hash) or a
   content check on the patched files lets the wrapper skip Phase 2's
   OpenClaw CLI invocations entirely when the prior setup is still valid.
   The 31s saved on first turn is the biggest user-visible win — turns
   "OpenClaw took 75s to boot" into "OpenClaw took 44s to boot."
2. **Move the workspace onboard into the container image.** Phase 1's
   `onboard` is 6.3s of work that looks identical across cold starts on the
   same image (`workspace=/data/openclaw/workspace hasPatch=true`). Bake the
   workspace into the image at build time and this disappears.
3. **Profile the agent-identity step inside the OpenClaw binary.** Cannot be
   optimized without understanding what it does, but it is 45% of the
   budget. If network, cache. If local, pre-bake. Even halving it saves
   ~19s. The wrapper can't influence this — the work is in the binary.
4. **Parallelize Phase 1's CLI invocations.** Today the wrapper runs
   onboard → patches → identity → validate strictly sequentially, each
   awaiting the previous OpenClaw CLI invocation. The two config patches
   touch independent paths; if identity doesn't depend on them, the wrapper
   could fire patches and identity in parallel and save ~10s. Cheap to
   attempt.
5. **Make Hermes' /healthz honest.** Same as in
   [[runtime-startup-readiness-notes]]. The race is now demonstrated in
   these logs — Burble accepted `/runs` before the NemoHermes binary had
   finished booting. Trade "instant /healthz" for "reliable first turn."
6. **Bump `gatewayReadyTimeoutMs` from 60s to 120s.** The gateway reports
   ready 8.7s after spawn, well inside the 60s budget — but only because
   Phase 2 already absorbed most of the variance before spawn. If anything
   in `ensureOpenClawSetup` slows down, the timeout starts firing. Headroom
   is cheap.
7. **Fix the burble-channel plugin metadata** (`selectionLabel`, `docsPath`,
   `blurb`).

## Where to look first

The 25-second agent-identity OpenClaw CLI invocation. Biggest single item,
and the 13s second-pass cost suggests there is non-trivial work inside the
binary that is not cacheable today but probably could be. The combination of
#1 (skip duplicate Phase 2 invocations entirely) and partial caching of the
agent-identity step would land most of the available wins.

## Open questions

- What exactly does the OpenClaw binary do during the agent-identity
  subcommand — network call, local crypto, or both? (The 25s of cost lives
  inside the binary, not in the wrapper.)
- Which OpenClaw subcommands is the wrapper actually invoking during
  onboard / identity / validate, and are their results idempotent enough to
  be skipped via a marker file?
- Are the two config patches truly independent of the agent-identity step,
  so they can be parallelized safely?
- Why does Phase 2 re-run when Phase 1 has just finished — is the native
  config genuinely different from the resident config, or is this defensive
  re-run that can be skipped?
- Is there a `hermes` equivalent of `ensureOpenClawSetup` happening silently
  inside `_install_plugin()` / `_ensure_gateway_config()` that should be
  measured the same way for a fair comparison?
- How much of `onboard` is image-bakeable vs runtime-specific?
- Are first-turn races in Hermes (#5) producing any observable failures
  today — failed runs, retries, silent fallbacks?

## Sample caveat

These numbers come from one cold-start sample per runtime. Worth re-measuring
across several boots before treating any specific number as authoritative,
especially the 25.2s vs 13.2s agent-identity gap, which could be sensitive to
network conditions, cache state, or host load.
