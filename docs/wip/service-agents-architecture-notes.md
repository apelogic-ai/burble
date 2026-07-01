# Service Agents Architecture Notes

Status: working thoughts. Not part of the tracked design docs.

## Problem

Burble today models every runtime as a per-user agent: identity, auth, visibility,
and channel binding all resolve against a single `(workspaceId, slackUserId)`.
That works for personal assistants. It does not work for **business-function
agents** — recruiting bot, on-call coordinator, deal-desk bot, customer-mention
radar — that act for a workspace rather than for one person, have triggers other
than DMs, and have a blast radius broader than one user's inbox.

## Conceptual Shift: Principal Type

The core change is lifting the principal from a fixed user shape to a
discriminated union:

- `UserPrincipal` (today): `{ workspaceId, slackUserId }`
- `BusinessAgentPrincipal` (new): `{ workspaceId, agentId }`

The runtime contract does not change. The runtime still receives
`{ principal, input, tools, route }` and does not care which principal kind it
got. What changes is how Burble *resolves* those values:

- Provider auth resolves against agent-owned credentials, not a user's OAuth.
- Route binding comes from agent config, not a DM thread.
- Visibility policy is shaped by the channel the agent posts into, not
  `user_private` by default.
- Audit and cost accounting attribute to the agent identity.

Most existing per-user code becomes a `principal.kind === "user"` branch at
exactly the boundaries that already exist (tool gateway auth resolution, route
binding, visibility policy, scheduled-job capability principal check). This is
the same shape as the runtime contract refactor — Burble owns the
identity/authority plane, the runtime stays unaware.

## Provider Authority Modes

A business agent picks per-tool from three credential modes:

1. **Workspace install.** GitHub App, Slack bot token, Google Workspace
   domain-wide delegation, Jira app. Right model for actions the agent owns
   (creating tickets, posting to channels, reading shared drives).
