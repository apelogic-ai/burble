type JsonRecord = Record<string, unknown>;

type SandboxRecord = {
  sandboxId: string;
  endpointUrl: string;
  workspacePath: string;
  status: "ready" | "running" | "terminated" | "failed";
  principal: JsonRecord;
  runtime: {
    engine: string;
    image: string;
  };
  labels: Record<string, string>;
  policy?: unknown;
  credentials: unknown[];
  events: SandboxEvent[];
  containerName: string;
  hostDataRoot: string;
};

type SandboxEvent = {
  sandboxId: string;
  type:
    | "provisioned"
    | "policy_applied"
    | "credentials_bound"
    | "run_started"
    | "run_finished"
    | "terminated";
  at: string;
  detail?: JsonRecord;
};

type State = {
  sandboxes: Record<string, SandboxRecord>;
};

const port = numberFromEnv("PORT", 8080);
const token = process.env.OPENSHELL_TOKEN?.trim() ?? "";
const dataRoot = trimTrailingSlash(
  process.env.OPENSHELL_DATA_ROOT?.trim() || "/opt/burble/openshell"
);
const dockerNetwork =
  process.env.OPENSHELL_DOCKER_NETWORK?.trim() || "compose_default";
const statePath = `${dataRoot}/state.json`;

await ensureDir(dataRoot);
const state = await loadState();

Bun.serve({
  port,
  async fetch(request) {
    try {
      if (!authorized(request)) {
        return json({ error: "unauthorized" }, 401);
      }
      return await route(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      return json({ error: "openshell_dev_error", message }, 500);
    }
  }
});

console.info(
  `OpenShell-compatible dev control plane listening on :${port} network=${dockerNetwork} dataRoot=${dataRoot}`
);

async function route(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);

  if (request.method === "GET" && url.pathname === "/healthz") {
    return json({ ok: true });
  }

  if (request.method === "POST" && url.pathname === "/sandboxes") {
    const body = await readJson(request);
    const runtime = object(body.runtime, "runtime") as SandboxRecord["runtime"];
    const sandboxId = `dev-${crypto.randomUUID()}`;
    const containerName = `burble-os-${sandboxId}`;
    const hostDataRoot = `${dataRoot}/sandboxes/${sandboxId}`;
    await ensureDir(hostDataRoot);
    const record: SandboxRecord = {
      sandboxId,
      endpointUrl: `http://${containerName}:8080`,
      workspacePath: hostDataRoot,
      status: "ready",
      principal: object(body.principal, "principal"),
      runtime: {
        engine: stringField(runtime.engine, "runtime.engine"),
        image: stringField(runtime.image, "runtime.image")
      },
      labels: stringRecord(body.labels),
      credentials: [],
      events: [],
      containerName,
      hostDataRoot
    };
    recordEvent(record, "provisioned", { image: record.runtime.image });
    state.sandboxes[sandboxId] = record;
    await saveState();
    return json(record);
  }

  if (parts.length >= 2 && parts[0] === "sandboxes") {
    const sandboxId = decodeURIComponent(parts[1]);
    const record = state.sandboxes[sandboxId];
    if (!record) {
      return json({ error: "not_found" }, 404);
    }

    if (request.method === "GET" && parts.length === 2) {
      await refreshContainerStatus(record);
      await saveState();
      return json(record);
    }

    if (request.method === "DELETE" && parts.length === 2) {
      await docker(["rm", "--force", record.containerName], { allowFailure: true });
      record.status = "terminated";
      recordEvent(record, "terminated");
      await saveState();
      return json({ ok: true });
    }

    if (request.method === "POST" && parts[2] === "policy") {
      const body = await readJson(request);
      record.policy = body.policy ?? body.compiledPolicy ?? body;
      recordEvent(record, "policy_applied");
      await saveState();
      return json(record);
    }

    if (request.method === "POST" && parts[2] === "credentials") {
      const body = await readJson(request);
      const bindings = Array.isArray(body.credentials)
        ? body.credentials
        : Array.isArray(body.credentialBindings)
          ? body.credentialBindings
          : [];
      record.credentials = bindings;
      recordEvent(record, "credentials_bound", { count: bindings.length });
      await saveState();
      return json(record);
    }

    if (request.method === "POST" && parts[2] === "runs") {
      const body = await readJson(request);
      const argv = stringArray(body.argv, "argv");
      const env = stringRecord(body.env);
      await startRuntimeContainer(record, argv, env);
      await refreshContainerStatus(record);
      recordEvent(record, "run_started", { argv });
      await saveState();
      return json({
        runId: `run-${sandboxId}`,
        status: record.status === "running" ? "running" : "failed",
        ...(record.status === "failed" ? { exitCode: 1 } : {})
      });
    }

    if (request.method === "GET" && parts[2] === "events") {
      return json(record.events);
    }
  }

  return json({ error: "not_found" }, 404);
}

