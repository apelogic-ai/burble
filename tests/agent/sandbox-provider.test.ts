import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "bun:test";
import { createLocalDevSandboxProvider } from "../../src/agent/sandbox-providers/local-dev";
import {
  createOpenShellSandboxProvider,
  type OpenShellSandboxClient
} from "../../src/agent/sandbox-providers/openshell";
import type {
  OpenShellProviderBindingConfig,
  OpenShellSandboxPolicyConfig
} from "../../src/agent/sandbox-providers/openshell-policy";
import {
  cloneSandboxEvent,
  cloneSandboxEventDetail,
  type SandboxCredentialBinding,
  type SandboxEvent,
  type SandboxHandle,
  type SandboxPolicy,
  type SandboxProvider
} from "../../src/agent/sandbox-provider";

describe("SandboxProvider conformance", () => {
  runSandboxProviderConformance({
    name: "local-dev",
    createProvider: () => createLocalDevSandboxProvider(),
    expectedCapabilities: {
      isolation: "process",
      supportsEgressAllowlist: false,
      supportsCredentialBinding: false,
      supportsDurableSandboxes: false
    }
  });

  runSandboxProviderConformance({
    name: "openshell",
    createProvider: () =>
      createOpenShellSandboxProvider({
        client: createFakeOpenShellClient()
      }),
    expectedCapabilities: {
      isolation: "microvm",
      supportsEgressAllowlist: true,
      supportsCredentialBinding: true,
      supportsDurableSandboxes: true
    }
  });
});

describe("SandboxProvider OpenShell boundary", () => {
  test("does not import OpenShell adapter details outside its adapter package", () => {
    const violations = sourceFiles(join(import.meta.dir, "../../src"))
      .filter((path) => !path.includes("/agent/sandbox-providers/"))
      .flatMap((path) =>
        importSpecifiers(path)
          .filter((specifier) => /openshell/i.test(specifier))
          .map(
            (specifier) =>
              `${relative(process.cwd(), path)} imports ${specifier}`
          )
      );

    expect(violations).toEqual([]);
  });
});

describe("LocalDevSandboxProvider", () => {
  test("does not retain mutable provision request objects as sandbox state", async () => {
    const provider = createLocalDevSandboxProvider();
    const request = {
      principal: { workspaceId: "T123", userId: "U123" },
      runtime: { engine: "hermes" as const, image: "burble-runtime:dev" },
      labels: { jobId: "job-123", tier: "dev" }
    };

    const sandbox = await provider.provision(request);
    request.principal.userId = "other-user";
    request.runtime.image = "mutated-image";
    request.labels.tier = "admin";

    const attached = await provider.attach(sandbox.id);

    expect(attached.principal).toEqual({ workspaceId: "T123", userId: "U123" });
    expect(attached.runtime).toEqual({
      engine: "hermes",
      image: "burble-runtime:dev"
    });
    expect(attached.labels).toEqual({ jobId: "job-123", tier: "dev" });
  });

  test("deep-clones event detail when recording and streaming", async () => {
    const provider = createLocalDevSandboxProvider();
    const sandbox = await provider.provision({
      principal: { workspaceId: "T123", userId: "U123" },
      runtime: { engine: "hermes", image: "burble-runtime:dev" },
      labels: {}
    });
    const argv = ["echo", "ready"];

    await provider.run(sandbox.id, { argv });
    argv[0] = "mutated";

    const firstStream = await collectEvents(provider.streamEvents(sandbox.id));
    const started = firstStream.find((event) => event.type === "run_started");
    expect(started?.detail?.argv).toEqual(["echo", "ready"]);

    if (Array.isArray(started?.detail?.argv)) {
      started.detail.argv[0] = "stream-mutated";
    }

    const secondStream = await collectEvents(provider.streamEvents(sandbox.id));
    const startedAgain = secondStream.find(
      (event) => event.type === "run_started"
    );
    expect(startedAgain?.detail?.argv).toEqual(["echo", "ready"]);
  });

  test("preserves structured event detail values while cloning", async () => {
    const at = new Date("2026-06-19T00:00:00.000Z");
    const detail = { at, seen: new Set(["github"]) };

    const cloned = cloneSandboxEventDetail(detail);

    expect(cloned).not.toBe(detail);
    expect(cloned.at).toBeInstanceOf(Date);
    expect((cloned.at as Date).toISOString()).toBe(at.toISOString());
    expect(cloned.seen).toBeInstanceOf(Set);
    expect([...(cloned.seen as Set<string>)]).toEqual(["github"]);
  });

  test("clones circular event detail without recursing forever", () => {
    const detail: Record<string, unknown> = { name: "cycle" };
    detail.self = detail;

    const cloned = cloneSandboxEventDetail(detail);

    expect(cloned).not.toBe(detail);
    expect(cloned.name).toBe("cycle");
    expect(cloned.self).toBe(cloned);
  });
});

