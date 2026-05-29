# Nemo Hermes Burble Runtime

This image is the Hermes counterpart to `runtimes/openclaw-nemoclaw`.

It is intentionally not a `hermes chat -q` wrapper. The runtime starts a Hermes
gateway process with a Burble platform plugin named `burble`, and exposes the
same Burble control-plane health/run surface on port `8080`.

Current integration shape:

- Burble provisions the container through the existing Docker runtime factory.
- The container starts Hermes gateway with the bundled `burble` platform plugin.
- Burble `/runs` requests are injected into Hermes as normal Burble platform
  messages.
- Hermes replies for interactive runs are returned through `/runs`.
- Hermes cron/background delivery can send to a Burble `convrt_*` route through
  the same platform adapter.
- Provider data/actions go through the same Burble MCP gateway and
  route-scoped runtime JWT used by OpenClaw when `BURBLE_MCP_GATEWAY_URL` and
  `BURBLE_RUNTIME_JWT` are present.

Local build:

```bash
docker build -f runtimes/nemo-hermes/Dockerfile \
  -t burble-nemo-hermes:dev \
  runtimes/nemo-hermes
```

Dev runtime selection:

```env
AGENT_RUNTIME=openclaw-nemoclaw
AGENT_RUNTIME_FACTORY=docker
AGENT_RUNTIME_IMAGE=burble-nemo-hermes:dev
AGENT_RUNTIME_ENGINE=hermes
```

The `AGENT_RUNTIME=openclaw-nemoclaw` value is still the Burble-side adapter
contract name for `/healthz` and `/runs`. The image and engine select the
runtime implementation.
