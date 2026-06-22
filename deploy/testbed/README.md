# Burble Local Testbed

The local testbed runs Burble without real Slack Socket Mode. It exposes HTTP
endpoints that inject Slack-shaped Bolt events into the real Burble handlers and
captures outbound Slack Web API calls in memory.

## Start

```sh
bun run testbed:up
```

Burble listens on `http://localhost:3000` by default. The stack runs in
deterministic mode unless you explicitly set `AGENT_MODE=llm`, so the default
fake Slack flow does not require provider API keys.

The compose file intentionally does not pass host provider secrets into the
testbed app or OpenShell. Runtime experiments that need real providers should
route credentials through the gateway/provider boundary, not sandbox env.

Build both runtime images for OpenShell experiments:

```sh
docker compose -f deploy/testbed/compose/docker-compose.yml --profile runtime-image build
```

## Useful Endpoints

```sh
curl -sS -X POST http://localhost:3000/__testbed/reset

curl -sS -X POST http://localhost:3000/__testbed/slack/events/app_home_opened \
  -H 'content-type: application/json' \
  -d '{"user":"U_TESTBED"}'

curl -sS -X POST http://localhost:3000/__testbed/slack/actions \
  -H 'content-type: application/json' \
  -d '{"actionId":"agent_runtime_engine_select","selectedValue":"hermes","user":"U_TESTBED"}'

curl -sS -X POST http://localhost:3000/__testbed/slack/events/message.im \
  -H 'content-type: application/json' \
  -d '{"text":"hello agent","user":"U_TESTBED"}'

curl -sS http://localhost:3000/__testbed/slack/channels/D_TESTBED/messages
curl -sS http://localhost:3000/__testbed/slack/users/U_TESTBED/home
```

## Stop

```sh
bun run testbed:down
```
