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

Agent operating instructions live in `skills/*.md`. The runtime preloads those
skill files into each OpenClaw prompt, while `src/openclaw-cli.ts` only appends
dynamic context such as the current tool catalog, executed tool results, and the
user request. Keep provider behavior in skills instead of scattering prompt
rules through TypeScript.

Runtime engines:

- `OPENCLAW_NEMOCLAW_ENGINE=deterministic` uses the deployable deterministic
  bridge over the Burble tool gateway.
- `OPENCLAW_NEMOCLAW_ENGINE=openclaw` invokes an `openclaw` CLI binary from
  inside the runtime container with sanitized Burble tool context.
- `OPENCLAW_NEMOCLAW_ENGINE=openclaw-gateway` invokes `openclaw agent` without
  `--local` and starts a private `openclaw gateway run` process at runtime boot,
  preserving the same Burble runtime API while letting OpenClaw use its
  Gateway-backed execution path.
- `OPENCLAW_NEMOCLAW_ENGINE=burble-direct` uses Burble's prompt and MCP tool
  loop, but sends planning turns directly to the selected model provider. This
  avoids OpenClaw agent bootstrap and native tools in latency-sensitive Slack
  flows.

OpenClaw modes are intentionally isolated behind the same `/runs` contract. A
derived image can install OpenClaw/NemoClaw without changing Burble's Slack,
OAuth, visibility, or deployment boundaries. Runtime events are normalized to
status, tool lifecycle, answer delta, final, and error events before they reach
Slack or any future messaging surface.

When `OPENCLAW_NEMOCLAW_ENGINE=openclaw` or `openclaw-gateway`, runtime startup
runs:

```bash
openclaw onboard \
  --non-interactive \
  --accept-risk \
  --flow quickstart \
  --mode local \
  --auth-choice skip \
  --skip-daemon \
  --skip-channels \
  --skip-skills \
  --skip-search \
  --skip-health \
  --workspace "${OPENCLAW_WORKSPACE_DIR}" \
  --json
```

with `OPENCLAW_STATE_DIR` and `OPENCLAW_CONFIG_PATH` passed to the CLI. The
default paths live under `/data/openclaw`, which should be backed by a Docker
volume in deployment. Set `OPENCLAW_SETUP_ON_START=false` only when the image or
volume has already been prepared.

If `OPENCLAW_CONFIG_PATCH_PATH` is set, startup applies it with
`openclaw config patch --file`. Startup then runs `openclaw config validate`
unless `OPENCLAW_VALIDATE_ON_START=false`. The runtime then generates and
applies an OpenClaw provider patch from the normalized `AI_MODEL` value. Use
`provider:model`, for example `openai:gpt-5.4`,
`anthropic:claude-opus-4.6`, or `ollama:qwen3-coder:30b-cloud`. For Ollama
Cloud, set `OLLAMA_API_KEY` and leave `OLLAMA_BASE_URL=https://ollama.com`.

Set `OPENCLAW_STREAM_DEBUG=true` temporarily to log stdout chunk timing, parsed
delta counts, and redacted previews while diagnosing whether the CLI streams
incremental output or buffers until completion.

For deeper OpenClaw internals, pass OpenClaw's own debug env vars through the
runtime: `OPENCLAW_LOG_LEVEL=debug` or `trace`,
`OPENCLAW_DIAGNOSTICS=<flags>`, `OPENCLAW_DEBUG_MODEL_TRANSPORT=true`,
`OPENCLAW_DEBUG_MODEL_PAYLOAD=summary`, and `OPENCLAW_DEBUG_SSE=events`.
Use `OPENCLAW_DEBUG_CODE_MODE=true` when code-mode tool-surface diagnostics are
relevant.
Set `OPENCLAW_RAW_STREAM_DEBUG=true` temporarily to pass OpenClaw
`--raw-stream --raw-stream-path`; the runtime stores raw JSONL under
`/data/openclaw/state/raw-streams`, parses token usage from it, and logs only
the summarized counts.
Gateway mode uses `OPENCLAW_GATEWAY_PORT` (default `18789`),
`OPENCLAW_GATEWAY_BIND` (default `loopback`), and token auth. Leave
`OPENCLAW_GATEWAY_TOKEN` unset to generate an ephemeral token for the process.
The dev OpenAI patch writes file logs to `/data/openclaw/logs/openclaw.log`.

Build the CLI image locally:

```bash
docker build \
  -f runtimes/openclaw-nemoclaw/Dockerfile.openclaw-cli \
  -t burble-openclaw-nemoclaw-openclaw-cli:dev \
  runtimes/openclaw-nemoclaw
```