async function startRuntimeContainer(
  record: SandboxRecord,
  argv: string[],
  env: Record<string, string>
): Promise<void> {
  const running = await containerRunning(record.containerName);
  if (running) {
    record.status = "running";
    return;
  }

  await docker(["rm", "--force", record.containerName], { allowFailure: true });
  await ensureDir(record.hostDataRoot);
  const result = await docker([
    "run",
    "--detach",
    "--name",
    record.containerName,
    "--network",
    dockerNetwork,
    "--restart",
    "unless-stopped",
    ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
    "-v",
    `${record.hostDataRoot}:${dataRootTarget(record.runtime.engine)}`,
    record.runtime.image,
    ...argv
  ]);

  if (result.code !== 0) {
    record.status = "failed";
    recordEvent(record, "run_finished", {
      exitCode: result.code,
      stderr: result.stderr.slice(0, 4000)
    });
    throw new Error(`docker run failed with code ${result.code}: ${result.stderr}`);
  }
  record.status = "running";
}

async function refreshContainerStatus(record: SandboxRecord): Promise<void> {
  const result = await docker(
    ["inspect", "--format", "{{json .State}}", record.containerName],
    { allowFailure: true }
  );
  if (result.code !== 0) {
    if (record.status !== "terminated") {
      record.status = "ready";
    }
    return;
  }

  const parsed = JSON.parse(result.stdout.trim()) as {
    Running?: boolean;
    ExitCode?: number;
  };
  if (parsed.Running) {
    record.status = "running";
    return;
  }

  record.status = parsed.ExitCode && parsed.ExitCode !== 0 ? "failed" : "ready";
  recordEvent(record, "run_finished", { exitCode: parsed.ExitCode ?? 0 });
}

async function containerRunning(name: string): Promise<boolean> {
  const result = await docker(
    ["inspect", "--format", "{{.State.Running}}", name],
    { allowFailure: true }
  );
  return result.code === 0 && result.stdout.trim() === "true";
}

function dataRootTarget(engine: string): string {
  return engine === "burble-native" ? "/data/burble-native" : "/data/openclaw";
}

function recordEvent(
  record: SandboxRecord,
  type: SandboxEvent["type"],
  detail?: JsonRecord
): void {
  const previous = record.events[record.events.length - 1];
  if (previous?.type === type && type === "run_finished") {
    return;
  }
  record.events.push({
    sandboxId: record.sandboxId,
    type,
    at: new Date().toISOString(),
    ...(detail ? { detail } : {})
  });
}

async function docker(
  args: string[],
  options?: { allowFailure?: boolean }
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe"
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  if (code !== 0 && !options?.allowFailure) {
    throw new Error(`docker ${args[0]} failed with code ${code}: ${stderr}`);
  }
  return { code, stdout, stderr };
}

async function loadState(): Promise<State> {
  try {
    const file = Bun.file(statePath);
    if (!(await file.exists())) {
      return { sandboxes: {} };
    }
    return (await file.json()) as State;
  } catch {
    return { sandboxes: {} };
  }
}

async function saveState(): Promise<void> {
  await Bun.write(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

async function readJson(request: Request): Promise<JsonRecord> {
  const value = await request.json();
  return object(value, "request body");
}

function authorized(request: Request): boolean {
  if (!token) {
    return true;
  }
  return request.headers.get("authorization") === `Bearer ${token}`;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function object(value: unknown, name: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as JsonRecord;
}

function stringField(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${name} must be a string array`);
  }
  return value;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      result[key] = entry;
    }
  }
  return result;
}

async function ensureDir(path: string): Promise<void> {
  await Bun.$`mkdir -p ${path}`.quiet();
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
