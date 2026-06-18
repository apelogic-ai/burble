import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "bun:test";
import { createLocalDevSandboxProvider } from "../../src/agent/sandbox-providers/local-dev";
import {
  createOpenShellSandboxProvider,
  type OpenShellSandboxClient
} from "../../src/agent/sandbox-providers/openshell";
import type {
  SandboxCredentialBinding,
  SandboxEvent,
  SandboxHandle,
  SandboxPolicy,
  SandboxProvider
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
      .filter((path) => !path.includes("/agent/sandbox-providers/openshell.ts"))
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
    } else {
      await expect(provider.applyPolicy(sandbox.id, policy)).rejects.toThrow(
        "does not support egress allowlists"
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
    } else {
      await expect(
        provider.bindCredentials(sandbox.id, credentials)
      ).rejects.toThrow("does not support credential binding");
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

  if (input.expectedCapabilities.supportsDurableSandboxes) {
    test(`${name} reconstructs durable handles from the remote record after adapter restart`, async () => {
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
  }
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

function createFakeOpenShellClient(): OpenShellSandboxClient {
  const sandboxes = new Map<string, SandboxHandle>();
  const events = new Map<string, SandboxEvent[]>();

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
      at: new Date(0).toISOString(),
      ...(detail ? { detail } : {})
    });
    events.set(sandboxId, sandboxEvents);
  };

  return {
    async createSandbox(input) {
      const sandbox: SandboxHandle = {
        id: `sandbox-openshell-${sandboxes.size + 1}`,
        provider: "openshell",
        status: "ready",
        endpointUrl: `http://sandbox-openshell-${sandboxes.size + 1}.local`,
        workspacePath: `/openshell/sandbox-openshell-${
          sandboxes.size + 1
        }/workspace`,
        principal: input.principal,
        runtime: input.runtime,
        labels: input.labels,
        credentials: []
      };
      save(sandbox);
      recordEvent(sandbox.id, "provisioned");
      return toOpenShellRecord(sandbox);
    },
    async applyPolicy(input) {
      const sandbox = load(input.sandboxId);
      save({ ...sandbox, policy: input.policy });
      recordEvent(input.sandboxId, "policy_applied");
    },
    async bindCredentials(input) {
      const sandbox = load(input.sandboxId);
      save({
        ...sandbox,
        credentials: input.credentials.map((credential) => ({ ...credential }))
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
        exitCode: 0
      };
    },
    async getSandbox(input) {
      return toOpenShellRecord(load(input.sandboxId));
    },
    events(input) {
      return streamEvents(events.get(input.sandboxId) ?? []);
    },
    async terminate(input) {
      const sandbox = load(input.sandboxId);
      save({ ...sandbox, status: "terminated" });
      recordEvent(input.sandboxId, "terminated");
    }
  };
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
    yield { ...event };
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
