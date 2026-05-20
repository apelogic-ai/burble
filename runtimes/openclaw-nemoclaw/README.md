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

Runtime engines:

- `OPENCLAW_NEMOCLAW_ENGINE=deterministic` uses the deployable deterministic
  bridge over the Burble tool gateway.
- `OPENCLAW_NEMOCLAW_ENGINE=openclaw-cli` invokes an `openclaw` CLI binary from
  inside the runtime container with sanitized Burble tool context.

CLI mode is intentionally isolated behind the same `/runs` contract. A derived
image can install OpenClaw/NemoClaw without changing Burble's Slack, OAuth,
visibility, or deployment boundaries.

Build the CLI image locally:

```bash
docker build \
  -f runtimes/openclaw-nemoclaw/Dockerfile.openclaw-cli \
  -t burble-openclaw-nemoclaw-openclaw-cli:dev \
  runtimes/openclaw-nemoclaw
```
