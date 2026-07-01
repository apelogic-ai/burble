# Burble vs Nexus (Lens Agents Platform) — Comparison

Status: working notes. Burble side from direct work in this repo; Nexus side from
code-level exploration of `~/dev/nexus-monorepo` (file-cited, not run).

## Brief summary

Burble and Nexus are two takes on the **same problem**: a governance control plane
in front of swappable AI agent runtimes. They even target the **same runtimes**
(OpenClaw, Hermes), and they independently converged on the same core principle —
**the agent never holds real credentials; they are applied at a boundary** — plus
shared bets on MCP, swappable runtimes, per-agent usage accounting, and audit.

Where they differ is **kind, depth, and scope**, not presence/absence:

- **Burble** is a *Slack-native, single-service* control plane (TypeScript/Bun,
  SQLite). Runtimes implement Burble's HTTP **runtime contract** (`/runs`,
  `/capabilities`, events), and provider access flows through a **cooperative tool
  gateway**: the runtime gets no OAuth tokens and calls `burble_provider_call` with a
  runtime-scoped JWT. Its isolation is **logical/credential-centric** (per-user
  container on an isolated network + scoped JWT + job/route capabilities + visibility
  enforcement). Identity is **federated through Slack**. It is younger but dense
  (~331 commits in ~17 days) and richer at the *semantic* layer (classification,
  usage, scheduled-job provider bridge, conformance gate).

- **Nexus** is an *enterprise, Kubernetes-native sandbox platform* (Rust + TypeScript,
  PostgreSQL). It wraps **any OCI image** in a hardened **Rust supervisor** (PID 1,
  nftables, seccomp, non-root, optional **Kata microVM**) and brokers everything
  through a **transparent MITM proxy** that swaps placeholder credentials for real
  secrets in-flight. Identity is **direct enterprise IAM** (OIDC/SAML/Okta/Entra,
  org→team→project RBAC, humans *and* agents as principals), policy is **declarative
  YAML layered org→project**, and it ships as a Helm/OCI chart to EKS and Terraform to
  ECS. It is more mature operationally (~940 commits/2mo, v0.9.0, release-please, e2e,
  OTel, multi-cloud).

**They are more complementary than competitive.** Burble is "the channel + provider
control plane"; Nexus is "the sandbox + enterprise-governance substrate." Burble's
`RuntimeFactory` provisions runtimes as bare Docker containers today — that seam is
exactly where it could provision them as **Nexus sandboxes**, inheriting kernel-level
isolation, MITM credential injection, and org→project policy, while keeping Burble's
Slack UX, conversation routing, and curated provider tools.

## Detailed comparison

Edge shown in **bold**. "Comparable / complementary" means neither is strictly ahead
for its intended scope.

