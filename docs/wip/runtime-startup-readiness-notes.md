# Runtime Startup and Readiness Notes

Status: working notes. Not part of the runtime contract spec.

## Finding

OpenClaw/NemoClaw runtimes appear to start much more slowly than Nemo-Hermes
runtimes. The architectures are structurally identical; the asymmetry is in
**when each runtime reports itself ready**, not in what they have to do.

## Both runtimes are two-process

Each runtime image is a thin contract wrapper that speaks the Burble runtime
contract on one side and spawns a pre-packaged Nemo binary as a sub-process on
the other.

```
┌──────────────────────────────────────────────────────────────┐
│  OpenClaw/NemoClaw runtime container                         │
│                                                              │
│   ┌──────────────────────────────┐                           │
│   │  Bun/TS contract wrapper     │  ← speaks Burble runtime  │
│   │  (server.ts, port 8080)      │    contract to Burble     │
│   │  /healthz /capabilities      │    (/runs, events, etc.)  │
│   │  /runs /runs/:id/events …    │                           │
│   └──────────┬───────────────────┘                           │
│              │ spawns + waits-for-ready                      │
│              ▼                                               │
│   ┌──────────────────────────────┐                           │
│   │  openclaw gateway run        │  ← pre-packaged NemoClaw  │
│   │  (loopback :18789)           │    binary, the actual     │
│   │  /v1/responses               │    agent loop             │
│   └──────────────────────────────┘                           │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│  Nemo-Hermes runtime container                               │
│                                                              │
│   ┌──────────────────────────────┐                           │
│   │  Python aiohttp wrapper      │  ← speaks Burble runtime  │
│   │  (entrypoint.py, port 8080)  │    contract to Burble     │
│   │  /healthz /capabilities      │                           │
│   │  /runs /runs/:id/events …    │                           │
│   │  /internal/hermes/runs/…/    │ ← gateway calls back here │
│   │     messages                 │                           │
│   └──────────┬───────────────────┘                           │
│              │ spawns (NO wait-for-ready)                    │
│              ▼                                               │
│   ┌──────────────────────────────┐                           │
│   │  hermes gateway run          │  ← pre-packaged NemoHermes│
│   │  (subprocess)                │    binary, the actual     │
│   └──────────────────────────────┘    agent loop             │
└──────────────────────────────────────────────────────────────┘
```

The OpenClaw binary exposes OpenAI-shaped `/v1/responses` on loopback. The
Hermes binary runs as a sub-process and calls back into the Python wrapper at
`/internal/hermes/runs/{run_id}/messages`. Both are two-process. Both wrap a
Nemo* binary.

## OpenClaw boot sequence

Source: `runtimes/openclaw-nemoclaw/src/index.ts:20`.

```
1. await ensureOpenClawSetup(config)        ← synchronous setup-on-start
2. startOpenClawGatewayIfNeeded(config)     ← spawn NemoClaw binary
3. await gateway.ready                      ← WAIT for the gateway's readiness
                                              signal on stdout (up to 60s)
4. Bun.serve({ port: 8080, ... })           ← ONLY NOW open port 8080
```

Burble cannot reach `/healthz` at all until the NemoClaw binary has printed
its ready line on stdout. The container is genuinely not accepting traffic
before then. Cold start *looks* slow because it *is* slow — but the report is
honest.

## Hermes boot sequence

Source: `runtimes/nemo-hermes/runtime/entrypoint.py:527`.

```
1. self._install_plugin()
2. self._ensure_gateway_config()
3. self._start_gateway()                    ← spawn NemoHermes binary
                                              (subprocess.Popen, returns
                                               immediately, no readiness wait)
4. web.TCPSite(runner, "0.0.0.0", 8080).start()   ← open port 8080
```

And `handle_healthz`:

```python
if self.gateway_process and self.gateway_process.poll() is not None:
    return web.Response(text="gateway stopped", status=503)
return web.Response(text="ok")
```

This only checks whether the gateway subprocess has *died* — it does not check
whether it's *ready*. So Hermes' `/healthz` flips to 200 as soon as the Python
wrapper binds 8080, while the NemoHermes binary may still be initializing
behind it.

## The asymmetry in one line

**Hermes reports `wrapper-is-up`. OpenClaw reports `whole-stack-is-up`.**

## Consequences

