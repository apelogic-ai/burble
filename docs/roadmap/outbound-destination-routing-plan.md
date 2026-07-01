# Plan: Flexible outbound destination routing

Status: working plan. Companion to [[providers-tools-generalization-plan]],
[[real-boundary-test-layer-plan]], and [[runtime-pluggability-next-targets]].
Opens the **channel/destination edge** that those docs deferred — driven by a
concrete need: let autonomous jobs post to a *designated* channel instead of the
DM they were scheduled from.

## Frame

Burble is a control-plane core (identity, auth, policy, memory, scheduling,
visibility, **routing**) with pluggable edges. Routing of *outbound* messages is
the next seam to make explicit. The insight that shapes this whole plan:

**The destination is already a first-class object. We are not building routing —
we are un-pinning it from the inbound event and authorizing it.**

`ConversationRoute` (`src/db.ts:86`) is already a persisted, scoped, revocable
destination:

```ts
{ id: "convrt_<sha256(...)[:24]>", workspaceId, slackUserId,
  transport: "slack", destinationJson: { channelId, isDirectMessage, rootId, threadTs? },
  revokedAt }
```

It is resolved and auth-checked at send time (`resolveConversationRouteDestination`,
`src/tool-gateway.ts:~3418`: workspace + user + optional runtime match, not
revoked, transport slack). A runtime emits output via `conversation.send` whose
input is **`{ text, routeId?, attachments? }`** — crucially, **no `channelId`
field** (`isConversationSendInput`, `src/tool-gateway.ts:~3270`). So the model is
already "post to a *named, pre-authorized destination*," not "post to a channel
the runtime names."

## What actually pins routing to origin today

The model is general; three *creation/wiring* choices pin it to the inbound event:

| # | Pin | Where |
|---|---|---|
| 1 | Routes are minted **only at inbound**, always with the inbound channel | `createSlackConversationRoute` (`src/slack.ts:1888`) called only from the two inbound handlers (`:738`, `:924`) |
| 2 | A runtime **can't name a new place** — only reuse an existing `routeId` | `conversation.send` input forbids `channelId` (`src/tool-gateway.ts:~3270`) |
| 3 | A scheduled job **registers against a route it already owns** | `scheduledJob.registerCapability` takes `input.routeId`, validates it via `resolveConversationRouteDestination` (must belong to the runtime principal), stores `routeId ?? null` (`src/tool-gateway.ts:420-441`) |

So **"cron posts to DM by default" is route inheritance, not a hardcoded default**:
the job is scheduled from a DM, the runtime registers the capability against that
DM's route, and the fired job resolves it back to the DM. An *arbitrary* channel
is blocked for one concrete reason — **no route exists to register against unless
the agent was already addressed in that channel.**

## The crux: destination is safe by *accident*, not by *enforcement*

There is **no per-channel ACL** today (verified): the only check on a send is
workspace-principal match. Posting is safe purely because the only reachable
destinations are origins a human chose. The moment an autonomous job can target an
arbitrary channel, that structural safety is gone and there is **nothing** behind
it — a buggy or prompt-injected agent could post to any channel in the workspace
(exfiltration, spam, impersonation), including channels the bot isn't in.

