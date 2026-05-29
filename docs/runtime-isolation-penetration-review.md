# Runtime Isolation Penetration Review

This note is a mental penetration, exfiltration, and leakage review of the
current Burble control plane and OpenClaw/NemoClaw runtime architecture.

It focuses on cross-user, cross-tool, and cross-agent/runtime boundaries.

## Scope

Reviewed surfaces:

- Burble provider MCP endpoint: `/mcp`.
- Burble legacy internal tool gateway: `/internal/tools/:tool/execute`.
- OpenClaw/NemoClaw runtime HTTP API: `/runs`, `/runs/:id`,
  `/runs/:id/events`.
- Runtime-local Burble proxy endpoints:
  - `/internal/burble/mcp`
  - `/internal/burble/channel/routes/:routeId/messages`
  - `/internal/burble/channel/routes/:routeId/events`
- Conversation route handling.
- Attachment fetch handling.
- Runtime JWT and runtime-token handling.
- Static/shared runtime deployment and Docker-backed personal runtime
  deployment.

## Threat Model

Assume one of these has happened:

- A user's agent runtime is prompt-injected.
- A user's agent runtime is compromised.
- A tool/plugin running inside one runtime is malicious.
- A user can cause their runtime to make arbitrary HTTP calls.
- A runtime can reach other containers on the deployment network.
- A model can produce tool calls with attacker-chosen arguments.

Security goals:

- Runtime A must not read or use Runtime B's provider tools.
- Runtime A must not post to Runtime B's Slack route.
- Runtime A must not fetch Runtime B's Slack attachments.
- Runtime A must not read Runtime B's run output or stream.
- User A must not cause Burble to use User B's provider OAuth tokens.
- Private tool output must not be posted publicly because the agent marked it
  public.

## Summary

Burble has strong application-level principal checks around provider MCP calls.
Runtime JWTs are mapped back to `agent_runtimes`, provider tools resolve tokens
for the runtime's Slack user, and conversation route IDs are checked against the
runtime's workspace/user.

The weaker boundary is runtime ingress. The runtime service exposes several
HTTP endpoints that appear to trust network locality rather than authenticating
the caller. In Docker-backed personal runtime mode, if runtime containers can
reach each other on the same Docker network, a compromised runtime may be able
to drive another runtime's Burble MCP proxy or run API.

The second weak boundary is legacy/static mode. The legacy internal tool
gateway still supports broad token-based `legacy` auth where provider lookup is
driven by request-body email. That is acceptable only for tightly controlled
development paths, not for multi-user isolation.

## Highest-Risk Findings

### 1. Runtime `/runs` Surfaces Are Not Authenticated

Burble sends runtime runs with only `x-burble-runtime-id`:

```ts
function runtimeHeaders(runtime: RuntimeHandle | null): Record<string, string> {
  if (!runtime) {
    return {};
  }

  return {
    "x-burble-runtime-id": runtime.id
  };
}
```

The runtime accepts:

- `POST /runs`
- `GET /runs/:id`
- `GET /runs/:id/events`

without checking a bearer token in the runtime server path.

Attack path:

1. Runtime A is compromised.
2. Runtime A reaches Runtime B at `http://burble-rt-<id>:8080`.
3. Runtime A posts a run to Runtime B.
4. Runtime B executes with its own config, runtime ID, runtime JWT, local
   OpenClaw state, and provider-tool access path.

Impact:

- Cross-runtime task execution.
- Potential cross-user provider access if the attacker can also supply or
  learn a valid route/capability.
- Cross-runtime state contamination.
- Possible output exfiltration through `GET /runs/:id` or event stream.

Recommended fix:

- Require `Authorization: Bearer <runtime.authToken>` on all runtime HTTP and
  WebSocket surfaces.
- Validate the token against the runtime's configured token or a hash provided
  at startup.
- Require `body.runtime.id === config.runtimeId` when `runtime.id` is present.
- Reject all `/runs/:id` and `/runs/:id/events` requests without the same
  runtime auth.

### 2. Runtime-Local Burble Proxy Endpoints Are Local By Convention Only

The runtime exposes:

```text
POST /internal/burble/mcp
POST /internal/burble/channel/routes/:routeId/messages
POST /internal/burble/channel/routes/:routeId/events
```

`/internal/burble/mcp` proxies to the configured Burble MCP gateway using the
runtime's own `BURBLE_RUNTIME_JWT`.

Attack path:

1. Runtime A can reach Runtime B over the Docker network.
2. Runtime A calls Runtime B's `/internal/burble/mcp`.
3. Runtime B forwards the request to Burble with Runtime B's JWT.
4. Burble sees Runtime B as the caller.

The endpoint requires a `convrt_*` route ID for tool calls, and Burble checks
that the route belongs to the runtime principal. That helps. The remaining risk
comes from route ID exposure/predictability and any route ID leaked through
logs, prompts, tool schemas, or runtime state.

