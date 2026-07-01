# Burble Future Scope: OpenShell-Centered Architecture

Status: draft for discussion. Date: 2026-06-17.
Trigger: NVIDIA reframing — OpenShell (their OSS hardened agent sandbox) is the
product/standard; NemoClaw/NemoHermes are reference implementations.

## TL;DR

Stop owning the sandbox. **Fork OpenShell, track it, contribute upstream**, and
make it Burble's isolation substrate. **Adopt** the NemoClaw reference runtime
architecture (with OpenClaw and Hermes as the agents that run in it) instead of
**forking** it. Concentrate all Burble investment in the **control plane** —
identity, tenancy, credential policy, the MCP/provider gateway, tool
authorization, conversation/delivery, scheduling, and visibility policy — which
is the moat and the part OpenShell deliberately does not do.

Do not wait for OpenShell to fix the pain we already understand. The immediate
"stop the bleeding" work is control-plane/runtime-contract hardening: trusted
job identity, visibility/destination policy, provider-bridge exposure, leaked
tool transcripts, and cross-runtime conformance fixtures. That work starts now
and stands even if the OpenShell bet slips.

The recurring security pain (the web-extract SSRF, runtime-to-runtime
reachability, weak credential boundary) is a **missing-sandbox-primitive**
problem, not an app-bug problem. OpenShell makes those whole classes
policy-enforced. The recurring *policy* pain (jobId identity, private-read →
public-channel) stays in Burble — but must be lifted out of runtime prompts and
into the control plane.

## Terminology (interpretation — confirm)

These names are easy to conflate; this is how this doc uses them. **Flagged
ambiguity:** the directive said "OpenClaw at the center of hardened runtimes" —
this doc reads that as *OpenShell* being the hardening substrate at the center,
with OpenClaw/Hermes as adopted agents. If "OpenClaw" was meant literally as the
primary adopted agent, the allocation below is unchanged.

| Name | What it is | Our stance |
|---|---|---|
| **OpenShell** | NVIDIA OSS hardened agent **sandbox**: Gateway, Policy Engine, L7 egress filtering, Providers (env-injected creds), Privacy Router, container/microVM isolation. | **Fork + track + contribute.** Isolation substrate. |
| **NemoClaw / NemoHermes** | NVIDIA **reference runtime architecture** — how an agent runtime is packaged to run inside OpenShell. | **Adopt, do not fork.** |
| **OpenClaw / Hermes** | The open **agent runtime engines** (per-turn agent loops). Today in-repo as `openclaw-nemoclaw`, `nemo-hermes`. | **Adopt as the agents** within NemoClaw. Stop maintaining a fork. |
| **Burble** | Our **control plane + product**: tenancy, credential policy, MCP/provider gateway, conversation/Slack UX, scheduling, visibility policy. | **Build. This is the moat.** |

## Target architecture

```
                         Users  (Slack, future: API / other surfaces)
                                        │
        ┌───────────────────────────────▼────────────────────────────────┐
        │  BURBLE CONTROL PLANE   — build / opinionated (the moat)         │
        │   • Identity & multi-tenancy (workspace · user · business-agent) │
        │   • Credential policy + OAuth lifecycle + vaulting               │
        │   • MCP / provider gateway: curated catalog, allowlisting,       │
        │     result sanitization                                          │
        │   • Conversation routing & Slack UX · destination grants         │
        │   • Scheduling / durable jobs                                    │
        │   • Visibility / classification / taint policy                   │
        │   • Observability · audit · usage accounting                     │
        └───────────────┬─────────────────────────────────────────────────┘
                        │  Burble runtime contract  (/runs, events,
                        │  tool-gateway callback)  ── the SOLE sanctioned
                        │                              egress target ──────┐
        ┌───────────────▼──────────────────────────────────────────────┐  │
        │  OPENSHELL  (forked from NVIDIA; we track + contribute)        │  │
        │   Gateway · Policy Engine · L7 egress · Providers · Privacy    │  │
        │   Router                                                       │  │
        │   ┌──────────────────────────────────────────────────────┐    │  │
        │   │  NemoClaw reference runtime architecture (adopted)     │    │  │
        │   │     agents:  OpenClaw   ·   Hermes                     │    │  │
        │   └──────────────────────────────────────────────────────┘    │  │
        │   isolation: container / microVM · fs allow-paths ·            │  │
        │   syscall confinement · egress ENFORCED ──────────────────────┼──┘
        └────────────────────────────────────────────────────────────────┘
                        │
                        ▼  egress allowed ONLY to: Burble gateway,
                           approved LLM endpoint(s); public web access goes
                           through a Burble gateway-brokered web provider
```

