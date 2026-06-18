import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  createLocalDevSandboxProvider,
  type LocalDevSandboxProvider
} from "../../src/agent/sandbox-providers/local-dev";
import {
  createOpenShellSandboxProvider,
  type OpenShellSandboxClient
} from "../../src/agent/sandbox-providers/openshell";
import type {
  SandboxEvent,
  SandboxProvider
} from "../../src/agent/sandbox-provider";

describe("SandboxProvider conformance", () => {
  runSandboxProviderConformance("local-dev", () =>
    createLocalDevSandboxProvider()
  );

  runSandboxProviderConformance("openshell", () =>
    createOpenShellSandboxProvider({
      client: createFakeOpenShellClient()
    })
  );
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

function runSandboxProviderConformance(
  name: string,
  createProvider: () => SandboxProvider
) {
  test(`${name} provisions, runs, streams, attaches, and terminates through the neutral port`, async () => {
    const provider = createProvider();
    const capabilities = provider.capabilities();

    expect(capabilities).toMatchObject({
      provider: name,
      isolation: expect.any(String),
      supportsEgressAllowlist: true,
      supportsCredentialBinding: true,
      supportsDurableSandboxes: expect.any(Boolean)
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

    const withPolicy = await provider.applyPolicy(sandbox.id, {
      network: {
        egress: "allowlist",
        allowedHosts: ["burble-gateway.internal"]
      },
      maxLifetimeMs: 60_000
    });
    expect(withPolicy.policy?.network.allowedHosts).toEqual([
      "burble-gateway.internal"
    ]);

    const withCredentials = await provider.bindCredentials(sandbox.id, [
      {
        name: "github",
        kind: "provider-token",
        ref: "provider:github:T123:U123"
      }
    ]);
    expect(withCredentials.credentials).toEqual([
      {
        name: "github",
        kind: "provider-token",
        ref: "provider:github:T123:U123"
      }
    ]);
    expect(JSON.stringify(withCredentials)).not.toContain("secret");

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
    expect(attached.status).toBe("running");

    const events = await collectEvents(provider.streamEvents(sandbox.id));
    expect(events.map((event) => event.type)).toEqual([
      "provisioned",
      "policy_applied",
      "credentials_bound",
      "run_started",
      "run_finished"
    ]);

    await provider.terminate(sandbox.id);
    const terminated = await provider.attach(sandbox.id);
    expect(terminated.status).toBe("terminated");
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

function createFakeOpenShellClient(): OpenShellSandboxClient {
  const delegate: LocalDevSandboxProvider = createLocalDevSandboxProvider();
  return {
    async createSandbox(input) {
      const sandbox = await delegate.provision({
        principal: input.principal,
        runtime: input.runtime,
        labels: input.labels
      });
      return {
        sandboxId: sandbox.id,
        endpoint: sandbox.endpointUrl,
        workspacePath: sandbox.workspacePath,
        status: "ready"
      };
    },
    async applyPolicy(input) {
      await delegate.applyPolicy(input.sandboxId, input.policy);
    },
    async bindCredentials(input) {
      await delegate.bindCredentials(input.sandboxId, input.credentials);
    },
    async run(input) {
      const result = await delegate.run(input.sandboxId, input.request);
      return {
        runId: result.id,
        status: "finished",
        exitCode: result.exitCode ?? 0
      };
    },
    async getSandbox(input) {
      const sandbox = await delegate.attach(input.sandboxId);
      return {
        sandboxId: sandbox.id,
        endpoint: sandbox.endpointUrl,
        workspacePath: sandbox.workspacePath,
        status: sandbox.status
      };
    },
    events(input) {
      return delegate.streamEvents(input.sandboxId);
    },
    async terminate(input) {
      await delegate.terminate(input.sandboxId);
    }
  };
}