2. **Delegated user grant.** A specific user "lends" scoped credentials to the
   agent for one purpose (read this user's calendar to schedule them).
   Org-level auth would over-scope.
3. **Per-invocation auth.** Interaction-bound credential that lasts one run
   (the user who `@mentioned` the agent grants implicit read access to their
   own thread).

Most existing per-user provider code already lives behind the bridge, so the
change is "where does the credential come from," not provider restructuring.

## Triggers

User agents are message-shaped: DM in, run out. Business agents need more:

- cron (already supported)
- Slack channel mention
- slash command
- GitHub webhook
- Calendar event
- inbound email
- scheduled-job continuation (agent-issued)

Model each as an `AgentTriggerBinding` row with a discriminated kind that
produces a synthetic `AgentInput` the runtime can already handle. Triggers are
where most of the new code lives; the runtime stays untouched.

## Definition and Lifecycle

Treat each business agent as a declarative spec:

- name, description, runtime engine, capability profile
- allowed tools (gated business + regular external)
- triggers and channel bindings
- approval policy (which actions require human approval, from whom, with what
  timeout)
- optional prompt and skills bundle
- version + changelog

Operations needed:

- workspace admins install/update/disable agents from a catalog
- updates that change tool grants or channel bindings require admin
  re-approval on policy diffs
- dry-run mode and a "test workspace" install pattern for safe rollout
- versioning + rollback because changing a tool grant has multi-user impact

The capability-manifest work already in place is the right shape for this:
agent definitions slot in next to runtime manifests.

## Operations Become First-Class

Three things change when there is more than one principal type:

1. **Approval flow.** Channel-wide posts, ticket creation across projects, or
   anything touching money hits a human-in-the-loop queue with timeout
   fallback.
2. **Audit and observability.** Per-agent timeline visible to admins, not just
   per-user. Cost accounting becomes a workspace budget split by agent.
3. **Authorization.** Who can trigger the agent, who can edit its definition,
   which channels it can write to. This is policy *on the agent*, not on the
   runtime.

## Tradeoff and Recommendation

The cheap path is "model the agent as a service user" — synthesize a
`slackUserId`, connect providers as that user, reuse everything. Ships fast but
bakes in two problems: triggers stay message-shaped, and the user/agent
conflation makes audit and multi-credential auth awkward later.

The right path is to lift the principal type now, but keep the runtime contract
identical. This is a tractable refactor and it composes with the runtime
contract work — Burble owns the principal/authority plane, the runtime does
not.

**Smallest first slice that proves the architecture:**

- one workspace-installed business agent (recruiting funnel or on-call
  coordinator)
- one trigger type beyond DM (Slack mention)
- one credential mode beyond user OAuth (workspace bot/app token)
- one approval flow

Everything else generalizes from there.

## Collaboration Between Service and User Agents

### Most collaboration is just tool calls

When a user agent says "schedule me with candidate Sarah," it's calling the
recruiting agent the same way it would call Google Calendar — structured input,
structured output, streamed progress, audited. From the caller's perspective
there is no new primitive. The recruiting agent happens to be backed by an
agent loop instead of a deterministic provider handler, but the gateway shape
is identical.

First slice of "agents collaborating": **service agents register themselves as
tools in the principal's catalog, with their own scope and classification.** No
new protocol — the existing tool gateway is enough.

### Burble stays the broker

Agents do not dial each other directly. Every cross-agent call flows through
the tool gateway (or an `agent-call` sibling endpoint), which resolves:

- who is the caller
- who is the callee
- what credentials the callee uses (not the caller's — this is the trust
  boundary point)
- what audit events fire
- what visibility policy applies to the result

If service agent S calls service agent T on behalf of user U, T sees
`{ caller: S, originatingUser: U }` but T's provider auth resolves against T's
own grants. **No transitive trust, no token forwarding.** This is exactly the
principal-resolution work above — an agent principal can be a *caller* or a
*callee*, and the same envelope rules apply at both ends.

### Long-running collaboration is a scheduled-job continuation

Existing scheduled-job + capability + delivery-route plumbing is the right
substrate. Agent-initiated jobs reuse it: recruiting agent kicks off "collect
references for candidate X over the next 3 days," registers a job capability
scoped to itself, emits a completion event the originating user agent (or a
Slack DM) listens for. Sync tool-call for fast work, job-issued continuation
for slow work, same auth model for both.

### Is this A2A?

The label fits the *intent*, but the published A2A protocols (Google's A2A and
similar drafts) are aimed at a different problem: cross-vendor, cross-org
agent interop where neither side trusts the other's runtime. Inside one Burble
workspace there is something stronger — a single control plane that already
owns identity, auth, and policy. Adopting A2A as the internal transport gives
up that centralization to gain a feature not yet needed (foreign-agent
interop).

Cleaner sequencing:

- **Internal**: tool-call-through-gateway, broker-mediated, reuses the
  contract.
- **Perimeter**: implement A2A as one *adapter* on top of the agent-call
  primitive, so an external (customer, Anthropic-hosted, OpenAI Agents) agent
  can invoke a Burble-resident service agent through a protocol it speaks.
  Burble still enforces auth and policy on the way in; A2A is just the wire
  format at the edge.

This composes with the runtime contract. The runtime contract defines how a
runtime exposes itself to Burble. An agent-call contract defines how an agent
exposes itself to other agents — same shape (capabilities, run, events, final)
but the principal layer above it is what differs. Runtime spec describes "what
this container can do." Agent spec describes "what this agent is allowed to be
asked to do, by whom."

### Collaboration patterns that fall out for free

Once tool-call-through-gateway exists with an agent principal type:

- **Service-as-tool.** User agent invokes service agent. Common case.
- **Service notifies user.** Service agent finishes work, posts to a DM or
  channel via the delivery route. Already supported by the channel layer.
- **Service composes service.** Recruiting calls IT-provisioning. Same
  tool-call primitive, both ends are service agents.
- **Shared artifact handoff.** Both agents read/write a Drive ledger or Jira
  project. Not really A2A — two principals touching the same world, mediated
  by the provider gateway. Surprisingly powerful and the cheapest pattern;
  should be encouraged before reaching for a richer protocol.

### What to avoid

A central "orchestrator agent" that knows about all service agents and routes.
Collapses into a single brittle planner, recreates the policy plane outside
Burble, and tends to grow into its own framework. Let the calling agent (user
or service) decide what to call, and let Burble's catalog/discovery surface
(`listAvailableAgents` as a tool, gated by principal) be the discovery
mechanism. Intelligence stays in the model; routing stays in the policy
plane.

### Tradeoff in one line

**A2A as protocol is a future interop story; A2A as architecture
(broker-mediated agent calls with explicit principal boundaries) is what to
build now, on top of primitives already in place.**

## Open Questions

- Where does the agent definition live? DB row, Drive doc, repo-tracked YAML?
- What is the minimum approval-flow primitive — a Slack message with buttons,
  or a generic queue with multiple delivery surfaces?
- How does an agent declare which user grants it wants delegated? Per-tool,
  per-trigger, or a single agent-level scope?
- How is cost accounting attributed when service agent S calls service agent
  T on behalf of user U — to S, to T, to U, or split?
- What is the right surface for cross-agent discovery — a workspace catalog,
  an MCP-style listing tool, or both?
- When does the perimeter A2A adapter become worth building, and against
  which external protocol version?