Recommended fix:

- Bind these endpoints to loopback only where possible.
- Require a runtime-local secret/header not visible to agent tools or models.
- Add container network policy so runtime containers cannot talk to each
  other.
- Do not expose runtime-local control endpoints on `0.0.0.0` unless they are
  authenticated.

### 3. Static/Shared Runtime Mode Is Not A User Isolation Boundary

The shared runtime Compose file configures a single runtime service and a
single `INTERNAL_API_TOKEN`.

The legacy internal tool gateway treats a matching `INTERNAL_API_TOKEN` as
`legacy` auth. In that mode, provider lookup is driven by `body.user.email`.

Attack path:

1. Shared runtime is prompt-injected or compromised.
2. It calls `/internal/tools/:tool/execute` with `INTERNAL_API_TOKEN`.
3. It supplies another user's email in the request body.
4. Burble uses the provider connection for that email.

This is not how isolated Docker runtimes should operate, but the code path
exists and is powerful.

Recommended fix:

- Treat shared/static runtime mode as development-only for multi-user
  deployments.
- Prefer runtime-principal auth everywhere.
- Remove provider tools from legacy `/internal/tools` for isolated runtimes.
- Narrow legacy mode to explicitly allowed local/dev scenarios.
- If static mode remains, bind it to one explicit principal rather than
  trusting arbitrary request-body email.

## High/Medium Findings

### 4. Attachment Fetch Uses Runtime-Supplied Attachment Metadata

`conversation.getAttachment` receives an attachment ID and an `attachments`
array from the runtime request body. It searches that array for the requested
attachment and then downloads Slack file content using the Slack bot token.

Attack path:

1. Runtime is compromised.
2. Runtime calls `conversation.getAttachment`.
3. Runtime supplies an attachment object with `source=slack` and an arbitrary
   Slack `externalId`.
4. If the bot can access that file, Burble may fetch it.

Impact:

- Potential Slack file exfiltration beyond the current run's intended
  attachments.

Recommended fix:

- Store attachment capabilities server-side per run/route.
- Pass only opaque attachment capability IDs to the runtime.
- Sign attachment capability IDs with route, runtime, attachment ID, and
  expiry.
- On fetch, validate against the stored/signed capability rather than trusting
  runtime-supplied `externalId`.

### 5. Conversation Route IDs Are Deterministic

Conversation route IDs are currently derived from:

```text
workspaceId + slackUserId + transport + destinationJson
```

and formatted as:

```text
convrt_<sha256-prefix>
```

Burble checks route ownership against runtime workspace/user, which is good.
The deterministic shape becomes risky when combined with unauthenticated
runtime-local proxy endpoints. If a route ID is leaked or guessed, the victim
runtime can be used as the bearer of its own route capability.

Recommended fix:

- Make route IDs random unguessable capability IDs.
- Or include a server-side secret nonce in the route ID derivation.
- Add expiry/revocation semantics for route capabilities.
- Avoid exposing route IDs in model-visible contexts more broadly than needed.

### 6. Runtime Output Classification Is Trusted

Burble enforces:

- In DMs: return response as-is.
- In channels: if `classification !== public`, downgrade to ephemeral.

This protects correctly classified private output. It does not protect against
a prompt-injected or compromised runtime marking private tool output as
`public`.

Attack path:

1. Runtime calls private provider tools.
2. Runtime includes private data in final text.
3. Runtime marks final response `classification=public`.
4. Burble posts publicly in a channel.

Recommended fix:

- Add taint tracking for each run.
- If any `user_private` or `restricted` tool result, Slack attachment, or
  private route context is used, force the final classification to
  `user_private` unless a trusted policy explicitly allows public release.
- Treat classification as a lower-bound from the runtime, not an authority.

### 7. Provider Connections Are Keyed By Email, Not Workspace

Provider connections use primary key:

```text
provider + email
```

For a single Slack workspace, this is probably acceptable in a PoC. For
multi-workspace deployments, email reuse, enterprise guest accounts, or account
transfers, this can cause connection clobbering or unexpected sharing.

Recommended fix:

- Add `workspace_id` to provider connection records.
- Use `(workspace_id, provider, slack_user_id)` or
  `(workspace_id, provider, email)` as the primary lookup key.
- Include workspace ID in OAuth state rows so callback handling can preserve
  workspace context.

## Existing Controls That Are Working

### Provider MCP Principal Checks

Burble validates runtime JWT claims and maps them to an `agent_runtimes` row
before serving provider MCP tools.

It checks:

- JWT signature.
- Issuer.
- Audience.
- Expiry.
- Runtime ID.
- Workspace ID.
- Slack user ID.

This prevents a runtime from simply claiming another Slack user in MCP calls.

### Provider Token Lookup Uses Runtime Principal

The provider MCP path resolves provider connections by runtime Slack user, not
by model-supplied email.

