import type {
  OpenShellSandboxClient,
  OpenShellSandboxRecord,
  OpenShellSandboxStatus
} from "./openshell";
import type {
  SandboxCredentialBinding,
  SandboxEvent,
  SandboxPolicy,
  SandboxProvisionRequest,
  SandboxRunHandle,
  SandboxRunRequest
} from "../sandbox-provider";

export type OpenShellHttpFetch = (
  input: string,
  init?: RequestInit
) => Promise<Response>;

export type OpenShellHttpSandboxClientOptions = {
  baseUrl: string;
  token?: string | null;
  fetch?: OpenShellHttpFetch;
  requestTimeoutMs?: number;
};

export function createOpenShellHttpSandboxClient(
  options: OpenShellHttpSandboxClientOptions
): OpenShellSandboxClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const requestFetch = options.fetch ?? fetch;
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;

  async function requestJson<T>(
    path: string,
    init: RequestInit = {}
  ): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (init.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    if (options.token) {
      headers.set("authorization", `Bearer ${options.token}`);
    }

    const response = await fetchWithTimeout(requestFetch, `${baseUrl}${path}`, {
      ...init,
      headers
    }, {
      method: init.method ?? "GET",
      path,
      timeoutMs: requestTimeoutMs
    });
    if (!response.ok) {
      throw openShellHttpError(init.method ?? "GET", path, response.status);
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  return {
    async createSandbox(input: {
      principal: SandboxProvisionRequest["principal"];
      runtime: SandboxProvisionRequest["runtime"];
      labels: Record<string, string>;
      policy?: SandboxPolicy;
      compiledPolicy?: unknown;
      start?: SandboxProvisionRequest["start"];
    }): Promise<OpenShellSandboxRecord> {
      return coerceSandboxRecord(
        await requestJson("/sandboxes", {
          method: "POST",
          body: JSON.stringify(input)
        })
      );
    },

    async applyPolicy(input: {
      sandboxId: string;
      policy: SandboxPolicy;
      compiledPolicy: unknown;
    }): Promise<void> {
      await requestJson(`/sandboxes/${encodeURIComponent(input.sandboxId)}/policy`, {
        method: "POST",
        body: JSON.stringify({
          policy: input.policy,
          compiledPolicy: input.compiledPolicy
        })
      });
    },

    async bindCredentials(input: {
      sandboxId: string;
      credentialBindings: SandboxCredentialBinding[];
      materializedCredentials: SandboxCredentialBinding[];
      compiledProviders: unknown[];
    }): Promise<void> {
      await requestJson(
        `/sandboxes/${encodeURIComponent(input.sandboxId)}/credentials`,
        {
          method: "POST",
          body: JSON.stringify({
            credentialBindings: input.credentialBindings,
            materializedCredentials: input.materializedCredentials,
            compiledProviders: input.compiledProviders
          })
        }
      );
    },

    async run(input: {
      sandboxId: string;
      request: SandboxRunRequest;
    }): Promise<{
      runId: string;
      status: SandboxRunHandle["status"];
      exitCode?: number;
    }> {
      return coerceRunHandle(
        input.sandboxId,
        await requestJson(`/sandboxes/${encodeURIComponent(input.sandboxId)}/runs`, {
          method: "POST",
          body: JSON.stringify(input.request)
        })
      );
    },

    async getSandbox(input: {
      sandboxId: string;
    }): Promise<OpenShellSandboxRecord> {
      return coerceSandboxRecord(
        await requestJson(`/sandboxes/${encodeURIComponent(input.sandboxId)}`)
      );
    },

    async *events(input: { sandboxId: string }): AsyncIterable<SandboxEvent> {
      const headers = new Headers({ accept: "application/x-ndjson" });
      if (options.token) {
        headers.set("authorization", `Bearer ${options.token}`);
      }
      const response = await fetchWithTimeout(
        requestFetch,
        `${baseUrl}/sandboxes/${encodeURIComponent(input.sandboxId)}/events`,
        { headers },
        {
          method: "GET",
          path: `/sandboxes/${input.sandboxId}/events`,
          timeoutMs: 0
        }
      );
      if (!response.ok) {
        throw openShellHttpError(
          "GET",
          `/sandboxes/${input.sandboxId}/events`,
          response.status
        );
      }
      // TODO(S3): stream incrementally when a lifecycle event consumer exists.
      const text = await response.text();
      for (const event of parseEventText(text)) {
        yield coerceSandboxEvent(input.sandboxId, event);
      }
    },

    async terminate(input: { sandboxId: string }): Promise<void> {
      await requestJson(`/sandboxes/${encodeURIComponent(input.sandboxId)}`, {
        method: "DELETE"
      });
    }
  };
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new Error("OpenShell base URL is required");
  }
  return trimmed;
}

