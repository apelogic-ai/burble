# OpenShell upstream contributions — draft comments

Status: **DRAFTS for review. Nothing posted.** Each block is a proposed comment
on an existing NVIDIA/OpenShell issue, written from the perspective of an
independent second integrator (we provision OpenShell sandboxes over the gRPC
API to run long-lived, multi-tenant agent runtimes).

Targets, by value:
1. [#848 — support custom sandbox entrypoint command](https://github.com/NVIDIA/OpenShell/issues/848) — the launch-model gap; we could PR it.
2. [#1805 — initial command not run after restart](https://github.com/NVIDIA/OpenShell/issues/1805) — same root cause; restart-persistence.
3. [#1633 — supervisor-proxied host-local endpoints](https://github.com/NVIDIA/OpenShell/issues/1633) — our MCP/tool-gateway egress case.
4. [#1963 — sandbox exec rejects multi-line scripts](https://github.com/NVIDIA/OpenShell/issues/1963) — direct repro of a bug that bit us.

---

## #848 — support custom sandbox entrypoint command

We hit this independently from a different angle and wanted to add a data point
in favor of a first-class `SandboxSpec.command`.

We provision sandboxes programmatically over the gRPC API (no CLI in the loop)
to run long-lived agent runtimes — an HTTP server that must stay up for the
sandbox's lifetime. With no spec field for the main process, our only option is
`CreateSandbox` (supervisor → `sleep infinity`) followed by `ExecSandbox` to
launch the server. That has three problems for a programmatic integrator:

1. `ExecSandbox` streams until the command exits, but our workload never exits —
   so we have to wrap the start command in a detach-and-background shim just to
   make the exec call return. That's fragile, and the shim is a multi-line
   `-c` script, so it also runs into #1963.
2. The command isn't part of the sandbox's persisted state, so it's lost on
   restart (#1805) — a dealbreaker for always-on runtimes.
3. It's two round-trips plus a readiness race instead of a declarative create.

Your proposed minimal change is exactly what we'd want: a `command` field on
`SandboxSpec` that the driver writes into `OPENSHELL_SANDBOX_COMMAND` instead of
`sleep infinity` (the supervisor already honors it). The one requirement we'd
add is that it be **persisted in the spec** so it survives gateway/host restart —
i.e. the fix for this issue and #1805 are the same field.

Happy to help here — we can contribute the proto + driver wiring, or test a
branch against our gRPC integration, whichever is more useful.

---

## #1805 — sandbox doesn't run the initial custom command after system restart

Independent corroboration, and a use case where this is load-bearing rather than
cosmetic.

We run always-on, multi-tenant agent runtimes inside OpenShell sandboxes (one
long-lived HTTP server per sandbox). Your diagnostic matches what we see exactly:
the workload from `sandbox create … -- <cmd>` is an exec-after-Ready, not part of
the sandbox spec, so after a gateway/host restart the container comes back as
supervisor → `sleep infinity` and the runtime is gone even though the sandbox
reports Ready/Running.

For an always-on deployment that means every gateway restart silently drops every
workload while the sandbox still looks healthy. We've had to build external
reconcile/health logic to detect "Ready but workload dead" and re-provision —
which is exactly the gap this describes.

This is the same root cause as #848 (no spec-level command field; the driver
hardcodes `sleep infinity`). The clean fix is to persist the start command in the
sandbox spec and replay it on `resume_persisted_sandboxes()`, rather than treating
it as an ephemeral CLI exec. Glad to help review or test a fix.

---

## #1633 — supervisor-proxied host-local endpoints (generalize inference.local)

+1 — we're a concrete instance of the host-local service case this describes,
specifically the MCP tool-server example.

Our agent sandboxes need to reach two host-side services: an HTTP tool gateway
and an MCP gateway (the latter is SSE / streamable-HTTP). We went down "Path 1"
(bind `0.0.0.0` + `allowed_ips`) and hit the exact problems enumerated here:

- The host IP the container uses isn't stable across drivers/compose networking,
  so the `allowed_ips` entry becomes a fragile, environment-specific templating
  step.
- Private/RFC1918 resolved addresses are rejected unless explicitly allowlisted,
  which isn't obvious until egress silently fails.
- For the SSE/streaming MCP endpoint we also had to reason carefully about TLS
  handling (terminate vs skip) so the proxy wouldn't break the stream.

A supervisor-proxied virtual host (generalizing `inference.local` to arbitrary
host services) would remove all of this: a stable internal hostname, no
`allowed_ips` templating, no `0.0.0.0` exposure. Two things we'd ask the design to
keep in mind:

1. **Streaming** endpoints (SSE / WebSocket) must pass through without the proxy
   buffering or terminating in a way that breaks them — the same property the
   `inference.local` route already provides for streaming inference.
2. **Per-route policy** (method/path allow rules) should still apply, like the
   existing inference route, so this stays deny-by-default rather than opening a
   blanket tunnel.

Happy to share more detail on our setup if it helps shape the design.

---

## #1963 — sandbox exec rejects multi-line scripts passed to bash -c / python3 -c

Independent repro / confirmation — this bit us in a non-obvious place.

We generate a small launcher script and run it via `ExecSandbox`
(`python3 -c <script>`, and a `bun -e <script>` equivalent) to start a long-lived
runtime and detach from it. The script needs a few lines (spawn the child, poll
liveness, capture stderr). The blanket newline rejection in `reject_control_chars()`
forces the whole script onto one line; when we briefly reformatted it across
lines, every sandbox start failed with
`command argument 2 contains newline or carriage return characters` — for both
the Python and the JS runtimes.

So beyond the agent-authored-script case in the report, this also affects anyone
using the documented `-c` / `-e` pattern to bootstrap a process via exec. The
argument to `bash -c` / `python3 -c` / `node -e` is a script body by definition,
so rejecting newlines there breaks the normal idiom. +1 on accepting newlines in
the script-argument case (or at minimum not blanket-rejecting `\n` / `\r` in exec
arguments).