- Cold-start *total* time (container → first turn actually succeeds) is
  probably similar between the two runtimes. Both spawn comparable Nemo
  binaries; both pay similar setup costs.
- Cold-start *to-/healthz-200* time is hugely different because of the
  readiness contract.
- For Hermes, the wait gets paid by the **first user turn** instead of by
  health-check polling. If the first interaction with a freshly-spun-up Hermes
  is immediate, it can hit a race where the gateway is not yet ready. Failed
  runs in this window look like "Hermes was slow on the first message" rather
  than "Hermes lied about ready."
- For OpenClaw, the wait is paid up-front and visibly, by the container
  orchestrator or by Burble's runtime factory waiting for `/healthz`.

## Two cheap fixes

1. **Make Hermes' `/healthz` honest.** Track a `gateway_ready: bool` and only
   return 200 once the NemoHermes binary has reported ready (probe it via HTTP,
   or watch its stdout the same way OpenClaw does in
   `gateway.ts:80 createGatewayReadiness`). This trades "Hermes looks fast" for
   "Hermes' first turn is reliable." The perceived speed today is hiding a
   real race.
2. **Make OpenClaw's setup-on-start lazier.** `ensureOpenClawSetup(config)`
   runs synchronously before the port opens. If parts of that work could be
   deferred until first `/runs`, container readiness would come earlier. The
   tradeoff is the first turn pays for it instead, like Hermes today — same
   accounting, different visibility.

The most honest version: OpenClaw is already accurate; Hermes should join it.
Then both report ready when they actually are, and a fair comparison of the
underlying binaries becomes possible.

## E2E readiness harness idea

We should add a small end-to-end readiness harness for both supported runtime
families. The goal is not to test conversation quality. The goal is to prove
that Burble can create a runtime, apply the generated config, and observe the
runtime as ready through the same control-plane path used in production.

Candidate shape:

1. Build or use local dev images for:
   - OpenClaw/NemoClaw runtime (`openclaw` or `openclaw-gateway` engine).
   - Nemo-Hermes runtime (`hermes` engine).
2. Start each runtime through Burble's managed container runtime factory, not
   by shelling out to `docker run` directly.
3. Inject the normal generated runtime config:
   - runtime id;
   - runtime JWT;
   - workspace/user principal metadata;
   - tool gateway URL and internal token;
   - MCP gateway URL where applicable;
   - engine-specific config/patch paths.
4. Wait for the same readiness state Burble uses operationally.

Pass criteria, per engine:

```text
runtime.created
runtime.container_started
runtime.healthz_ok
runtime.capabilities_ok
runtime.ready_recorded
```

The final assertion should be on the persisted runtime record, for example:

```ts
expect(runtime.status).toBe("ready");
expect(runtime.engine).toBe(engine);
expect(runtime.endpointUrl).toBeTruthy();
```

Then perform direct probes against the endpoint:

```ts
expect(await fetch(`${runtime.endpointUrl}/healthz`)).toHaveStatus(200);
expect(await fetch(`${runtime.endpointUrl}/capabilities`)).toHaveStatus(200);
```

This should be a readiness test, not a first-turn test. Real provider calls,
Slack delivery, and LLM output belong in a separate contract/e2e layer.

Suggested tiers:

- `runtime-readiness-smoke`: CI-capable when Docker is available. Uses
  deterministic/no-provider settings where possible. Starts both runtime
  families, waits for ready, then tears down containers/volumes.
- `runtime-readiness-full`: manual or nightly. Exercises the real
  OpenClaw Gateway path and any Hermes gateway readiness signal once Hermes
  exposes one.

Possible command gate:

```bash
BURBLE_E2E_RUNTIMES=1 bun test tests/e2e/runtime-readiness.test.ts
```

This would catch config generation, image startup, health-window, env-var, and
capability-manifest regressions without paying for a full user-message flow.

## Open questions

- Does the NemoHermes binary expose its own readiness probe (HTTP or stdout
  signal) the Python wrapper can watch?
- What is `ensureOpenClawSetup` actually doing on each boot — is it cacheable
  across container restarts, or is it cheap enough that the discussion is
  moot?
- Should the runtime contract specify the meaning of `/healthz` — wrapper-up
  vs whole-stack-up — so future runtime images are not free to choose either?
- Is the first-turn race in Hermes observable today (failed runs, retries,
  silent fallbacks)? Worth checking observability events around the first
  `/runs` after a runtime spin-up.