| Dimension | Burble | Nexus (Lens Agents) |
|---|---|---|
| **Center of gravity** | **Slack-native assistant control plane** | **Enterprise infra governance platform** |
| **Primary interface** | **Slack** — App Home, slash commands, modals, conversation routes | **CLI + Web UI + MCP + REST** (broad operator surface) |
| **Language / shape** | **One TypeScript/Bun service** (simple) | Rust + TypeScript, 7 crates + 4 packages |
| **Datastore** | SQLite (`bun:sqlite`) — light | **PostgreSQL (Kysely, 61 migrations) + pg-boss jobs** |
| **Agent integration** | Runtime implements Burble's **HTTP `/runs` contract** (rich: classification, usage, tool-call events, conformance gate) | **Rust supervisor injected into any OCI image — agent implements nothing** |
| **Runs unmodified third-party agents** | Needs a contract wrapper (OpenClaw/Hermes adapters) | **Yes — wraps any image, can assume a hostile agent** |
| **Semantic run events** | **Classification + visibility + usage + scheduled-job provider bridge as first-class contract events** | Network/OS-level; less semantic about the run |
| **Isolation model** | Real but **logical**: per-(workspace,user,engine) container on isolated network, no raw provider tokens, runtime-scoped JWT, job/route capabilities, visibility enforcement, penetration-review doc | **Defense-in-depth kernel-level: nftables egress lockdown, seccomp, non-root, privilege drop, optional Kata microVM; "assume the agent is compromised"** |
| **Credential boundary** | **No secrets in agent** via **cooperative bridge** — runtime calls tool/MCP gateway with scoped JWT; adds classification/visibility | **No secrets in agent** via **transparent MITM proxy** — placeholder→real swap (header / URI / AWS SigV4 re-sign); stronger against a hostile agent |
| **Identity / SSO** | **SSO via Slack** (Slack OAuth as IdP; enterprise-SSO-backed) + provider OAuth + runtime JWTs | **Direct enterprise IdP: OIDC, SAML, Okta, Microsoft Entra** |
| **Principals** | Slack users; runtimes carry scoped JWTs | **Humans *and* agents as first-class principals (api-token, sandbox, cluster-JWT)** |
| **Authz / RBAC** | workspace → user; workspace policy + per-user prefs + tool groups | **org → team → project RBAC, roles, policy bindings to subjects** |
| **Policy engine** | Workspace policy + per-user prefs + compatibility/conformance gate (right-sized) | **Declarative YAML, layered org→project with ceiling merge (org floor, project restricts)** |
| **Provider / tool model** | **Curated first-party catalog (GitHub/Google/Jira/Slack) with canonical tool names + classification — batteries included** | **BYO: any upstream MCP server aggregated, per-actor tool allowlists + K8s/AWS/GitHub — open gateway** |
| **Connectivity** | Slack reach + runtimes on a docker network (sufficient for its model) | **Reverse tunnels (bored-mplex over outbound WebSocket via kube-relay), no inbound ports, sandbox ingress** |
| **Scheduled / background work** | **Explicit cron → Slack-route delivery, provider-bridged jobs with job-scoped auth + visibility** | **Long-running governed agents: idle-timeout, persistent PVC, spending-limit pause, pg-boss workers** |
| **Inference routing** | Per-user model selection; usage accounting | **LLM proxy with per-agent spending limits (pause on cap); Anthropic/OpenAI/Bedrock** |
| **Observability** | First-class: `ObservabilitySink`, ~47 emit sites, runtime run/tool/usage events, `observability-accounting.md` | **OTel traces/logs + queryable `audit_trail` DB with analytics (stats, breakdown, timeseries)** |
| **Audit** | Runtime event records per run/tool (accounting-oriented) | **Complete, queryable audit trail by default — MCP calls, proxy traffic, API requests; SOC2/ISO/PCI evidence** |
| **Deployment** | docker-compose (dev-centric) | **Helm/OCI → EKS, Terraform → ECS/Fargate, multi-arch, release-please** |
| **Maturity — velocity** | **~331 commits in ~17 days (~19/day)** — younger, denser cadence | ~940 commits in ~2 months (~15/day) |
| **Maturity — process / production** | Single author, pre-open-source prototype, conformance harness | **v0.9.0, multi-author, release automation, e2e suite, OTel, multi-cloud, Mirantis-backed** |

## Shared principles (independently converged)

- Credentials never enter the agent (cooperative bridge vs transparent MITM).
- MCP as a first-class protocol.
- Swappable runtimes behind a governance layer — the **same** runtimes (OpenClaw, Hermes).
- Per-agent usage/spend accounting and an audit/observability trail.
- Capability/policy-driven tool exposure.

## Net read

Neither dominates the other; their edges line up with their intent.

- **Burble wins** on simplicity, conversational/channel UX, the semantic richness of
  its runtime contract, curated out-of-box providers, scheduled-channel delivery, and
  raw iteration velocity.
- **Nexus wins** on isolation depth (kernel/microVM), enterprise IAM + RBAC + layered
  policy, audit queryability, BYO extensibility, network traversal, and production
  deployment maturity.
- **Complementary**: Burble could provision its runtimes *as Nexus sandboxes* — gaining
  Nexus's hardening, credential MITM, and org→project policy while keeping Burble's
  Slack channel, conversation routing, and provider catalog. The cleanest integration
  seam is Burble's `RuntimeFactory`.

Caveat: Nexus details are from static exploration this session; Burble's from direct
work in-repo.

## Deeper dives

These four expand the rows above with code-level detail (Nexus from
`~/dev/nexus-monorepo` exploration; Burble from in-repo work).

### A. How configuration reaches a wrapped agent (the BYO-agent question)

Nexus configures **the environment the agent runs in**, not the agent — in three
layers, and only the third needs to know anything about the specific agent. The Rust
supervisor (`nexus-agent-sandbox`, `dispatcher.rs` `build_agent_env`) merges env in a
fixed precedence then runs `sh -c "$AGENT_COMMAND"` as PID 1:

```
image env → policy env → proxy env (HTTPS_PROXY…) → credential placeholders → CA bundle
            (then scrub LENS_SANDBOX_* internals)
```

| Layer | Works for ANY agent unmodified? | Mechanism |
|---|---|---|
| **Isolation** (nftables egress, fs/process, non-root) | **Yes — zero cooperation** | kernel + supervisor; any process is caged |
| **Credential boundary** (placeholder→real at MITM proxy) | **Yes — agent sees only `__lens_cred:…__`** | proxy header/URI/AWS-SigV4 injection |
| **Configuration / wiring** (point the agent at governed endpoints) | **No — needs per-agent knowledge** | policy `env` map, integration-written files (`~/.aws/credentials`, `~/.kube/config`), and `agents.<template>.bootstrap` shell commands |