The key topology decision: **Burble's gateway lives outside the sandbox, and
OpenShell egress policy makes it the default sanctioned destination.** Raw
internet is not the normal answer for "public data" jobs; public web access is a
Burble capability brokered through the gateway. That turns the "no network
isolation / runtime-to-runtime reachable" gap from
`runtime-isolation-penetration-review` into a policy-enforced invariant without
moving SSRF risk into each runtime.

## Responsibility allocation matrix

Legend: **OS** = OpenShell (adopt/fork, don't reinvent) · **RT** = NemoClaw +
OpenClaw/Hermes (adopt) · **B** = Burble control plane (build, opinionated).

| Aspect | Owner | What it means / why | Don't reinvent |
|---|---|---|---|
| Process & syscall confinement | **OS** | Kernel-level priv-esc/syscall blocking. | Delete any home-grown attempt. |
| Filesystem isolation | **OS** | Allow-path read/write, locked at sandbox create. | — |
| **Network egress filtering** | **OS enforces / B defines policy** | Default egress is Burble gateway + approved LLM. Public web is a gateway-brokered Burble provider; raw host egress is a rare explicit policy exception. OpenShell enforces the boundary. | **Delete `_is_safe_url` / per-tool egress guards only after** the gateway-brokered provider + sandbox egress invariant is green. |
| Sandbox lifecycle / provisioning | **OS** (`sandbox create`) orchestrated by **B** | Burble decides *when/for-whom*; OpenShell does the *how*. | Retire per-engine `container-runtime-factory` env blocks + Docker provisioning. |
| Credential storage *in* sandbox | **OS Providers** (backstop) | Env-injected, never on disk. | — |
| **Credential policy / OAuth lifecycle / vaulting** | **B** | Which principal gets which scopes; refresh; revocation. **Prefer: tokens NEVER enter the sandbox** for curated providers (callback model); OpenShell Providers only as backstop / raw long-tail. | — |
| Identity / principal | **B** | workspace · user · business-agent. Runtime stays unaware. | — |
| Multi-tenancy model | **B** maps to **OS** isolation | Burble owns principal→sandbox mapping & policy; OpenShell provides the isolation mechanism. | — |
| Agent loop / reasoning | **RT** | OpenClaw/Hermes inside NemoClaw. | **Stop forking NemoClaw / `openclaw-nemoclaw`.** |
| Inference routing / model choice | **B** (model-agnostic) · **OS** Privacy Router optional | Burble stays multi-model (Anthropic/OpenAI/…). | Don't hard-couple to NVIDIA inference via the sandbox. |
| Tool transport (MCP / tool-gateway) | **B** | The gateway + MCP server. OpenShell egress *permits* it. | — |
| **Provider tool catalog & integrations** | **B** | GitHub/Google/Jira/Slack/HubSpot, declarative specs. Core moat. | — |
| Tool authorization / per-job allowlisting | **B** | `requiredTools`, scheduled-job capabilities. | — |
| Result sanitization | **B** | Scrub provider outputs before they reach the model/channel. | — |
| Conversation routing & delivery | **B** | Slack UX, threads, DMs, channel posting, destination grants. | — |
| Scheduling / durable jobs | **B** owns · **OS** gap | Burble owns the product logic; OpenShell needs **durable/long-lived sandboxes** → *contribute upstream*. | — |
| **Visibility / classification / taint** | **B** policy · **RT** tags · **OS** Privacy Router partial | private-read → public-channel rules live in Burble. **Lift out of runtime prompts** (e.g. `entrypoint.py` policy strings). | — |
| Observability / audit / accounting | **B** product-level · **OS** sandbox-level events | Burble correlates; OpenShell emits sandbox events. | — |
| Runtime ingress auth | **OS** network isolation + **B** bearer on contract | Pen-test gap closed by OpenShell topology + required bearer tokens. | Stop relying on `x-burble-runtime-id` header alone. |
| Runtime contract / conformance | **B** contract · **OS** sandbox contract · **RT** packaging | Converge `@burble/runtime-sdk` deploy target onto an OpenShell sandbox; conformance = "runs correctly under OpenShell policy." | — |

## Stop building / delete (once the replacement is proven)

- Home-grown network/SSRF guards in runtimes/tools (`burble-web-extract/_is_safe_url`, DNS-rebinding patches) → gateway-brokered web provider + OpenShell egress enforcement. Delete only after invariant tests prove the sandbox cannot bypass the broker.
- Per-engine `container-runtime-factory` provisioning & env blocks → `openshell sandbox create`.
- Logical-only PoC3 isolation → OpenShell hard isolation (container/microVM, syscall, fs).
- Runtime-to-runtime network reachability and unauthenticated `/runs` → OpenShell network policy + bearer auth.
- The `openclaw-nemoclaw` **fork** maintenance → adopt NemoClaw reference arch.
- `burble-direct` in-process bypass → already slated for removal; do it.

## Stay opinionated (Burble must own — the moat)

- Identity & tenancy, including the `BusinessAgentPrincipal` lift (service-agents notes).
- Credential **policy** + the never-in-sandbox callback model for curated providers.
- MCP / provider gateway + curated catalog + per-job allowlisting + sanitization.
- Conversation / Slack UX + delivery routing + destination grants.
- Scheduling / durable jobs (and push the durable-sandbox requirement upstream).
- Visibility / classification / taint policy (lifted out of runtimes).
- Observability, audit, usage accounting.

## Two integration seams (decide explicitly)

1. **Gateway topology + brokered egress capabilities.** Burble gateway sits *outside*
   the sandbox; OpenShell egress policy makes it (plus the approved LLM endpoint)
   the default sanctioned destination. Crucially, **web access is a
   gateway-brokered capability, not a raw egress hole**: the default is
   "sandbox reaches only the gateway + LLM," and outbound web is mediated by a
   Burble web-search/extract provider behind the gateway.

   The normal modes are intentionally few:
   - `provider-callback-only` (default) — gateway + LLM only.
   - `web-brokered` — web search/extract via the Burble web provider, where URL
     safety, SSRF checks, logging, rate limits, and result sanitization live.
   - `no-network` — for jobs that need no external access.

   Raw host egress is an exceptional, explicit, audited policy for rare
   long-tail/dev cases, not a standard tier. So a "public AI news" job gets
   brokered web, not arbitrary internet. This *is* the network isolation we
   lacked, expressed as gateway capability policy rather than per-tool guards.
2. **Credential model.** Keep Burble's "tokens never enter the sandbox, callback
   with runtime-scoped JWT" for curated providers (stronger, and it's the policy
   seam). Use OpenShell Providers + egress as a backstop and for raw/long-tail
   access. Do **not** blindly env-inject provider OAuth tokens into the sandbox.