Therefore the tempting patch — *add a `channelId` to `conversation.send`* — is the
**wrong** move. It hands an untrusted execution worker the authority to choose
destinations, violating the trust model (Burble owns identity/auth/policy/routing;
the runtime is a replaceable worker). The systematic move is the same one the
attachment PR (#47) just shipped: **a destination an autonomous job may post to is
a granted, scoped, signed capability — not a free parameter.**

## The invariant to preserve

> A runtime can only post to a destination the control plane already authorized.
> It can never invent one.

All flexibility is added on the **grant-minting** side (control plane), never on
the **send** side (runtime). `conversation.send` keeps taking a `routeId` /
`destinationGrantId` and never a raw `channelId`. This keeps the trust boundary
identical to runtimes and providers/tools.

## Increments (behavior-neutral → capability-gated → conformance)

### D1. Authorized destination grants (the core security unlock)

Generalize `ConversationRoute` (or add a sibling record) so a route can represent a
**channel destination authorized by an explicit human act**, not only a recipient's
DM origin. Concretely:

- Today a route's deterministic id hashes in `slackUserId` (the *recipient*). A
  channel grant is instead owned by a **grantor** principal: `{ workspaceId,
  channelId, grantorUserId, optional expiry, optional runtime/job binding }`. The
  grantor's `slackUserId` becomes the owning principal, so the existing ownership
  check in `resolveConversationRouteDestination` keeps working unchanged.
- The grant is **minted by an authorized action** — a user *in the target channel*
  saying "post the daily report here," or a setup/connect UI — never by the runtime
  on its own. This is the attachment-capability shape (`src/conversation/attachment-capabilities.ts`):
  signed, scoped to a principal + target, expiring, revocable, checked at use.
- The send path validates the **grant**, not just workspace match. This is the
  missing per-channel ACL.

### D2. Let autonomous jobs target a grant instead of inheriting origin

The `routeId` slot already exists on the job capability (`scheduled-job-context.ts:21`).
The change is the **job-creation flow**, not the contract:

- When scheduling a job, let the user **designate/confirm a destination grant**
  (a channel they authorized in D1) rather than silently inheriting the scheduling
  DM's route.
- `scheduledJob.registerCapability` already validates the supplied `routeId` against
  the runtime principal — that enforcement seam is correct and unchanged; D1 just
  widens *which routes can exist* and *who authorized them*.
- **DM-as-fallback stays:** when no destination is designated, inherit the
  originating route exactly as today. Nothing regresses.

**Asymmetry to lean into:** interactive replies **stay reply-to-origin** (correct
and safe — there *is* an inbound event to answer). Only **non-interactive output**
(cron / autonomous) needs a designated destination, precisely because there is no
inbound event to reply to. That scopes the work tightly: *named, authorized
destinations for autonomous output* — not *any turn can post anywhere*.

### D3. Destination preflight (channel analog of provider-preflight)

Before posting to a designated channel, verify the bot is a member and may post;
surface "invite me to #X" / "reconnect" instead of a silent drop or a mid-job 403.
This is guard #4 of [[real-boundary-test-layer-plan]] applied to channels — the
"implicit membership/deploy dependency" class. Run it at grant-mint time (fail
fast, with a clear fix) and defensively at send time.

### D4. Generalize the transport seam ("any other frontend")

`ConversationTransport` / `source` is already the seam (`src/db.ts:84`,
single-valued `"slack"`). A second frontend (email, Teams, web, webhook) plugs in
as: a new transport value + a `Destination` adapter
(`resolveDestination` / `postMessage` / `fetchAttachment` / inbound ingestion).
The route model and the `conversation.send` contract are **already nearly
transport-agnostic** — only the Slack POST (`src/tool-gateway.ts:~3591`) and the
`rootId` regex parsing are Slack-specific. This is the **channel edge** — the third
pluggable edge after runtimes and providers/tools — and it falls out of D1–D3
almost for free. Defer the actual second transport until one is real (same YAGNI
bar as the runtime/provider SDKs); D1–D3 are worth doing now, Slack-only.

## Running order

1. **D1 — destination grants.** Reuse the attachment-capability machinery; this is
   the security foundation everything else needs.
2. **D2 — autonomous-job targeting.** Job-creation flow + UI to pick a grant;
   DM-fallback preserved.
3. **D3 — destination preflight.** Membership/permission check with honest
   "invite me" surfacing.
4. **D4 — transport seam** — only when a second frontend is real.

## Conformance + real-boundary (reuse the recipe)

- **Conformance:** a runtime/transport that claims it can post to a designated
  destination must actually emit a `conversation.send` to a granted route during the
  probe — the capability-honesty pattern (#35, extended to attachments in #47) applied
  to destinations.
- **Real-boundary test:** post to a *real* channel and assert it lands (and that an
  *ungranted* channel is rejected, and a *revoked/expired* grant is rejected) —
  through the real tool-gateway boundary, exactly as #47 tests attachment denials.
  Mirrors [[real-boundary-test-layer-plan]] guards #2 and #4.

## Non-goals

- **No raw `channelId` on `conversation.send`.** Flexibility lives only in
  grant-minting. (This is the line between the systematic fix and the insecure patch.)
- **Not changing interactive reply-to-origin.** It is correct; leave it.
- **Not building a second frontend now.** D4 is the seam, not an implementation.
- **Not a cross-workspace router.** Grants stay workspace-scoped; cross-workspace is
  a separate trust problem.

## One-line summary

You already have the destination primitive (`ConversationRoute`); the unlock isn't
routing, it's (a) un-pinning route *creation* from the inbound event and (b) — the
real work — turning "safe because origin-only" into "safe because the destination
was **granted** and **preflighted**," reusing the attachment-capability model, while
keeping runtimes structurally unable to name a destination they weren't authorized
for. That opens the channel/destination edge with the same recipe — single-source
the model, derive per-transport adapters, conformance, real-boundary test — used for
the runtime and provider/tool edges.
