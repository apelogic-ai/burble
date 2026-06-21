import {
  credentials,
  Metadata,
  status as grpcStatus,
  type CallOptions,
  type ServiceClientConstructor
} from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";
import { Buffer } from "node:buffer";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  SandboxCredentialBinding,
  SandboxEvent,
  SandboxPolicy
} from "../sandbox-provider";
import type {
  OpenShellProviderBindingConfig,
  OpenShellSandboxPolicyConfig
} from "./openshell-policy";
import type {
  OpenShellSandboxClient,
  OpenShellSandboxRecord
} from "./openshell";

type GrpcUnary = (
  request: Record<string, unknown>,
  metadata: Metadata,
  options: CallOptions,
  callback: (error: Error | null, response: unknown) => void
) => void;

type GrpcServerStream = (
  request: Record<string, unknown>,
  metadata: Metadata,
  options: CallOptions
) => {
  on(event: "data", listener: (event: unknown) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "end", listener: () => void): void;
};

type OpenShellGrpcService = {
  Health: GrpcUnary;
  CreateSandbox: GrpcUnary;
  GetSandbox: GrpcUnary;
  DeleteSandbox: GrpcUnary;
  UpdateConfig: GrpcUnary;
  ExposeService: GrpcUnary;
  GetService: GrpcUnary;
  ExecSandbox: GrpcServerStream;
};

export type OpenShellGrpcSandboxClientOptions = {
  endpoint: string;
  token?: string | null;
  requestTimeoutMs?: number;
};

const protoDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "openshell-proto"
);
const principalWorkspaceLabel = "burble.workspace_id";
const principalUserLabel = "burble.user_id";
const runtimeEngineLabel = "burble.runtime_engine";
const runtimeImageLabel = "burble.runtime_image";
const encodedLabelValuePrefix = "burble_b64.";
const openShellLabelValuePattern = /^[A-Za-z0-9_.-]+$/;

export function createOpenShellGrpcSandboxClient(
  options: OpenShellGrpcSandboxClientOptions
): OpenShellSandboxClient {
  const service = createGrpcService(options);
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const metadata = () => {
    const meta = new Metadata();
    const token = options.token?.trim();
    if (token) {
      meta.set("authorization", `Bearer ${token}`);
    }
    return meta;
  };

  return {
    async createSandbox(input) {
      const sandboxName = shortSandboxName();
      const labels = runtimeLabels(input.labels, input.principal, input.runtime);
      objectRecord(
        await unary(service.CreateSandbox, {
          name: sandboxName,
          labels,
          spec: {
            environment: {},
            template: {
              image: input.runtime.image,
              labels
            },
            policy: toOpenShellGrpcPolicy(emptySandboxPolicy())
          }
        }),
        "OpenShell CreateSandbox response"
      );
      const serviceResponse = objectRecord(
        await unary(service.ExposeService, {
          sandbox: sandboxName,
          service: "runtime",
          targetPort: 8080,
          domain: false
        }),
        "OpenShell ExposeService response"
      );
      const readySandbox = await waitForSandboxReady(
        service,
        sandboxName,
        metadata()
      );
      return recordFromSandbox({
        sandbox: readySandbox,
        endpoint: stringOrNull(serviceResponse.url) ?? "",
        principal: input.principal,
        runtime: input.runtime,
        labels,
        credentials: []
      });
    },

    async applyPolicy(input) {
      await unary(service.UpdateConfig, {
        name: input.sandboxId,
        policy: toOpenShellGrpcPolicy(input.policy),
        global: false
      });
    },

    async bindCredentials(_input: {
      sandboxId: string;
      credentialBindings: SandboxCredentialBinding[];
      materializedCredentials: SandboxCredentialBinding[];
      compiledProviders: OpenShellProviderBindingConfig[];
    }) {
      // Real OpenShell providers are first-class gateway resources. Burble's S3
      // path currently env-injects only the runtime auth token and does not yet
      // provision OpenShell provider records, so there is nothing to attach here.
    },

    async run(input) {
      const command = shellBackgroundCommand(input.request.argv);
      const sandboxObjectId = await getSandboxObjectId(
        service,
        input.sandboxId,
        metadata()
      );
      let exitCode: number | undefined;
      let output = "";
      await new Promise<void>((resolve, reject) => {
        const stream = service.ExecSandbox(
          {
            sandboxId: sandboxObjectId,
            command: ["sh", "-lc", command],
            environment: input.request.env,
            workdir: "/runtime"
          },
          metadata(),
          callOptions(requestTimeoutMs)
        );
        stream.on("data", (event) => {
          const record = objectRecord(event, "OpenShell exec event");
          const stdout = isRecord(record.stdout) ? record.stdout : null;
          const stderr = isRecord(record.stderr) ? record.stderr : null;
          output = appendExecOutput(output, stdout);
          output = appendExecOutput(output, stderr);
          const exit = isRecord(record.exit) ? record.exit : null;
          if (exit && typeof exit.exitCode === "number") {
            exitCode = exit.exitCode;
          }
        });
        stream.on("error", reject);
        stream.on("end", resolve);
      });

      return {
        runId: `run-${input.sandboxId}`,
        status: exitCode === undefined || exitCode === 0 ? "running" : "failed",
        ...(exitCode === undefined || exitCode === 0 ? {} : { exitCode }),
        ...(output.trim() ? { output: output.trim() } : {})
      };
    },

    async getSandbox(input) {
      const response = objectRecord(
        await unary(service.GetSandbox, { name: input.sandboxId }),
        "OpenShell GetSandbox response"
      );
      const sandbox = objectRecord(response.sandbox, "OpenShell sandbox");
      const labels = sandboxLabels(sandbox);
      const serviceEndpoint = await getRuntimeServiceUrl(
        service,
        input.sandboxId,
        metadata()
      );
      return recordFromSandbox({
        sandbox,
        endpoint: serviceEndpoint ?? "",
        principal: principalFromLabels(labels),
        runtime: runtimeFromLabels(labels),
        labels,
        credentials: []
      });
    },

    async *events(_input): AsyncIterable<SandboxEvent> {
      throw new Error(
        "OpenShell gRPC event streaming is not implemented; use sandbox status polling"
      );
    },

    async terminate(input) {
      await unary(service.DeleteSandbox, { name: input.sandboxId });
    }
  };

  function unary(method: GrpcUnary, request: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      method.call(
        service,
        request,
        metadata(),
        callOptions(requestTimeoutMs),
        (error, response) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(response);
        }
      );
    });
  }
}