## Codebase deltas (high level)

- `@burble/runtime-sdk`: extract as planned, but make the deployment target "an
  OpenShell sandbox." Adapters for OpenClaw/Hermes become thin.
- Replace `container-runtime-factory` engine branches with OpenShell sandbox
  orchestration.
- Move provider-tool specs and egress policy to declarative config consumed by
  Burble's gateway and OpenShell's egress compiler (single source of truth). The
  web-search/extract provider is a gateway capability, not runtime-local code.
- Lift Burble policy (visibility, destination, jobId identity) fully into the
  control plane; strip policy prose from runtime entrypoints/prompts.
- Maintain an OpenShell fork with a clean upstream-tracking branch + a
  contributions backlog (durable sandboxes, multi-tenant Gateway, principal model).

## Avoiding OpenShell lock-in (prefer, don't depend)

Principle: **treat the sandbox the way Burble already treats the runtime
engine** — a swappable provider behind a contract, kept honest by more than one
implementation and a conformance suite. Burble proved the *runtime* contract was
engine-neutral by running both OpenClaw and Hermes; we apply the same discipline
one layer down, to the *sandbox*. We prefer OpenShell and invest in it, but the
architecture must let us re-target in bounded time if its governance, roadmap, or
licensing turn against us. Six concrete mechanisms:

1. **A Burble Sandbox Interface (port/adapter).** Core talks to a narrow
   `SandboxProvider` port — `provision · applyPolicy · bindCredentials ·
   run/attach · streamEvents · terminate · capabilities()` — defined in terms of
   the *guarantees we need* (isolation, egress allowlist, credential boundary,
   lifecycle), not OpenShell's API shapes. OpenShell is the first adapter. No
   OpenShell type may appear in core, enforced by an import/lint rule.

2. **Policy is ours, compiled down.** The egress allowlist, credential/provider
   bindings, fs allow-paths and resource limits live in a Burble-owned,
   vendor-neutral declarative schema. A compiler emits OpenShell's egress YAML +
   Providers config. Swapping substrate re-targets the compiler, not the policy.
   Bonus: it's the single source of truth shared with the gateway, so the SSRF
   allowlist is expressed exactly once.

