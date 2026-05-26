# OpenClaw Gateway Runtime Plan

## Current State

Burble currently invokes OpenClaw with:

```text
openclaw agent --local --message <prompt> --session-id <conversation-session>
```

This is simple and keeps the trust boundary inside the per-user runtime
container, but it has two practical costs:

- each request launches a fresh CLI process;
- stdout is buffered by the CLI, so Slack only sees heartbeats until OpenClaw
  emits a large final chunk.

The per-user runtime remains the right outer isolation boundary. The next
improvement is inside that runtime: keep OpenClaw warm and consume Gateway
events instead of wrapping buffered CLI stdout.

## Startup Cache

Runtime startup now writes a setup marker under `OPENCLAW_STATE_DIR` after a
successful `onboard -> config patch -> config validate` sequence. On later
starts, if the setup inputs and config patch hash match, startup skips those
steps and serves immediately.

The cache key includes:

- OpenClaw command and agent id;
- state, config, and workspace paths;
- config patch path and patch file hash;
- validation setting.

Changing the patch file or runtime config invalidates the marker and reruns
setup.

## Gateway Findings

OpenClaw documents the Gateway as its WebSocket server for channels, nodes,
sessions, and hooks. `openclaw gateway` / `openclaw gateway run` starts the
Gateway process, with local-mode safety checks and token/password options.

The `openclaw agent` command can run via Gateway by default and uses `--local`
only for embedded execution. It accepts explicit session selectors such as
`--session-id`, which matches Burble's conversation-scoped session model.

The Gateway CLI docs also expose `--raw-stream` / `--raw-stream-path`, which can
log raw model stream events to JSONL. That is the first low-risk path to prove
whether Gateway mode gives us earlier model/tool events than the current
buffered `--local` CLI path.

Primary docs:

- https://docs.openclaw.ai/cli/gateway
- https://docs.openclaw.ai/cli/agent

## Target Shape

Inside each per-user runtime container:

```text
Burble runtime HTTP server
  -> long-lived OpenClaw Gateway process
  -> Gateway agent run per Burble request
  -> stream Gateway/raw events back as Burble RunEvent
```

The Burble runtime should expose the same `/runs` API regardless of engine:

```ts
type RunEvent =
  | { type: "status"; text: string }
  | { type: "tool_call"; toolName: string; callId: string }
  | { type: "tool_result"; toolName: string; callId: string; classification: ToolClassification }
  | { type: "message_delta"; text: string }
  | { type: "final"; response: RunResponse["response"] }
  | { type: "error"; message: string };
```

## Implementation Slices

1. Add runtime engine mode:

```text
OPENCLAW_NEMOCLAW_ENGINE=openclaw-gateway
```

2. Start Gateway during runtime startup:

```text
openclaw gateway run --bind loopback --token <runtime-local-token>
```

Keep it bound inside the runtime container. Do not expose the Gateway through
Caddy or the Docker host.

3. Add a Gateway client:

- initially use CLI Gateway mode with `openclaw agent` without `--local`;
- pass Burble's conversation-scoped `--session-id`;
- enable `--raw-stream --raw-stream-path <per-run-jsonl>`;
- tail/parse the JSONL while the command runs.

4. Map raw events to Burble events:

- model deltas -> `message_delta`;
- tool start/end -> `tool_call` / `tool_result`;
- operational progress -> `status`;
- final response -> `final`.

5. If CLI Gateway mode still buffers, replace the CLI subprocess with a direct
WebSocket/RPC client to the Gateway. Keep the runtime `/runs` contract stable.

## Safety Notes

- Gateway remains single-user and trusted inside the personal runtime.
- Runtime tokens still protect Burble's tool gateway.
- Provider OAuth tokens stay in Burble. The OpenClaw child process must not
  inherit Burble MCP URLs, runtime JWTs, internal tool tokens, or provider OAuth
  credentials; those stay in the runtime wrapper and are used only when the
  wrapper executes MCP/provider tools outside OpenClaw.
- Gateway bind must remain loopback/container-private for this PoC.
- Raw-stream JSONL must be treated as sensitive runtime-local data and should
  not be persisted outside the runtime state without redaction.