function createGrpcService(
  options: OpenShellGrpcSandboxClientOptions
): OpenShellGrpcService {
  const packageDefinition = loadSync(join(protoDir, "openshell.proto"), {
    includeDirs: [protoDir],
    longs: Number,
    enums: String,
    defaults: true,
    oneofs: true,
    keepCase: false
  });
  const loaded = (awaitlessGrpcLoad(packageDefinition) as Record<string, unknown>)
    .openshell as Record<string, unknown>;
  const v1 = objectRecord(loaded.v1, "OpenShell proto package");
  const Service = v1.OpenShell as ServiceClientConstructor;
  return new Service(
    grpcTarget(options.endpoint),
    options.endpoint.startsWith("https://")
      ? credentials.createSsl()
      : credentials.createInsecure()
  ) as unknown as OpenShellGrpcService;
}

function awaitlessGrpcLoad(packageDefinition: unknown): unknown {
  // Isolated wrapper keeps the dynamic require type out of call sites.
  return require("@grpc/grpc-js").loadPackageDefinition(packageDefinition);
}

async function getRuntimeServiceUrl(
  service: OpenShellGrpcService,
  sandboxId: string,
  metadata: Metadata,
  timeoutMs = 30_000
): Promise<string | null> {
  const response = await new Promise<unknown>((resolve, reject) => {
    service.GetService(
      { sandbox: sandboxId, service: "runtime" },
      metadata,
      callOptions(timeoutMs),
      (error, result) => {
        if (error) {
          if (grpcErrorCode(error) === grpcStatus.NOT_FOUND) {
            resolve(null);
            return;
          }
          reject(error);
          return;
        }
        resolve(result ?? null);
      }
    );
  });
  if (!response) {
    return null;
  }
  return stringOrNull(objectRecord(response, "OpenShell GetService response").url);
}

async function getSandboxObjectId(
  service: OpenShellGrpcService,
  sandboxName: string,
  requestMetadata: Metadata,
  timeoutMs = 30_000
): Promise<string> {
  const sandboxResponse = objectRecord(
    await new Promise<unknown>((resolve, reject) => {
      service.GetSandbox(
        { name: sandboxName },
        requestMetadata,
        callOptions(timeoutMs),
        (error, result) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(result);
        }
      );
    }),
    "OpenShell GetSandbox response"
  );
  const sandbox = objectRecord(sandboxResponse.sandbox, "OpenShell sandbox");
  const metadata = objectRecord(sandbox.metadata, "OpenShell sandbox metadata");
  const id = stringOrNull(metadata.id);
  if (!id) {
    throw new Error(`OpenShell sandbox ${sandboxName} is missing metadata.id`);
  }
  return id;
}