describe("OpenShellSandboxProvider", () => {
  test("reconstructs durable handles from the remote record after adapter restart", async () => {
    const client = createFakeOpenShellClient();
    const original = createOpenShellSandboxProvider({ client });
    const sandbox = await original.provision({
      principal: { workspaceId: "T123", userId: "U123" },
      runtime: { engine: "hermes", image: "burble-runtime:dev" },
      labels: { jobId: "job-123" }
    });
    await original.applyPolicy(sandbox.id, {
      network: {
        egress: "allowlist",
        allowedHosts: ["burble-gateway.internal"]
      }
    });
    await original.bindCredentials(sandbox.id, [
      {
        name: "github",
        kind: "provider-token",
        ref: "provider:github:T123:U123",
        delivery: "gateway_callback"
      }
    ]);

    const restarted = createOpenShellSandboxProvider({ client });
    const attached = await restarted.attach(sandbox.id);

    expect(attached).toMatchObject({
      id: sandbox.id,
      provider: "openshell",
      principal: { workspaceId: "T123", userId: "U123" },
      runtime: { engine: "hermes", image: "burble-runtime:dev" },
      labels: { jobId: "job-123" },
      credentials: [
        {
          name: "github",
          kind: "provider-token",
          ref: "provider:github:T123:U123",
          delivery: "gateway_callback"
        }
      ]
    });
    expect(attached.policy?.network).toEqual({
      egress: "allowlist",
      allowedHosts: ["burble-gateway.internal"]
    });
  });

  test("does not materialize gateway-callback credential bindings into the sandbox", async () => {
    const client = createFakeOpenShellClient();
    const provider = createOpenShellSandboxProvider({ client });
    const sandbox = await provider.provision({
      principal: { workspaceId: "T123", userId: "U123" },
      runtime: { engine: "hermes", image: "burble-runtime:dev" },
      labels: {}
    });

    await provider.bindCredentials(sandbox.id, [
      {
        name: "github",
        kind: "provider-token",
        ref: "provider:github:T123:U123",
        delivery: "gateway_callback"
      },
      {
        name: "runtime-config",
        kind: "secret-ref",
        ref: "secret:runtime-config",
        delivery: "sandbox_reference"
      }
    ]);

    expect(client.materializedCredentialCalls).toEqual([
      [
        {
          name: "runtime-config",
          kind: "secret-ref",
          ref: "secret:runtime-config",
          delivery: "sandbox_reference"
        }
      ]
    ]);
    expect(client.compiledProviderCalls).toEqual([
      [
        {
          name: "github",
          kind: "provider-token",
          ref: "provider:github:T123:U123",
          delivery: "gateway_callback",
          materialized: false
        },
        {
          name: "runtime-config",
          kind: "secret-ref",
          ref: "secret:runtime-config",
          delivery: "sandbox_reference",
          materialized: true
        }
      ]
    ]);

    const attached = await provider.attach(sandbox.id);
    expect(attached.credentials.map((credential) => credential.name)).toEqual([
      "github",
      "runtime-config"
    ]);
  });

  test("passes compiled neutral policy config to the OpenShell client", async () => {
    const client = createFakeOpenShellClient();
    const provider = createOpenShellSandboxProvider({ client });
    const sandbox = await provider.provision({
      principal: { workspaceId: "T123", userId: "U123" },
      runtime: { engine: "hermes", image: "burble-runtime:dev" },
      labels: {}
    });

    await provider.applyPolicy(sandbox.id, {
      network: {
        egress: "allowlist",
        allowedHosts: ["GitHub.com", "burble-gateway.internal"]
      },
      filesystem: {
        readOnlyPaths: ["/workspace"],
        readWritePaths: ["/tmp/burble"]
      },
      resources: {
        cpuCount: 2,
        memoryMb: 1024
      },
      maxLifetimeMs: 60_000
    });

    expect(client.compiledPolicyCalls).toEqual([
      {
        version: 1,
        egress: {
          default: "deny",
          allowHosts: ["burble-gateway.internal", "github.com"]
        },
        filesystem: {
          readOnly: ["/workspace"],
          readWrite: ["/tmp/burble"]
        },
        resources: {
          cpuCount: 2,
          memoryMb: 1024,
          maxLifetimeMs: 60_000
        },
        providers: []
      }
    ]);
  });

  test("does not fetch after run because the run result is the authoritative result", async () => {
    const client = createFakeOpenShellClient();
    client.nextRunOutput = "runtime crashed during import";
    const provider = createOpenShellSandboxProvider({ client });
    const sandbox = await provider.provision({
      principal: { workspaceId: "T123", userId: "U123" },
      runtime: { engine: "hermes", image: "burble-runtime:dev" },
      labels: {}
    });

    const run = await provider.run(sandbox.id, { argv: ["true"] });

    expect(run.output).toBe("runtime crashed during import");
    expect(client.getSandboxCalls).toBe(0);
  });

  test("does not fetch after terminate so delete-on-terminate clients can succeed", async () => {
    const client = createFakeOpenShellClient({ deleteOnTerminate: true });
    const provider = createOpenShellSandboxProvider({ client });
    const sandbox = await provider.provision({
      principal: { workspaceId: "T123", userId: "U123" },
      runtime: { engine: "hermes", image: "burble-runtime:dev" },
      labels: {}
    });

    await expect(provider.terminate(sandbox.id)).resolves.toBeUndefined();
  });

  test("uses monotonic fake sandbox ids after delete-on-terminate", async () => {
    const client = createFakeOpenShellClient({ deleteOnTerminate: true });
    const provider = createOpenShellSandboxProvider({ client });

    const first = await provider.provision({
      principal: { workspaceId: "T123", userId: "U123" },
      runtime: { engine: "hermes", image: "burble-runtime:dev" },
      labels: {}
    });
    const second = await provider.provision({
      principal: { workspaceId: "T123", userId: "U123" },
      runtime: { engine: "hermes", image: "burble-runtime:dev" },
      labels: {}
    });
    await provider.terminate(first.id);
    const third = await provider.provision({
      principal: { workspaceId: "T123", userId: "U123" },
      runtime: { engine: "hermes", image: "burble-runtime:dev" },
      labels: {}
    });

    expect([first.id, second.id, third.id]).toEqual([
      "sandbox-openshell-1",
      "sandbox-openshell-2",
      "sandbox-openshell-3"
    ]);
  });
});

