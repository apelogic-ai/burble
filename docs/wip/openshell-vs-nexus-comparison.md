# OpenShell vs Nexus/Lens — Sandbox Substrate Comparison

Status: draft for discussion. Date: 2026-06-17.
Question: are NVIDIA **OpenShell** and Mirantis **Nexus/Lens** interchangeable
candidate substrates for Burble? Source: OpenShell README; nexus-monorepo v0.11.0.

## The framing that decides it: different categories

They are **not the same layer**, so "which one do we adopt as the substrate" is
partly a false choice:

- **OpenShell = an isolation substrate** (a sandbox runtime). Narrow, OSS,
  standard-aspirant. Sits *below* a control plane and assumes someone else owns
  policy/identity/product. This is the layer Burble wants to *not* own.
- **Nexus/Lens = a full governed platform** — sandbox **+** control plane: RBAC,
  multi-tenancy, audit, credential broker, inference routing, policy inheritance,
  admin UI. Its control plane is **largely what Burble is building.**

So OpenShell is a *complement* (adopt underneath us); Nexus is mostly a
*competitor/benchmark* to Burble's whole stack, plus a source of design patterns.
Adopting Nexus "as a substrate" would mean adopting its control plane too — i.e.
subsuming Burble's moat under a proprietary competitor.

## Side-by-side

| Dimension | NVIDIA OpenShell | Mirantis Nexus / Lens |
|---|---|---|
| **Category** | Agent **sandbox/isolation runtime** | **Full governed agent platform** (sandbox + control plane) |
| **Tagline** | "The safe, private runtime for autonomous AI agents." | "Any agent. Any model. Any environment. Your rules." |
| **Scope vs Burble** | *Below* Burble — clean complement | *Overlaps* Burble's control plane — competitor/benchmark |
| **License / OSS** | **Open source** (GitHub), forkable | **Proprietary** (© Mirantis, all rights reserved); public repo but not OSS |
| **Standard posture** | Aspires to be the open standard; no spec/conformance/governance *yet* | No standard claim; MCP-compliant; single-vendor |
| **Isolation** | Container (Docker/Podman) + **microVM option** + GPU passthrough; syscall filtering; fs allow-paths | Container + **nftables + seccomp + Landlock** (kernel where available); Kata microVM "TBD"; no gVisor |
| **Network egress** | L7 HTTP method/path filtering, hot-reload YAML | **L7+L4** proxy, domain+method/path, default-deny, transport upstream/direct |
| **Credential model** | **Providers**: named bundles **env-injected** into sandbox (never on disk) | **Boundary-proxy MITM**: dummy creds in sandbox, real swapped at proxy edge (incl. AWS SigV4 re-sign); pluggable backends (Vault/AWS planned) |
| **Identity / tenancy / RBAC** | Minimal (substrate concern) | Rich: multi-tenant, human+agent principals, org→team→project inheritance, audit, SOC2/ISO-ready |
| **Durable / scheduling** | Not documented; `sandbox create … terminate` lifecycle | **No suspend/resume/snapshot**; start/stop/delete + config revisions + persistent volumes; **no scheduler primitive** |
| **Inference coupling** | Privacy Router + GPU passthrough → NVIDIA-leaning | None — routing/metering layer only (Anthropic/OpenAI/Azure) |
| **Languages** | Python 3.14 + Node 22 in-sandbox | Platform TS/Hono + Postgres; runtime **Rust** (`nexus-agent-sandbox`, depends on external `lens-sandbox-core`); React UI |
| **Agent integration** | `openshell sandbox create -- <agent>` (Claude Code, Codex, Copilot CLI…) | Two modes: MCP-connected (any agent, any location) or fully sandboxed (managed) |
| **Maturity** | Newer / early | Late beta / early production: Helm + Terraform, e2e tests, v0.11, deep docs |
| **Strategic fit** | NVIDIA partner play (the whole reframing) | Mirantis enterprise product; competes with Burble's positioning |

## What it means for Burble

**Recommendation: adopt OpenShell as the substrate; treat Nexus as a
benchmark + a pattern library, not a substrate.** Reasons:

1. **Layer fit.** OpenShell is substrate-only — we slot it under our control plane
   without cannibalizing the moat. Adopting Nexus means inheriting its control
   plane (RBAC/audit/policy/credential broker/inference routing), which *is* what
   Burble differentiates on. For a company whose moat is the control plane,
   building on a competitor's control plane is self-defeating.
2. **OSS + forkable + standard-aspirant.** OpenShell we can fork, track, and shape
   (and the anti-lock-in plan already assumes this). Nexus is proprietary — no
   fork, hard vendor lock-in, and a commercial dependency on a competitor.
3. **NVIDIA alignment.** The entire reframing is the NVIDIA partnership; OpenShell
   is that bet. Nexus is Mirantis.
4. **Minimalism is a feature here.** OpenShell *not* having rich RBAC/audit/tenancy
   is exactly right — we want the substrate to stay out of policy. Nexus's richness
   there is overlap, not value, for us.

**Where Nexus is genuinely ahead — borrow, don't adopt:**

- **Credential-MITM proxy** is the standout. Dummy creds in the sandbox, real
  swapped at the egress proxy (header/URI/SigV4) — the agent uses normal tools
  (`aws`, `kubectl`, `git`) with fake creds and **the real secret never enters the
  sandbox**. This is *closer to Burble's "tokens never in the sandbox" principle
  than OpenShell's env-injection.* Strong argument to implement a credential-broker
  proxy in Burble's gateway (or push OpenShell toward MITM Providers) rather than
  use OpenShell's env-injected Providers. Validates our preferred credential stance.
- **Policy inheritance (org → team → project, restriction-only).** A clean model
  for Burble's own multi-tenant policy layer.
- **Agent + human as distinct first-class principals with their own tokens/audit.**
  Aligns with our `BusinessAgentPrincipal` direction; good reference design.
- **Maturity signals to match:** Helm/Terraform deploy, e2e suite, config
  revisions + rollback.

**Shared validation of our thesis:** both substrates use **L7 egress filtering +
a credential boundary** as core primitives — confirming that the web-extract SSRF
and credential-boundary gaps are *missing-substrate-primitive* problems, not
app-bug problems, regardless of which substrate we pick.

**Shared gap = our problem either way:** **neither** has real durable/scheduled
sandbox lifecycle (suspend/resume/snapshot/scheduler). Burble's product depends on
it. This reinforces pulling the durable-job spike forward (S0b) — it's something we
must own or upstream no matter what.

## One-line verdict

OpenShell is the substrate; Nexus is the mirror. Adopt OpenShell underneath, steal
Nexus's credential-proxy and policy-inheritance ideas for our control plane, and
don't let either own the policy/identity layer that is Burble's reason to exist.
