# Runtime Benchmark Harness

Status: local working note.

This harness measures Burble-compatible runtimes through the shared `/runs`
contract, without going through Slack.

Script:

```bash
bun scripts/runtime-bench.ts --url http://127.0.0.1:8080 --label openclaw-gateway
```

Useful options:

```bash
--question "Search the web for current MCP news and summarize the top result."
--iterations 5
--warmup 1
--stream true
--execution-mode native-runtime
--route-id convrt_bench
```

The script prints:

- `finalMs`: wall time until the run completes.
- `firstEventMs`: first runtime event observed.
- `firstDeltaMs`: first answer delta observed, when the runtime streams one.
- `firstToolCallMs`: first provider/native tool call event observed.
- `firstToolResultMs`: first tool result event observed.
- `toolCalls` / `toolResults`: visible tool loop count.
- `finalTextChars`: final answer size.

## Suggested Local Runs

OpenClaw CLI:

```bash
bun scripts/runtime-bench.ts \
  --url http://127.0.0.1:8080 \
  --label openclaw \
  --iterations 5 \
  --question "Search the web for current MCP news and summarize the top result."
```

OpenClaw Gateway:

```bash
bun scripts/runtime-bench.ts \
  --url http://127.0.0.1:8080 \
  --label openclaw-gateway \
  --iterations 5 \
  --question "Search the web for current MCP news and summarize the top result."
```

Hermes:

```bash
bun scripts/runtime-bench.ts \
  --url http://127.0.0.1:8080 \
  --label hermes \
  --stream false \
  --iterations 5 \
  --question "Search the web for current MCP news and summarize the top result."
```

Hermes currently returns the final `/runs` response on the direct HTTP request.
OpenClaw supports `application/x-ndjson` streaming on the direct `/runs`
request, so the first-event fields are more useful there.

## Cold Start

Keep cold start separate from question latency.

Cold start should measure:

1. container start or runtime provisioning start;
2. `/healthz` success;
3. first trivial run, such as `hello agent`;
4. first real web-search run after warmup.

Warm-path question latency should start only after `/healthz` is healthy and
one warmup run has completed.

## OpenClaw Modes

`openclaw` launches the `openclaw agent` CLI for each planning step. That can
pay process startup and OpenClaw bootstrap overhead on every step.

`openclaw-gateway` starts a resident `openclaw gateway run` process once, then
Burble sends HTTP requests to its local `/v1/responses` endpoint. This should
remove some per-turn process startup overhead, but the request still goes
through OpenClaw's gateway/agent machinery.

`burble-native` bypasses the OpenClaw agent process and runs Burble's own runtime
contract worker. It is the useful control when trying to isolate how much
latency comes from OpenClaw itself versus model/provider/tool latency.

Hermes is also resident: the container starts Hermes gateway once and injects
Burble turns into it as platform messages. That is why Hermes can feel quicker:
the hot path is a message injection into an already-running agent service,
while OpenClaw CLI mode can involve a new CLI process and planner step per tool
loop.

## OpenClaw Tightening Check

The current generated Burble OpenClaw patch already disables several expensive
surfaces:

- `agents.defaults.contextInjection = "never"`
- `agents.defaults.skipBootstrap = true`
- `agents.defaults.skills = []`
- `skills.allowBundled = []`
- `tools.codeMode.enabled = false`
- `agents.defaults.heartbeat.every = "0m"`
- plugin discovery is allowlisted to the selected provider plus Burble channel

OpenClaw still defaulted the gateway agent to `thinking=medium, fast=off`.
OpenClaw 2026.5.19 exposes these config fields:

- `agents.defaults.thinkingDefault`: `off | minimal | low | medium | high | xhigh | adaptive | max`
- `agents.defaults.reasoningDefault`: `off | on | stream`
- `agents.list[].fastModeDefault`: boolean
- `agents.list[].thinkingDefault` and `agents.list[].reasoningDefault`
- `models.pricing.enabled`: set false to skip background pricing catalog fetches at gateway startup
- `env.shellEnv.enabled` / `env.shellEnv.timeoutMs`: disable or bound shell env import for service deployments

Test patch used for a separate temp container:

```json
{
  "agents": {
    "defaults": {
      "thinkingDefault": "minimal",
      "reasoningDefault": "off"
    },
    "list": [
      {
        "id": "main",
        "fastModeDefault": true,
        "thinkingDefault": "minimal",
        "reasoningDefault": "off"
      }
    ]
  },
  "models": {
    "pricing": {
      "enabled": false
    }
  },
  "env": {
    "shellEnv": {
      "enabled": false,
      "timeoutMs": 100
    }
  },
  "memory": {
    "qmd": {
      "update": {
        "startup": "off"
      }
    }
  }
}
```

Gateway startup confirmed the patch was active:

```text
[gateway] agent model: openai/gpt-5.4 (thinking=minimal, fast=on)
```

Sequential warm-path measurements through `/runs`:

| Scenario | Baseline p50 | Tightened p50 | Read |
| --- | ---: | ---: | --- |
| `2 + 2`, one-token answer | 5.2s | 2.3s | Clear win; thinking/fast mode matter for simple turns. |
| Online-looking MCP-news prompt | 16.5s | 17.8s | No reliable win; provider/search behavior dominates and variance is high. |

Interpretation:

- `thinkingDefault=minimal` plus `fastModeDefault=true` is worth wiring as a
  Burble runtime option. It materially improves simple/model-only turns.
- The online-looking prompt is not a clean web-search tool benchmark in
  OpenClaw gateway mode. OpenClaw returned answer text with citations but no
  visible Burble tool events, so latency is mostly hidden model/provider path.
- The harness must avoid parallel requests on the same route/session key when
  comparing latency. OpenClaw serializes work for the same session; parallel
  runs inflated later request times.
- Startup-only knobs (`models.pricing.enabled=false`, shell env import off,
  validation/setup caching) help cold start and gateway boot, not per-question
  latency.
