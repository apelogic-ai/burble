# Sandbox runtime launch model: exec-shim vs entrypoint-service

Status: design note / decision record
Scope: how a long-lived Burble runtime process is started inside an OpenShell
sandbox, why the current approach uses an `ExecSandbox` launcher shim, and the
migration path to the more native entrypoint-service model.

## TL;DR

- OpenShell sandboxes are **long-lived by design** (`SandboxPhase.RUNNING` is a
  steady state; `ExposeService` publishes a long-lived port). OpenShell is *not*
  a short-lived-script runner.
- `ExecSandbox` is the one short-lived primitive — it is `docker exec`
  semantics: run a command in an already-running sandbox and stream
  stdout/stderr until the command exits.
- We currently **start the runtime via `ExecSandbox`**. Because our runtime
  server never exits and exec wants the command to return, we wrap the start
  command in a **detach-and-supervise launcher shim** (an inline `python -c` /
  `bun -e` script). That shim is the source of the single-line/no-newline
  constraint that has bitten us.
- The more native model is to run the runtime as the sandbox **image
  entrypoint** (a real launcher file), pass per-runtime config through
  `SandboxTemplate.environment`, and reach it via `ExposeService`. That removes
  the shim and its footguns. The only thing it costs us is the immediate exec
  output stream — which we recover with the log-surfacing diagnostics we are
  already adding.

## Background: what the OpenShell proto actually offers

From `src/agent/sandbox-providers/openshell-proto/openshell.proto`:

```proto
rpc CreateSandbox(CreateSandboxRequest) returns (SandboxResponse);
rpc ExecSandbox(ExecSandboxRequest)     returns (stream ExecSandboxEvent);
rpc ExposeService(ExposeServiceRequest) returns (ServiceEndpointResponse);

message SandboxTemplate {            // no command / entrypoint / args field
  string image = 1;
  map<string, string> environment = 6;
  // labels, annotations, resources, ...
}

message ExecSandboxRequest {
  repeated string command = 2;       // argv
  uint32 timeout_seconds = 5;
  bool tty = 7; uint32 cols = 8; uint32 rows = 9;   // interactive command shape
}
message ExecSandboxEvent { oneof { stdout; stderr; exit; } }  // ends on exit

enum SandboxPhase { ... RUNNING = 2; SUCCEEDED = 3; FAILED = 4; ... }
```

Three facts drive the whole discussion:

1. **The sandbox is durable.** `RUNNING` is a steady phase, and `ExposeService`
   exists precisely to publish a long-lived port and hand back a URL. We use it
   to reach the runtime HTTP contract on `:8080`.
2. **`ExecSandbox` is `docker exec`.** `tty/cols/rows`, a `timeout_seconds`, and
   a stream that terminates on `exit` — this is a one-shot command runner, not a
   way to *be* the sandbox's main service.
3. **`SandboxTemplate` has no command field.** The only way the sandbox knows
   what to run as its main process is the image's own `ENTRYPOINT`/`CMD`. You
   cannot pass a per-request main command into `CreateSandbox`; you can only
   pass `environment`.

## The current approach (B): start via ExecSandbox + launcher shim

`createSandbox` builds the sandbox from a generic image with no command, then
the runtime factory calls `provider.run(...)`, which issues `ExecSandbox` with
the engine start command (`["bun","src/index.ts"]` or
`["python","/runtime/entrypoint.py"]`).

Because exec streams until the command exits, and our server never exits, we
cannot exec the server directly — the call would block forever and we would
never learn whether it bound successfully. So `openShellLaunchCommand` wraps the
start command in a small **launcher/supervisor** program
(`pythonLauncherScript` / `bunLauncherScript` in
`src/agent/sandbox-providers/openshell-grpc-client.ts`) that:

1. Spawns the real runtime **detached** (`start_new_session` / `detached:true`,
   `unref`) so it survives after the launcher exits.
2. Redirects its stdout+stderr to `/tmp/burble-runtime.log`.
3. Watches it for a short settle window (~3s) to catch immediate crashes.
4. Exits `0` if still alive (the factory then health-checks the HTTP port), or
   exits with the child's code and dumps the captured log to stderr if it died.