function runSandboxProviderConformance(input: {
  name: string;
  createProvider: () => SandboxProvider;
  expectedCapabilities: Omit<
    ReturnType<SandboxProvider["capabilities"]>,
    "provider"
  >;
}) {
  const { name, createProvider, expectedCapabilities } = input;

  test(`${name} provisions, runs, streams, attaches, and terminates through the neutral port`, async () => {
    const provider = createProvider();
    const capabilities = provider.capabilities();

    expect(capabilities).toMatchObject({
      provider: name,
      ...expectedCapabilities
    });

    const sandbox = await provider.provision({
      principal: { workspaceId: "T123", userId: "U123" },
      runtime: { engine: "hermes", image: "burble-runtime:dev" },
      labels: { jobId: "job-123" }
    });

    expect(sandbox).toMatchObject({
      provider: name,
      status: "ready",
      endpointUrl: expect.stringContaining("sandbox"),
      workspacePath: expect.stringContaining(sandbox.id)
    });

    const policy: SandboxPolicy = {
      network: {
        egress: "allowlist",
        allowedHosts: ["burble-gateway.internal"]
      },
      maxLifetimeMs: 60_000
    };

    if (capabilities.supportsEgressAllowlist) {
      const withPolicy = await provider.applyPolicy(sandbox.id, policy);
      expect(withPolicy.policy?.network.allowedHosts).toEqual([
        "burble-gateway.internal"
      ]);
      // TODO(S3): verify disallowed egress is blocked against real OpenShell.
    } else {
      await expect(provider.applyPolicy(sandbox.id, policy)).rejects.toThrow(
        "does not support enforced egress policies"
      );
      await expect(
        provider.applyPolicy(sandbox.id, { network: { egress: "deny" } })
      ).rejects.toThrow(
        "does not support enforced egress policies"
      );
    }

    const credentials: SandboxCredentialBinding[] = [
      {
        name: "github",
        kind: "provider-token",
        ref: "provider:github:T123:U123",
        delivery: "gateway_callback"
      }
    ];

    if (capabilities.supportsCredentialBinding) {
      const withCredentials = await provider.bindCredentials(
        sandbox.id,
        credentials
      );
      expect(withCredentials.credentials).toEqual(credentials);
      expect(withCredentials.credentials[0]?.delivery).toBe("gateway_callback");
      // TODO(S3): assert real OpenShell only injects materializedCredentials.
    } else {
      await expect(
        provider.bindCredentials(sandbox.id, credentials)
      ).rejects.toThrow("does not support credential binding");
      await expect(provider.bindCredentials(sandbox.id, [])).rejects.toThrow(
        "does not support credential binding"
      );
    }

    const run = await provider.run(sandbox.id, {
      argv: ["echo", "ready"],
      env: { BURBLE_RUNTIME: "hermes" }
    });
    expect(run).toMatchObject({
      sandboxId: sandbox.id,
      status: "finished",
      exitCode: 0
    });

    const attached = await provider.attach(sandbox.id);
    expect(attached.status).toBe("ready");

    const events = await collectEvents(provider.streamEvents(sandbox.id));
    const eventTypes = events.map((event) => event.type);
    expect(eventTypes).toContain("provisioned");
    expect(eventTypes).toContain("run_started");
    expect(eventTypes).toContain("run_finished");
    expect(eventTypes).not.toContain("terminated");

    await provider.terminate(sandbox.id);
    const terminated = await provider.attach(sandbox.id);
    expect(terminated.status).toBe("terminated");
    const terminatedEvents = await collectEvents(
      provider.streamEvents(sandbox.id)
    );
    expect(terminatedEvents.map((event) => event.type)).toContain("terminated");
  });
}