3. **A second, deliberately-maintained adapter.** Keep one alternative
   implementation alive — even degraded (local Docker/gVisor dev mode, or a real
   second substrate such as Firecracker/Nexus). Its only job is to keep the
   interface honest: the moment something OpenShell-specific leaks into core, the
   second adapter breaks and tells us. Same role Hermes played for the runtime
   contract.

4. **Capability negotiation + graceful degradation.** The port exposes a
   capability manifest (microVM? L7 egress? durable sessions? GPU?). Burble
   negotiates and degrades — surfacing reduced assurance rather than failing — so
   a weaker substrate still runs. Mirrors the existing runtime capability-manifest
   pattern.

5. **Vendor-neutral invariant conformance suite.** Our harness asserts the
   *security invariants* against any adapter: egress actually blocks the
   disallowed (incl. the SSRF/DNS-rebinding case), credentials never hit disk,
   runtime-to-runtime is blocked, lifecycle is clean. The invariants are ours; the
   implementation is theirs. Catches any adapter — OpenShell or other — regressing.

6. **Fork hygiene + reversibility budget.** Fork OpenShell on a clean
   upstream-tracking branch; keep our diffs minimal and upstream them rather than
   carrying patches, so we can rebase. Keep durable state (jobs, vault, sandbox
   metadata) in Burble's stores, never inside OpenShell-specific constructs. Track
   an explicit reversibility budget — "engineer-weeks to swap substrate" — and
   treat a growing number as a design smell to pay down.

Governance posture: the strongest anti-lock-in is OpenShell *actually* becoming a
multi-implementation standard with a published spec and conformance suite under
neutral governance. That also serves NVIDIA's adoption goal, so we advocate for
it — and our neutral interface + invariant suite are a credible contribution
toward making it real.

## Eliminating agent-specific maintenance (the ironclad rules)

The single biggest cost today is fixing OpenClaw/Hermes-specific issues. That is
not bad luck — it is the direct, predictable output of five structural choices,
each of which we can shut off.

**Why it happens**
- **We fork runtimes**, so their bugs are ours to fix.
- **Burble logic lives inside the runtimes** — jobId parsing, envelope
  construction, tool aliasing, identity, routing, toolset pinning, policy prose.
  Every such line is agent-specific code that can break per-agent.
- **Two runtimes in two languages** (OpenClaw/TS, Hermes/Python) → every feature
  is implemented twice and drifts (the `job-id` logic duplicated three ways; the
  parallel `scheduledJob` plumbing in `burble-tools.ts` + `adapter.py` +
  `entrypoint.py`).
