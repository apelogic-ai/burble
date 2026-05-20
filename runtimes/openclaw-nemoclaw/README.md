# Burble OpenClaw/NemoClaw Runtime

This is Burble's deployable runtime adapter for the `openclaw-nemoclaw`
`AgentRunner`.

It implements Burble's runtime contract:

```text
POST /runs
```

and calls back into Burble's internal tool gateway:

```text
POST ${BURBLE_TOOL_GATEWAY_URL}/github.listAssignedIssues/execute
Authorization: Bearer ${BURBLE_INTERNAL_TOKEN}
```

OAuth tokens stay in Burble. The runtime receives only sanitized connection
summaries and user email, then gets classified/sanitized tool results back
from the gateway.

For the first deployable slice this runtime is a deterministic bridge over the
Burble tool gateway. The OpenClaw/NemoClaw agent loop can replace the
deterministic `runBurbleRequest` internals without changing Burble's Slack,
OAuth, visibility, or deployment boundaries.