async function collectEvents(
  events: AsyncIterable<SandboxEvent>
): Promise<SandboxEvent[]> {
  const collected: SandboxEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

function sourceFiles(root: string): string[] {
  const entries = readdirSync(root, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return entry.isFile() && path.endsWith(".ts") ? [path] : [];
  });
}

function importSpecifiers(path: string): string[] {
  const source = readFileSync(path, "utf8");
  const specifiers: string[] = [];
  for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
    specifiers.push(match[1] ?? "");
  }
  for (const match of source.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) {
    specifiers.push(match[1] ?? "");
  }
  return specifiers.filter(Boolean);
}

type FakeOpenShellClient = OpenShellSandboxClient & {
  getSandboxCalls: number;
  compiledPolicyCalls: OpenShellSandboxPolicyConfig[];
  compiledProviderCalls: OpenShellProviderBindingConfig[][];
  materializedCredentialCalls: SandboxCredentialBinding[][];
  nextRunOutput?: string;
};

function createFakeOpenShellClient(options?: {
  deleteOnTerminate?: boolean;
}): FakeOpenShellClient {
  const sandboxes = new Map<string, SandboxHandle>();
  const events = new Map<string, SandboxEvent[]>();
  let eventSequence = 0;
  let sandboxSequence = 0;

  const load = (sandboxId: string): SandboxHandle => {
    const sandbox = sandboxes.get(sandboxId);
    if (!sandbox) {
      throw new Error(`Sandbox ${sandboxId} was not found`);
    }
    return cloneHandle(sandbox);
  };

  const save = (sandbox: SandboxHandle): void => {
    sandboxes.set(sandbox.id, cloneHandle(sandbox));
  };

  const recordEvent = (
    sandboxId: string,
    type: SandboxEvent["type"],
    detail?: Record<string, unknown>
  ): void => {
    const sandboxEvents = events.get(sandboxId) ?? [];
    sandboxEvents.push({
      sandboxId,
      type,
      at: new Date(eventSequence++).toISOString(),
      ...(detail ? { detail: cloneSandboxEventDetail(detail) } : {})
    });
    events.set(sandboxId, sandboxEvents);
  };

  const client: FakeOpenShellClient = {
    getSandboxCalls: 0,
    compiledPolicyCalls: [],
    compiledProviderCalls: [],
    materializedCredentialCalls: [],

    async createSandbox(input) {
      sandboxSequence += 1;
      const sandbox: SandboxHandle = {
        id: `sandbox-openshell-${sandboxSequence}`,
        provider: "openshell",
        status: "ready",
        endpointUrl: `http://sandbox-openshell-${sandboxSequence}.local`,
        workspacePath: `/openshell/sandbox-openshell-${sandboxSequence}/workspace`,
        principal: input.principal,
        runtime: input.runtime,
        labels: input.labels,
        ...(input.policy ? { policy: input.policy } : {}),
        credentials: []
      };
      save(sandbox);
      recordEvent(sandbox.id, "provisioned");
      return toOpenShellRecord(sandbox);
    },
    async applyPolicy(input) {
      const sandbox = load(input.sandboxId);
      client.compiledPolicyCalls.push(input.compiledPolicy);
      save({ ...sandbox, policy: input.policy });
      recordEvent(input.sandboxId, "policy_applied");
    },
    async bindCredentials(input) {
      const sandbox = load(input.sandboxId);
      client.compiledProviderCalls.push(
        input.compiledProviders.map((provider) => ({ ...provider }))
      );
      client.materializedCredentialCalls.push(
        input.materializedCredentials.map((credential) => ({ ...credential }))
      );
      save({
        ...sandbox,
        credentials: input.credentialBindings.map((credential) => ({
          ...credential
        }))
      });
      recordEvent(input.sandboxId, "credentials_bound");
    },
    async run(input) {
      const sandbox = load(input.sandboxId);
      save({ ...sandbox, status: "running" });
      recordEvent(input.sandboxId, "run_started", { argv: input.request.argv });
      save({ ...sandbox, status: "ready" });
      recordEvent(input.sandboxId, "run_finished", { exitCode: 0 });
      return {
        runId: `${input.sandboxId}-run-1`,
        status: "finished",
        exitCode: 0,
        ...(client.nextRunOutput === undefined
          ? {}
          : { output: client.nextRunOutput })
      };
    },
    async getSandbox(input) {
      client.getSandboxCalls += 1;
      return toOpenShellRecord(load(input.sandboxId));
    },
    events(input) {
      return streamEvents(events.get(input.sandboxId) ?? []);
    },
    async terminate(input) {
      const sandbox = load(input.sandboxId);
      recordEvent(input.sandboxId, "terminated");
      if (options?.deleteOnTerminate) {
        sandboxes.delete(sandbox.id);
        return;
      }
      save({ ...sandbox, status: "terminated" });
    }
  };

  return client;
}

function toOpenShellRecord(sandbox: SandboxHandle) {
  return {
    sandboxId: sandbox.id,
    endpoint: sandbox.endpointUrl,
    workspacePath: sandbox.workspacePath,
    status: sandbox.status,
    principal: sandbox.principal,
    runtime: sandbox.runtime,
    labels: sandbox.labels,
    policy: sandbox.policy,
    credentials: sandbox.credentials
  };
}

async function* streamEvents(
  events: SandboxEvent[]
): AsyncIterable<SandboxEvent> {
  for (const event of events) {
    yield cloneSandboxEvent(event);
  }
}

function cloneHandle(handle: SandboxHandle): SandboxHandle {
  return {
    ...handle,
    labels: { ...handle.labels },
    principal: { ...handle.principal },
    runtime: { ...handle.runtime },
    ...(handle.policy
      ? {
          policy:
            handle.policy.network.egress === "allowlist"
              ? {
                  ...handle.policy,
                  network: {
                    egress: "allowlist",
                    allowedHosts: [...handle.policy.network.allowedHosts]
                  }
                }
              : {
                  ...handle.policy,
                  network: { egress: handle.policy.network.egress }
                }
        }
      : {}),
    credentials: handle.credentials.map((credential) => ({ ...credential }))
  };
}