async function waitForSandboxReady(
  service: OpenShellGrpcService,
  sandboxName: string,
  requestMetadata: Metadata
): Promise<Record<string, unknown>> {
  const timeoutAt = Date.now() + 120_000;
  let lastPhase: unknown;
  while (Date.now() < timeoutAt) {
    const sandbox = await getSandboxRecord(service, sandboxName, requestMetadata);
    const status = isRecord(sandbox.status) ? sandbox.status : {};
    lastPhase = status.phase;
    if (lastPhase === "SANDBOX_PHASE_RUNNING") {
      return sandbox;
    }
    if (
      lastPhase === "SANDBOX_PHASE_FAILED" ||
      lastPhase === "SANDBOX_PHASE_SUCCEEDED"
    ) {
      throw new Error(
        `OpenShell sandbox ${sandboxName} reached terminal phase ${String(lastPhase)} while provisioning`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `OpenShell sandbox ${sandboxName} did not become ready (last phase ${String(lastPhase)})`
  );
}

async function getSandboxRecord(
  service: OpenShellGrpcService,
  sandboxName: string,
  requestMetadata: Metadata,
  timeoutMs = 30_000
): Promise<Record<string, unknown>> {
  const response = objectRecord(
    await new Promise<unknown>((resolve, reject) => {
      service.GetSandbox(
        { name: sandboxName },
        requestMetadata,
        callOptions(timeoutMs),
        (error, result) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(result);
        }
      );
    }),
    "OpenShell GetSandbox response"
  );
  return objectRecord(response.sandbox, "OpenShell sandbox");
}

function recordFromSandbox(input: {
  sandbox: Record<string, unknown>;
  endpoint: string;
  principal: OpenShellSandboxRecord["principal"];
  runtime: OpenShellSandboxRecord["runtime"];
  labels: Record<string, string>;
  credentials: SandboxCredentialBinding[];
}): OpenShellSandboxRecord {
  const metadata = isRecord(input.sandbox.metadata) ? input.sandbox.metadata : {};
  const status = isRecord(input.sandbox.status) ? input.sandbox.status : {};
  const name = stringOrNull(metadata.name) ?? stringOrNull(metadata.id) ?? "";
  const labels = sandboxLabels(input.sandbox);
  return {
    sandboxId: name,
    endpoint: rewriteLocalEndpoint(input.endpoint),
    workspacePath: "/runtime",
    status: sandboxStatus(status.phase),
    principal: input.principal,
    runtime: input.runtime,
    labels: Object.keys(labels).length > 0 ? labels : input.labels,
    credentials: input.credentials
  };
}

function runtimeLabels(
  labels: Record<string, string>,
  principal: OpenShellSandboxRecord["principal"],
  runtime: OpenShellSandboxRecord["runtime"]
): Record<string, string> {
  return encodeOpenShellLabelValues({
    ...labels,
    [principalWorkspaceLabel]: principal.workspaceId,
    [principalUserLabel]: principal.userId,
    [runtimeEngineLabel]: runtime.engine,
    [runtimeImageLabel]: runtime.image
  });
}

function sandboxLabels(sandbox: Record<string, unknown>): Record<string, string> {
  const metadata = isRecord(sandbox.metadata) ? sandbox.metadata : {};
  return decodeOpenShellLabelValues(stringRecord(metadata.labels) ?? {});
}

function principalFromLabels(
  labels: Record<string, string>
): OpenShellSandboxRecord["principal"] {
  return {
    workspaceId: labels[principalWorkspaceLabel] ?? "",
    userId: labels[principalUserLabel] ?? ""
  };
}

function runtimeFromLabels(
  labels: Record<string, string>
): OpenShellSandboxRecord["runtime"] {
  return {
    engine: runtimeEngineFromLabel(labels[runtimeEngineLabel]),
    image: labels[runtimeImageLabel] ?? ""
  };
}

function runtimeEngineFromLabel(
  value: string | undefined
): OpenShellSandboxRecord["runtime"]["engine"] {
  switch (value) {
    case "burble-native":
    case "deterministic":
    case "hermes":
    case "openclaw":
    case "openclaw-gateway":
      return value;
    default:
      return "openclaw";
  }
}

function appendExecOutput(
  current: string,
  payload: Record<string, unknown> | null
): string {
  const data = payload?.data;
  if (!data) {
    return current;
  }
  const text =
    typeof data === "string"
      ? data
      : data instanceof Uint8Array
        ? Buffer.from(data).toString("utf8")
        : "";
  if (!text) {
    return current;
  }
  return `${current}${text}`.slice(-4000);
}

function encodeOpenShellLabelValues(
  labels: Record<string, string>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(labels).map(([key, value]) => [
      key,
      encodeOpenShellLabelValue(value)
    ])
  );
}

