import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createOpenShellCliSandboxClient } from "../../src/agent/sandbox-providers/openshell-cli-client";
import type { OpenShellSandboxClient } from "../../src/agent/sandbox-providers/openshell";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

describe("OpenShell CLI sandbox client", () => {
  test("keeps the create command stream alive until sandbox termination", async () => {
    const dir = await mkdtemp(join(tmpdir(), "burble-openshell-cli-test-"));
    tempDirs.push(dir);
    const logPath = join(dir, "openshell.log");
    const fakeOpenShell = join(dir, "openshell");
    await writeFile(
      fakeOpenShell,
      [
        "#!/bin/sh",
        `log=${shellQuote(logPath)}`,
        'case "$*" in',
        '  *" service expose "*) echo "EXPOSE $*" >> "$log"; exit 0 ;;',
        "esac",
        'echo "PWD $(pwd)" >> "$log"',
        'echo "CREATE $*" >> "$log"',
        'trap \'echo "TERM" >> "$log"; exit 0\' TERM',
        "while true; do sleep 1; done"
      ].join("\n")
    );
    await chmod(fakeOpenShell, 0o755);

    const client = createOpenShellCliSandboxClient({
      gatewayEndpoint: "http://127.0.0.1:8080",
      openshellBin: fakeOpenShell,
      controlClient: fakeControlClient()
    });

    const sandbox = await client.createSandbox({
      principal: { workspaceId: "T123", userId: "U123" },
      runtime: { engine: "openclaw", image: "burble-openclaw:dev" },
      labels: {},
      start: {
        argv: ["bun", "src/index.ts"],
        env: { BURBLE_RUNTIME_ID: "rt_test" }
      }
    });

    const beforeTerminate = await readFile(logPath, "utf8");
    expect(beforeTerminate).toContain("CREATE ");
    expect(beforeTerminate).toContain("EXPOSE ");
    expect(beforeTerminate).toContain("PWD /");
    expect(beforeTerminate).not.toContain("TERM");

    await client.terminate({ sandboxId: sandbox.sandboxId });
    await sleep(100);

    expect(await readFile(logPath, "utf8")).toContain("TERM");
  });
});

function fakeControlClient(): OpenShellSandboxClient {
  return {
    async createSandbox() {
      throw new Error("not used by CLI client");
    },
    async applyPolicy() {},
    async bindCredentials() {},
    async run() {
      throw new Error("not used by CLI client");
    },
    async getSandbox(input) {
      return {
        sandboxId: input.sandboxId,
        endpoint: `http://${input.sandboxId}.local:8080`,
        workspacePath: "/workspace",
        status: "ready",
        principal: { workspaceId: "T123", userId: "U123" },
        runtime: { engine: "openclaw", image: "burble-openclaw:dev" },
        labels: {},
        credentials: []
      };
    },
    async *events() {},
    async terminate() {}
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