This is the correct default for isolated runtime provider tools.

### Conversation Route Validation

Burble validates route ownership before allowing provider MCP calls with a
`routeId`:

- Route must exist.
- Route must not be revoked.
- Route workspace/user must match runtime workspace/user.
- If destination is bound to a runtime ID, it must match the caller runtime.

This is an important defense against arbitrary route use.

### Public Reverse Proxy Blocks Internal Paths

The provided Caddy config blocks:

```text
/internal/*
/mcp*
```

from the public HTTPS endpoint. These paths are intended for internal runtime
traffic only.

## Attack Scenarios

### Scenario A: Runtime A Calls Runtime B

Goal: make Runtime B use User B's Burble MCP access.

Preconditions:

- Runtime A is compromised.
- Runtime A can resolve and reach Runtime B on the Docker network.
- Runtime B exposes `/internal/burble/mcp` or `/runs`.

Path:

1. Runtime A sends HTTP to Runtime B.
2. Runtime B accepts the request without caller auth.
3. Runtime B proxies provider MCP with Runtime B's JWT or runs work in Runtime
   B's state.

Mitigations:

- Authenticate runtime ingress.
- Block runtime-to-runtime network traffic.
- Bind runtime-local endpoints to loopback.

### Scenario B: Shared Runtime Uses Another User's Email

Goal: call provider tools for another connected user.

Preconditions:

- Static/shared runtime mode is enabled.
- Shared runtime has `INTERNAL_API_TOKEN`.
- Runtime can call `/internal/tools/:tool/execute`.

Path:

1. Compromised runtime calls legacy tool gateway.
2. It supplies `user.email` for another user.
3. Legacy auth path accepts the shared token.
4. Burble loads provider connection by email.

Mitigations:

- Do not use shared runtime mode for multi-user deployments.
- Remove provider tools from legacy internal gateway.
- Require runtime-principal auth and ignore body-supplied user email.

### Scenario C: Slack File Exfiltration

Goal: fetch a Slack file not attached to the current run.

Preconditions:

- Runtime can call `conversation.getAttachment`.
- Runtime knows or guesses a Slack file ID visible to the bot.

Path:

1. Runtime supplies an attachment object with `externalId=<file-id>`.
2. Burble uses Slack bot token to call `files.info`.
3. Burble downloads the private Slack file URL.
4. Runtime receives base64 content.

Mitigations:

- Server-side attachment capability store.
- Signed attachment IDs.
- Enforce route/runtime/expiry on attachment fetch.

### Scenario D: Private Tool Output Posted Publicly

Goal: exfiltrate private provider data to a public Slack channel.

Preconditions:

- Runtime is prompt-injected or malicious.
- Runtime can call private provider tools.
- Runtime controls final classification.

Path:

1. Runtime calls a user-private provider tool.
2. Runtime includes tool result in final answer.
3. Runtime marks final answer `public`.
4. Burble posts publicly.

Mitigations:

- Run-level taint tracking.
- Force private output after private tool usage.
- Require explicit trusted release policy for public summaries of private data.

## Recommended Fix Order

1. Authenticate runtime ingress.
   - Require bearer auth for `/runs`, `/runs/:id`, `/runs/:id/events`, and
     runtime-local internal endpoints.
   - Validate `runtime.id` in request body.

2. Enforce runtime network isolation.
   - Runtime containers should not reach each other.
   - Runtimes should reach only Burble MCP/tool endpoints, model providers, and
     explicitly allowed dependencies.

3. Retire or narrow legacy internal provider tools.
   - Keep `/internal/tools` only for conversation tools and legacy/dev callers
     until migration is complete.
   - Require runtime-principal auth for all provider tool use.

4. Make routes and attachments real capabilities.
   - Random or secret-backed route IDs.
   - Server-side or signed attachment capabilities.
   - Expiry and revocation.

5. Add run-level taint tracking.
   - Private tool use forces private final visibility.
   - Classification from the runtime is advisory, not authoritative.

6. Add workspace dimension to provider connection storage.
   - Avoid email-only cross-workspace ambiguity.

7. Add tests for cross-user negative cases.
   - Runtime A token cannot call Runtime B routes.
   - Runtime A cannot call Runtime B runtime API.
   - Runtime A cannot fetch Runtime B attachments.
   - Shared token cannot select arbitrary provider email in production mode.
   - Private tool use cannot produce public channel output.

## Open Questions

- Should runtime `/runs` support direct external callers at all, or only Burble?
- Should `/internal/burble/mcp` exist in production images, or only in local
  OpenClaw plugin mode?
- Do we want route IDs to be durable conversation identities or short-lived
  capabilities? If both, split them into separate identifiers.
- Should public summaries of private tool output ever be allowed in channels?
  If yes, who is trusted to make that decision?
- Is static/shared runtime mode still needed after personal runtimes are stable?