function decodeOpenShellLabelValues(
  labels: Record<string, string>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(labels).map(([key, value]) => [
      key,
      decodeOpenShellLabelValue(value)
    ])
  );
}

export function encodeOpenShellLabelValue(value: string): string {
  if (
    openShellLabelValuePattern.test(value) &&
    !value.startsWith(encodedLabelValuePrefix)
  ) {
    return value;
  }
  return `${encodedLabelValuePrefix}${Buffer.from(value, "utf8").toString(
    "base64url"
  )}`;
}

export function decodeOpenShellLabelValue(value: string): string {
  if (!value.startsWith(encodedLabelValuePrefix)) {
    return value;
  }
  return Buffer.from(
    value.slice(encodedLabelValuePrefix.length),
    "base64url"
  ).toString("utf8");
}

function toOpenShellGrpcPolicy(policy: SandboxPolicy): Record<string, unknown> {
  return {
    version: 1,
    filesystem: {
      includeWorkdir: true,
      readOnly: policy.filesystem?.readOnlyPaths ?? [],
      readWrite: policy.filesystem?.readWritePaths ?? []
    },
    landlock: {
      compatibility: "best_effort"
    },
    process: {},
    networkPolicies: toOpenShellGrpcNetworkPolicies(policy)
  };
}

function toOpenShellGrpcNetworkPolicies(
  policy: SandboxPolicy
): Record<string, unknown> {
  if (policy.network.egress === "open") {
    throw new Error(
      "OpenShell gRPC policy does not support unrestricted egress; use an allowlist or deny policy"
    );
  }
  return {
    burble_runtime: {
      name: "burble_runtime",
      endpoints:
        policy.network.egress === "deny"
          ? []
          : policy.network.allowedHosts.map(toNetworkEndpoint),
      binaries: []
    }
  };
}

function toNetworkEndpoint(host: string): Record<string, unknown> {
  const { hostname, port } = splitHostPort(host);
  return {
    host: hostname,
    ports: [port],
    protocol: "rest",
    tls: "passthrough",
    enforcement: "enforce",
    access: "full"
  };
}

function splitHostPort(host: string): { hostname: string; port: number } {
  const trimmed = host.trim().toLowerCase();
  const match = /^(?<hostname>.+):(?<port>\d+)$/.exec(trimmed);
  if (!match?.groups) {
    return { hostname: trimmed, port: 443 };
  }
  return {
    hostname: match.groups.hostname,
    port: Number.parseInt(match.groups.port, 10)
  };
}

function emptySandboxPolicy(): SandboxPolicy {
  return {
    network: { egress: "deny" },
    filesystem: { readOnlyPaths: [], readWritePaths: [] }
  };
}

function sandboxStatus(phase: unknown): OpenShellSandboxRecord["status"] {
  switch (phase) {
    case "SANDBOX_PHASE_RUNNING":
      return "running";
    case "SANDBOX_PHASE_FAILED":
    case "SANDBOX_PHASE_SUCCEEDED":
    case "SANDBOX_PHASE_UNKNOWN":
      return "failed";
    case "SANDBOX_PHASE_PENDING":
    case "SANDBOX_PHASE_UNSPECIFIED":
      return "provisioning";
    default:
      return "failed";
  }
}

function shellBackgroundCommand(argv: string[]): string {
  const command = argv.map(shellQuote).join(" ");
  return [
    `(${command}) >/tmp/burble-runtime.log 2>&1 &`,
    "pid=$!",
    "sleep 0.2",
    'if kill -0 "$pid" 2>/dev/null; then',
    '  echo "$pid" >/tmp/burble-runtime.pid',
    "  exit 0",
    "fi",
    'wait "$pid"',
    "status=$?",
    "cat /tmp/burble-runtime.log >&2 2>/dev/null || true",
    "exit $status"
  ].join("; ");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function grpcTarget(endpoint: string): string {
  const url = new URL(endpoint);
  return url.host;
}

function shortSandboxName(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `b-${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function rewriteLocalEndpoint(endpoint: string): string {
  if (!endpoint) {
    return endpoint;
  }
  try {
    const url = new URL(endpoint);
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
      url.hostname = "openshell";
      return url.toString().replace(/\/+$/, "");
    }
  } catch {
    return endpoint;
  }
  return endpoint.replace(/\/+$/, "");
}

function objectRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function stringRecord(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) {
    return null;
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      result[key] = entry;
    }
  }
  return result;
}

function callOptions(timeoutMs: number): CallOptions {
  return {
    deadline: new Date(Date.now() + timeoutMs)
  };
}

function grpcErrorCode(error: Error): number | undefined {
  const code = (error as unknown as { code?: unknown }).code;
  return typeof code === "number"
    ? code
    : undefined;
}