So: **governance (isolation + credential injection) is universal and needs no agent
cooperation; wiring an agent to actually *use* the governed endpoints requires knowing
that agent's config surface** (which env var / file / bootstrap step), expressed in the
policy — not in the agent. Example: Claude Code is steered purely by env
(`ANTHROPIC_BEDROCK_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`); file-based tools (AWS/kubectl)
get files written; anything exotic gets a bootstrap script.

Maturity caveat (from reading): the policy `files` list and `NEXUS_BOOTSTRAP_CMDS`
appear **declared but not yet wired into the supervisor** — today the reliable lever is
the `env` map + integration files.

**Contrast:** Burble takes the opposite stance — its runtime is a **cooperating**
process that implements the Burble contract and calls `burble_provider_call` with a
scoped JWT, so Burble never needs to know "which env var does this agent read." Nexus
wraps the uncooperative; Burble adapts the cooperative.

### B. Interfaces: terminals + the Slack/front-end story

**Nexus has three terminal front-ends, all shells into a sandbox**, over one shared
exec/PTY abstraction:
- Web UI terminal (xterm.js, `nexus-ui/.../shell/web-terminal.tsx`), `shell`/`watch` modes.
- CLI `nexusctl sandbox exec`/`shell` with `--tty` (`crates/nexusctl/.../sandbox_exec.rs`).
- Shell-sessions UI (attach/watch running sandboxes).

The **abstraction is an exec/PTY transport, not a front-end abstraction**: a
Kubernetes-style binary channel framing (`k8s-channel-framing.ts`,
`0x00 stdin / 0x01 stdout / 0x02 stderr / 0x03 err / 0x04 resize`) over the WebSocket
subprotocol `v1.channel.agents.lenshq.io`, with a JSON `ExecAttach/Resize/Exit`
control protocol (`agent-sandbox-protocol.ts`). CLI and Web share it.

**Slack in Nexus is a callable tool, not a way to reach an agent.** Implemented: Slack
as an upstream **MCP connector** (`slack-mcp` server, `send_message`/`list_channels`).
Aspirational only (docs, no code): "team-facing with Slack interface" and "approval via
Slack/Teams." There is **no pluggable channel/front-end abstraction** — interfaces are a
fixed set (REST, MCP, Web UI, CLI); "channel" in the code means exec framing or Postgres
`NOTIFY`, never a conversation channel.

**This is the sharpest product-shape difference:** Burble's *primary interface is a
conversation channel* (Slack), with a real channel-connector abstraction (and OpenClaw
channel plugins underneath); Nexus's interfaces are a *shell terminal + ops Web UI +
MCP*, with Slack only as something an agent can call. Burble is a conversational agent
surface; Nexus is an operations/governance surface plus raw shell.

### C. Management plane (control plane vs data plane)

Nexus is explicitly split:
- **Management/control plane = the Platform Server** (`packages/nexus`, :3002): org→team→
  project hierarchy, identity + RBAC, layered policies, connectors, credentials/secret
  backends, inference routing + spend limits, audit trail, and sandbox lifecycle
  orchestration. Exposed through **four management surfaces** (REST `/v1`, MCP gateway,
  Web UI, `nexusctl` CLI) plus `pg-boss` workers and pod-watchers. A genuine fleet
  control plane: "which agents are running, where, under whose identity, accessing what."
- **Data plane = the runtime path**: the sandboxes (Rust supervisor), the MITM forward
  proxy that carries + credential-injects agent traffic, and the tunnels/relays
  (`nexus-kube-relay` + `bored-mplex`). The CLI can run standalone (local sandbox +
  policy + audit) and attach to the management plane only when an org is in use.

**Burble also has a management plane, but lighter and Slack-embedded:** App Home +
slash commands + modals (runtime selection/config), workspace policy + per-user
preferences, the tool/MCP gateways, scheduled-job registration, observability/accounting.
Two levels (workspace→user) vs org→team→project; SQLite vs PostgreSQL; a Slack admin
surface vs a dedicated Web UI + CLI + REST + MCP. Same role (identity, policy, tool
brokerage, lifecycle, audit); very different weight. Burble's management plane is a
*feature of a Slack app*; Nexus's management plane *is the product*.

### D. Mental model

- **Nexus** = a **bring-your-own-agent, governed sandbox/gateway**. You don't build the
  agent or configure its internals; you declare policy, identity, and wiring, and Nexus
  enforces a hard boundary around an opaque, possibly-hostile workload. Two shapes:
  **Mode 2 (fully sandboxed)** — the "agent factory" that spawns hardened instances from
  an image; **Mode 1 (MCP-connected)** — a governed *gateway* where the agent runs
  wherever it already lives and only connects for governed access.
- **Burble** = a **Slack assistant whose runtime is one of ours, speaking our contract**.
  The agent is a cooperating, Burble-shaped runtime; the product is the conversation and
  the curated provider tools.

Different center of gravity: Nexus governs *untrusted, BYO* agents for the enterprise;
Burble *is* a (trusted, contract-following) agent you talk to in Slack.