- **Behavior steered by prompt** (`entrypoint.py` prose: "ensure the toolset is
  enabled", "don't declare the bridge unavailable") — unreliable, untestable,
  per-agent, whack-a-mole.
- **No machine gate** — runtimes drift into production; we debug from Slack logs
  instead of a red CI check.

**The rules — each has teeth (a CI / lint / process check, not a good intention)**

1. **Zero Burble policy/decision logic and zero hand-maintained glue in the
   runtime.** The runtime is a dumb executor: it speaks the contract, attaches the
   trusted identity it was *handed*, routes tool calls to the gateway, and emits
   contract events. It makes no decisions — identity, routing, jobId, envelopes,
   tool authorization, sanitization, policy all live in the control plane. The
   adapter is never literally empty; the sanctioned exception is **generated** glue
   (rule #4), not hand-written. *Enforcement:* architecture/import rule — runtime
   packages may import only the contract SDK, never Burble policy modules; PR check
   fails otherwise. *Litmus:* if a fix would edit a runtime by hand, the logic is
   in the wrong layer.

2. **A runtime is a conformance-gated dependency, never a fork.** Adopt
   NemoClaw/OpenClaw/Hermes; never patch their internals. *Enforcement:* a runtime
   is "supported" only while it passes the conformance suite in CI; no
   unconformant runtime reaches prod.

3. **No prompt-steering for correctness.** A prompt instruction is never the fix
   for a correctness bug. If the bridge must be present, the host guarantees it
   structurally; if jobId must be attached, the host attaches it — we never *ask*
   the model. *Enforcement:* review rule; correctness fixes that are prompt-only
   are rejected.

4. **Thin adapters; shared specs; generated glue.** Push logic up so adapters
   carry ~no logic. For the irreducible glue, generate the TS and Python adapters
   from the one contract spec so they cannot diverge; share declarative data (tool
   catalog, envelope schema) consumed by both. *Enforcement:* generated adapters
   are diff-checked in CI; hand-written duplication (like `job-id`) is deleted.

5. **Every production agent bug becomes a conformance fixture.** Fix it once in
   the contract / control plane and lock it with a golden test that runs against
   *every* runtime, so it cannot recur silently in any agent. *Enforcement:* "no
   fix without a conformance fixture" review rule.

6. **Thin, capability-negotiated contract.** Fewer requirements on the runtime =
   fewer ways for any runtime to be wrong. Optional features sit behind capability
   flags with graceful degradation.

7. **Runtime output is untrusted data.** The control plane renders and sanitizes
   everything a runtime emits and never passes through runtime-*asserted*
   structure — transcripts, classifications, identities, "tool ran" claims. (The
   fake-tool-transcript-posted-to-Slack incident was the control plane trusting
   runtime-claimed structure; a fixture locks that one case, this invariant kills
   the class.) *Enforcement:* output boundary is a control-plane responsibility
   with its own conformance fixtures.

**Target operating model:** we never debug a runtime from Slack logs again. A
"runtime problem" resolves to exactly one of — (a) a failing conformance test,
fixed in the contract or the upstream adapter, or (b) a control-plane bug. There
is no category "Burble patches OpenClaw/Hermes internals."

**Make the cost visible:** track the share of commits/time tagged
`agent-specific`; that is the metric this strategy must drive toward zero. If it
is not trending down sprint over sprint, the rules above are being bypassed.

These rules are implemented by sprints S1 (import rule), S4 (thin/generated
adapters, de-fork), S5 (lift policy out), and S7 (conformance gate + metric +
golden fixtures).

## v2 implementation plan (sprints)

v1 = today (forked runtimes, logical-only isolation, policy embedded in prompts).
v2 = OpenShell-centered. Assume ~2-week sprints.

**Three tracks with a real dependency order (not freely parallel):**
- **Track A — Stop the bleeding (start NOW, OpenShell-independent).** Most toil
  reduction needs nothing from OpenShell. Staff this first; it stands alone and is
  also our insurance if the OpenShell bet slips.
- **Track B — Sandbox interface + policy spec (the foundation).** Gates Track C.
- **Track C — De-fork + delete home-grown machinery (strictly last).**

**Hard sequencing rule:** we do not delete current runtime/container/SSRF
machinery until S0b + S1 + S2 have landed and the relevant invariant test is green.

---
**Track A — Stop the bleeding (now, no OpenShell dependency)**

**S0a — Contract hardening from the last week's bugs.**
Lift jobId attachment out of runtime prompts (host attaches it); move
destination/visibility policy fully into the gateway/control plane; make
`burble_provider_call` runtime-independent; enforce the untrusted-output boundary
(rule #7). Add **cross-runtime** conformance fixtures (run against OpenClaw *and*
Hermes) for: scheduled provider call works · provider bridge unavailable ⇒ test
failure · route delivery uses trusted job identity · leaked tool transcript is
rejected · private-source→public-channel block · private-channel delivery ·
public-source→public-channel delivery.
*Exit:* the seven fixtures pass on both runtimes in CI; recent regressions fixed in
the control plane, not in prompts; `agent-specific` fix rate starts dropping.
**This sprint pays for itself even if OpenShell never ships.**

---
**Track B — Sandbox interface + policy spec (foundation; gates Track C)**

**S0b — OpenShell spike + durable-job shape (de-risk the two existential bets).**
Run OpenClaw under `openshell sandbox create` with Burble's gateway as the sole
egress target. Validate: provider callback works, egress blocks everything else
(incl. the SSRF case), brokered web works through Burble's gateway provider,
creds never enter the sandbox, Slack delivery end-to-end, credential seam
(callback vs Providers). **And spike durable scheduled-job shape now** — can an
OpenShell sandbox support the lifecycle scheduling needs (long-run /
suspend-resume / re-attach / durable state), or is that a gap we must own or
upstream? Existential for our product; cannot wait for S6.
*Exit:* go/no-go on isolation+egress; **explicit durable-sandbox verdict** with a
plan (OpenShell-native / Burble-owned / upstream); capability-gap list filed.

**S1 — Burble Sandbox Interface + two adapters.**  *(anti-lock-in core)*
Define the `SandboxProvider` port; implement the OpenShell adapter + one minimal
alternative (local Docker / dev). Core depends only on the port.
*Exit:* both adapters pass a shared conformance test; import rule forbids
OpenShell types outside the adapter package.

**S2 — Policy as neutral spec, compiled to OpenShell.**  *(anti-lock-in core)*
Vendor-neutral schema for egress allowlist + credential/provider bindings +
fs/limits; compiler emits OpenShell config; single source of truth shared with the
gateway.
*Exit:* editing the neutral spec reconfigures OpenShell; web broker policy and
SSRF allowlist expressed once.

---
**Track C — De-fork + delete home-grown machinery (strictly last)**

**S3 — Adopt isolation; retire home-grown.**
Move provisioning to the OpenShell adapter; require bearer auth on contract
endpoints; enforce runtime-only-reaches-gateway egress. **Delete `_is_safe_url` /
per-tool SSRF guards ONLY after an egress invariant test proves all outbound is
forced through policy** — DNS resolution, redirects, IPv6, link-local, private
ranges, and proxy-bypass attempts all blocked at the sandbox. Until that test is
green, the app-level guard stays.
*Exit:* egress invariant test green; pen-review network/credential/ingress gaps
closed; SSRF blocked by policy, not app code.

**S4 — De-fork the runtime; thin, generated adapters.**
Extract `@burble/runtime-sdk` with an OpenShell-sandbox deploy target; replace the
`openclaw-nemoclaw` fork with adopted NemoClaw + thin OpenClaw/Hermes adapters
**generated from the contract spec** (kill hand-written duplication like
`job-id`); remove `burble-direct`. Land the import rule from rule #1.
"Adopt, don't fork" is the destination; the **transition** is explicit: (1) freeze
new runtime logic, (2) move logic upward into the control plane, (3) shrink the
runtime diff, (4) upstream what genuinely must stay in the runtime, (5) replace the
fork only once conformance passes against the adopted runtime.
*Exit:* swapping/adding an agent is a thin adapter with no core change; runtime diff
≈ generated glue only; NemoClaw fork gone; generated adapters diff-checked in CI;
import rule green.

**S5 — Lift policy into the control plane.**
Move visibility/classification/taint, destination, credential, and jobId-identity
policy fully into Burble; strip policy prose from runtime prompts; re-fix the
recent regressions structurally at the control-plane layer.
*Exit:* runtimes carry zero Burble policy; policy is unit-testable in the control
plane.

**S6 — Durable + multi-tenant; upstream contributions.**
Durable-job/state contract on the sandbox port; contribute upstream:
durable/scheduled sandboxes, multi-tenant Gateway, business-agent principal model.
*Exit:* scheduled jobs run on durable sandboxes (ideally upstreamed); fork
divergence minimal.

**S7 — Conformance gate, reversibility, governance.**  *(anti-lock-in + anti-agent-toil core)*
Make the **runtime conformance suite a required CI gate for every runtime**
(no unconformant runtime to prod); seed it with golden fixtures for every past
production agent bug; stand up the vendor-neutral sandbox invariant suite;
instrument the `agent-specific` commit/time metric; reversibility audit
(engineer-weeks-to-swap); advocate OpenShell spec/conformance/neutral governance;
license review of the fork.
*Exit:* conformance gates block prod for both runtimes and both sandbox adapters;
`agent-specific` metric tracked and trending down; reversibility budget bounded.

## Open questions

- What is NVIDIA asking of us — adopt, co-design, contribute conformance,
  co-market? Sets investment level.
- Does OpenShell intend to standardize only the **sandbox boundary**, or also the
  **agent-runtime contract** (overlaps `runtime-sdk`)?
- Is NVIDIA open to a callback / never-in-sandbox provider model alongside their
  env-injected Providers?
- OpenShell maturity for: multi-tenant Gateway, durable/scheduled sandboxes,
  suspend/resume/reattach semantics, throughput. What must we run ahead on?
- Can OpenShell support scheduled jobs as a durable product primitive, or should
  Burble own the durable scheduler/state machine and treat OpenShell sandboxes as
  replaceable execution slots?

## Risks

- Single-vendor dependency (not yet a neutral foundation; no published
  spec/conformance/governance). Mitigation is the dedicated section above —
  *Avoiding OpenShell lock-in* — and is built into sprints S1, S2, and S7.
- Inference coupling — keep sandboxing orthogonal to model choice.
- Durable-scheduling mismatch — if OpenShell is only short-lived sandbox create /
  run / terminate, Burble must own the durable scheduler and re-attach/state
  contract; de-risked in S0b before any deletion work.
- Timing — we may need to run ahead of OpenShell and upstream the deltas.
