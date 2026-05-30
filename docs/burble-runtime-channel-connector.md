# Burble Runtime Channel Connector

## Goal

Burble should expose a transport-neutral conversation channel to agent runtimes.
OpenClaw, Hermes, or another runtime should not know Slack channel IDs, Slack
tokens, or user transport credentials. A runtime receives a scoped Burble route
and delivers output back through that route.

## Connector Contract

Each runtime integration should use this logical contract:

```ts
type BurbleConversationEnvelope = {
  tenantId?: string;
  runtimeId: string;
  routeId: string;
  conversationId?: string;
  threadId?: string;
  actorId?: string;
  taskId?: string;
  visibility: "public" | "user_private" | "restricted";
  text: string;
  attachments?: Array<{
    id: string;
    kind: "file" | "image" | "audio" | "video";
    mimeType: string;
    source: "slack" | "burble" | "agent";
    name?: string;
    sizeBytes?: number;
    externalId?: string;
  }>;
  metadata?: Record<string, unknown>;
};
```

Required operations:

- `receiveUserMessage(envelope)`: Burble sends a user message into a runtime
  session.
- `deliverAgentMessage(envelope)`: a runtime posts a response to one Burble
  route.
- `updateTaskStatus(envelope)`: a runtime reports async task status for one
  route.
- `resolveRoute(routeId)`: Burble validates a route and resolves the final
  transport destination internally.

## OpenClaw Adapter

The OpenClaw-specific adapter should map OpenClaw channel/session concepts onto
the generic Burble connector:

- OpenClaw channel name: `burble`.
- OpenClaw route identity: `routeId`.
- OpenClaw session key should include the Burble runtime, route, agent, and
  thread identifiers.
- Cron/background jobs should store `delivery.channel = "burble"` and
  `delivery.to = "<route>"`, not Slack IDs or webhook URLs.

Current implementation status:

- Native outbound delivery is wired as an OpenClaw `burble` channel plugin.
- Normal Burble DM/mention traffic carries a durable `routeId` into
  OpenClaw-native execution, so scheduled/background work can target the same
  conversation route without `/agent exec`.
- Route-backed native turns are sent to the OpenClaw gateway with
  `x-openclaw-message-channel = "burble"` and a stable route-derived session
  key, so repeated Slack turns in the same Burble route map to the same
  OpenClaw channel session instead of one-off run sessions.
- Durable route delivery is principal-bound and, when known, runtime-bound.
- User and runtime messages can carry sanitized attachment metadata. Slack file
  URLs are not exposed to runtimes; agents can fetch current-turn attachment
  bytes through the route/runtime-scoped `conversation.getAttachment` tool.
- Burble still owns outer admission, deterministic short-circuiting, runtime
  provisioning, and policy before forwarding an admitted turn to OpenClaw.

## Hermes Adapter

Hermes should be integrated as a first-class Burble channel, not as a one-shot
CLI wrapper. The target implementation is a Hermes gateway platform
plugin/adapter named `burble`.

The Hermes adapter should map Hermes platform/session concepts onto the generic
Burble connector:

- Hermes platform name: `burble`.
- Hermes chat/conversation identity: stable Burble route-derived session key.
- Hermes outbound delivery: `send_message`/cron delivery resolves only to a
  Burble `routeId`; Burble resolves the final Slack/transport destination.
- Hermes inbound delivery: Burble injects Slack/user turns into Hermes through
  the adapter so Hermes sees a normal platform conversation, including
  interrupt/continuation semantics where Hermes supports them.
- Hermes provider tools: use Burble MCP with route-scoped credentials and
  manifest-filtered tool visibility.
- Hermes local tools/toolsets: default-deny or explicitly manifest-scoped so a
  Hermes runtime cannot bypass Burble provider policy through local config.

The runtime image may still expose Burble's `/healthz` and `/runs` HTTP
contract so the Burble control plane can provision, monitor, and test it like
other runtime images. That HTTP layer should drive the Hermes channel/gateway
adapter, not shell out to `hermes chat -q` as the normal production path.

Follow-up for deeper OpenClaw SDK turn-kernel ingress:

- Add a Burble channel inbound endpoint owned by the OpenClaw plugin.
- Use OpenClaw's channel turn kernel so OpenClaw records the inbound session,
  resolves the route, dispatches the turn, and delivers the reply through the
  same `burble` channel adapter.
- Keep Burble as the policy/orchestration layer: it provisions isolated
  runtimes, mints route capabilities, and enforces transport access outside the
  model-visible runtime.

## Security Backlog

These hardening items should be handled as a separate PR:

- Add route-scoped delivery capabilities instead of trusting route IDs alone.
- Extend route-scoped attachment fetch beyond current-turn attachments, with
  expiry, MIME allowlists, stricter size policies, and dedicated audit events.
- Bind every capability to `runtimeId`, principal, route, audience, expiry, and
  allowed operation.
- Reject outbound delivery when the capability route does not match the stored
  cron/background job route.
- Ensure runtime session keys include `tenantId`, `runtimeId`, `routeId`,
  `agentId`, and `threadId`.
- Add structured audit events for route creation, delivery, rejection, and
  revocation.
- Redact transport identifiers from model-visible prompts where route IDs are
  sufficient.
- Add tests for cross-principal route use, revoked route delivery, stale cron
  route delivery, and active-conversation fallback denial.