### Why we chose (B)

- **Per-request start command + env without rebuilding images.** burble-app
  injects a different start command and env per engine and per request; the
  image entrypoint is fixed at build time.
- **Immediate diagnostics.** The exec stream returns the runtime's startup
  stdout/stderr live, so a fast crash surfaces its real error straight away.

### What it costs

- **Exec-arg constraints.** OpenShell `ExecSandbox` rejects any command argument
  containing a newline or carriage return
  (`command argument N contains newline or carriage return characters`). That
  forces the launcher to be a **single line**, which is why the poll loop is a
  dense one-line generator / inline `setInterval`. A well-meaning reformat to
  multiple lines silently breaks runtime start for *both* engines — this has
  already happened once.
- **Code-as-string fragility.** The launcher lives as inline interpreter
  strings: no type checking, no linting, no syntax highlighting, easy to break,
  awkward to test (the unit test can only spawn it locally, where newlines are
  legal — so the OpenShell-specific constraint is enforced only by a hand-written
  assertion, not by anything that mirrors the real `ExecSandbox` validation).
- **Against the grain.** We are using a one-shot command primitive to start a
  long-lived service.

## The native alternative (A): runtime as the sandbox entrypoint

Run the runtime server as the sandbox **main process** instead of exec-ing it:

1. Bake a **generic launcher as the image `ENTRYPOINT`** — a real file
   (`/runtime/launch.py` or a small binary), version-controlled, linted, tested.
2. The launcher reads the per-runtime start command and config from
   `SandboxTemplate.environment` (e.g. `BURBLE_START_COMMAND`,
   `AGENT_RUNTIME_ENGINE`, the existing forwarded env), then `exec`s the real
   server as PID 1 and tees its output to a known log path.
3. `CreateSandbox` boots it; `ExposeService` maps `:8080`; the factory
   health-checks the URL exactly as today.

### What this buys

- The inline launcher strings disappear, and with them the newline footgun and
  the code-as-string fragility — the launcher becomes an ordinary source file.
- The runtime runs as the sandbox's main process, which is what `RUNNING` +
  `ExposeService` are designed for.

### What we must preserve

- **Per-request config:** moves from exec argv to `SandboxTemplate.environment`.
  This is a straightforward swap — env is already how most runtime config flows.
- **Start diagnostics:** we lose the immediate exec stream, so the entrypoint
  must write startup stdout/stderr to a known log (e.g. `/tmp/burble-runtime.log`)
  and we surface it on health-check failure. This is the same log-surfacing
  plumbing already being added to `waitForSandboxRuntimeHealth`, so the
  diagnostics goal and this refactor converge rather than conflict.

## Recommendation

Treat (B) as the deliberate **bootstrap** choice — it let us reach a working
sandbox-backed runtime quickly without touching the runtime images — and plan a
migration to (A) as the durable design:

1. Keep the current exec-shim, but hardened: single-line scripts with a test
   that asserts every launcher arg is newline-free, plus (ideally) a fake
   `ExecSandbox` in the e2e that rejects newline args so the OpenShell constraint
   is enforced by an integration test, not just a unit assertion.
2. Add a generic `ENTRYPOINT` launcher file to each runtime image that reads its
   start command/config from env and tees startup output to a known log.
3. Switch `CreateSandbox` to pass start config via `SandboxTemplate.environment`
   and stop issuing the start `ExecSandbox`; reach the runtime via
   `ExposeService` (already in place).
4. Delete `openShellLaunchCommand` and the inline launcher strings.

Step 1 is the hotfix already landed. Steps 2–4 are an image-touching change
(runtime Docker rebuild) and should land deliberately as their own change, not
bundled with unrelated fixes.

## Footgun checklist (until the shim is gone)

- Launcher scripts MUST be a single line. No newlines or carriage returns in any
  `ExecSandbox` command argument.
- Avoid `sh -c`; use the interpreter's own `-c` / `-e`.
- Any "overly strict" assertion near the launcher (e.g. the no-newline check) is
  encoding an OpenShell contract — find out why before relaxing it.