function openShellHttpError(
  method: string,
  path: string,
  status: number
): Error {
  return new Error(
    `OpenShell request ${method} ${path} failed with HTTP ${status}`
  );
}

async function fetchWithTimeout(
  requestFetch: OpenShellHttpFetch,
  input: string,
  init: RequestInit,
  context: { method: string; path: string; timeoutMs: number }
): Promise<Response> {
  if (context.timeoutMs <= 0) {
    return requestFetch(input, init);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), context.timeoutMs);
  try {
    const signal = combineAbortSignals(init.signal, controller.signal);
    return await requestFetch(input, {
      ...init,
      signal
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        `OpenShell request ${context.method} ${context.path} timed out after ${context.timeoutMs}ms`
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function combineAbortSignals(
  left: AbortSignal | null | undefined,
  right: AbortSignal
): AbortSignal {
  if (!left) {
    return right;
  }
  if (left.aborted || right.aborted) {
    const controller = new AbortController();
    controller.abort();
    return controller.signal;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  left.addEventListener("abort", abort, { once: true });
  right.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

function coerceSandboxRecord(value: unknown): OpenShellSandboxRecord {
  const record = objectRecord(value, "OpenShell sandbox record");
  return {
    sandboxId: stringField(record, ["sandboxId", "id"]),
    endpoint: stringField(record, ["endpoint", "endpointUrl"]),
    workspacePath: stringField(record, ["workspacePath"]),
    status: statusField(record.status),
    principal: objectField(record, "principal") as SandboxProvisionRequest["principal"],
    runtime: objectField(record, "runtime") as SandboxProvisionRequest["runtime"],
    labels: (record.labels ?? {}) as Record<string, string>,
    ...(record.policy ? { policy: record.policy as SandboxPolicy } : {}),
    credentials: Array.isArray(record.credentials)
      ? (record.credentials as SandboxCredentialBinding[])
      : []
  };
}

function coerceRunHandle(
  sandboxId: string,
  value: unknown
): { runId: string; status: SandboxRunHandle["status"]; exitCode?: number } {
  const record = objectRecord(value, "OpenShell run record");
  const status = record.status;
  if (status !== "running" && status !== "finished" && status !== "failed") {
    throw new Error(`OpenShell run record has invalid status: ${String(status)}`);
  }
  return {
    runId: stringField(record, ["runId", "id"], `${sandboxId}-run`),
    status,
    ...(typeof record.exitCode === "number" ? { exitCode: record.exitCode } : {})
  };
}

function coerceSandboxEvent(
  sandboxId: string,
  value: unknown
): SandboxEvent {
  const record = objectRecord(value, "OpenShell event record");
  const type = record.type;
  if (
    type !== "provisioned" &&
    type !== "policy_applied" &&
    type !== "credentials_bound" &&
    type !== "run_started" &&
    type !== "run_finished" &&
    type !== "terminated"
  ) {
    throw new Error(`OpenShell event has invalid type: ${String(type)}`);
  }
  return {
    sandboxId:
      typeof record.sandboxId === "string" ? record.sandboxId : sandboxId,
    type,
    at: typeof record.at === "string" ? record.at : new Date(0).toISOString(),
    ...(isRecord(record.detail)
      ? { detail: record.detail as Record<string, unknown> }
      : {})
  };
}

function parseEventText(text: string): unknown[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error("OpenShell events response must be a JSON array or lines");
    }
    return parsed;
  }
  return trimmed
    .split(/\r?\n/)
    .map(parseEventLine)
    .filter((event): event is unknown => event !== undefined);
}

function parseEventLine(line: string): unknown | undefined {
  const trimmed = line.trim();
  if (!trimmed || isSseControlLine(trimmed)) {
    return undefined;
  }
  const payload = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
  if (!payload) {
    return undefined;
  }
  return JSON.parse(payload) as unknown;
}

function isSseControlLine(line: string): boolean {
  return (
    line.startsWith(":") ||
    line.startsWith("event:") ||
    line.startsWith("id:") ||
    line.startsWith("retry:")
  );
}

function stringField(
  record: Record<string, unknown>,
  names: string[],
  fallback?: string
): string {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value) {
      return value;
    }
  }
  if (fallback !== undefined) {
    return fallback;
  }
  throw new Error(`OpenShell response missing string field: ${names.join("/")}`);
}

function statusField(value: unknown): OpenShellSandboxStatus {
  if (
    value === "provisioning" ||
    value === "ready" ||
    value === "running" ||
    value === "terminated" ||
    value === "failed"
  ) {
    return value;
  }
  throw new Error(`OpenShell sandbox record has invalid status: ${String(value)}`);
}

function objectField(
  record: Record<string, unknown>,
  field: string
): Record<string, unknown> {
  return objectRecord(record[field], `OpenShell response field ${field}`);
}

function objectRecord(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
