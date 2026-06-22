import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import type { SandboxPolicy } from "../sandbox-provider";
import type { OpenShellSandboxClient, OpenShellSandboxRecord } from "./openshell";
import {
  compileOpenShellGrpcSandboxPolicy,
  createOpenShellGrpcSandboxClient,
  runtimeLabels,
  shortSandboxName
} from "./openshell-grpc-client";

export type OpenShellCliSandboxClientOptions = {
  gatewayEndpoint: string;
  openshellBin?: string | null;
  token?: string | null;
  requestTimeoutMs?: number;
  controlClient?: OpenShellSandboxClient;
};

type RunningProcess = ReturnType<typeof Bun.spawn>;

export function createOpenShellCliSandboxClient(
  options: OpenShellCliSandboxClientOptions
): OpenShellSandboxClient {
  const openshellBin = options.openshellBin?.trim() || "openshell";
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const controlClient =
    options.controlClient ??
    createOpenShellGrpcSandboxClient({
      endpoint: options.gatewayEndpoint,
      token: options.token,
      requestTimeoutMs
    });
  const createProcesses = new Map<string, RunningProcess>();

  return {
    async createSandbox(input) {
      if (!input.start?.argv.length) {
        throw new Error("OpenShell CLI sandbox creation requires start.argv");
      }

      const sandboxName = shortSandboxName();
      const labels = runtimeLabels(input.labels, input.principal, input.runtime);
      const tempDir = await mkdtemp(join(tmpdir(), "burble-openshell-"));
      const policyPath = join(tempDir, "policy.yaml");
      await writeFile(
        policyPath,
        YAML.stringify(toCliPolicy(input.policy ?? emptySandboxPolicy()))
      );

      const createArgs = [
        ...gatewayArgs(options.gatewayEndpoint),
        "sandbox",
        "create",
        "--name",
        sandboxName,
        "--from",
        input.runtime.image,
        "--no-tty",
        "--policy",
        policyPath,
        ...labelArgs(labels),
        ...envArgs(input.start.env ?? {}),
        "--",
        ...input.start.argv
      ];

      const proc = spawnCli(openshellBin, createArgs);
      const output = captureProcessOutput(proc);
      try {
        const ready = await waitForCreatedSandbox({
          controlClient,
          sandboxName,
          proc,
          output,
          timeoutMs: 120_000
        });
        await runCli(openshellBin, [
          ...gatewayArgs(options.gatewayEndpoint),
          "service",
          "expose",
          sandboxName,
          "8080",
          "runtime"
        ]);
        trackCreateProcess(createProcesses, sandboxName, ready.sandboxId, proc);
        return await controlClient.getSandbox({ sandboxId: ready.sandboxId });
      } catch (error) {
        await stopCreateProcess(proc);
        throw enrichCliError(error, "OpenShell sandbox create", output.text());
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },

    applyPolicy(input) {
      return controlClient.applyPolicy(input);
    },

    bindCredentials(input) {
      return controlClient.bindCredentials(input);
    },

    run() {
      throw new Error(
        "OpenShell CLI sandboxes must launch workloads at sandbox creation"
      );
    },

    getSandbox(input) {
      return controlClient.getSandbox(input);
    },

    events(input) {
      return controlClient.events(input);
    },

    async terminate(input) {
      const proc = createProcesses.get(input.sandboxId);
      if (proc) {
        createProcesses.delete(input.sandboxId);
        await stopCreateProcess(proc);
      }
      return controlClient.terminate(input);
    }
  };
}

function trackCreateProcess(
  processes: Map<string, RunningProcess>,
  sandboxName: string,
  sandboxId: string,
  proc: RunningProcess
) {
  processes.set(sandboxName, proc);
  processes.set(sandboxId, proc);
  void proc.exited.finally(() => {
    if (processes.get(sandboxName) === proc) {
      processes.delete(sandboxName);
    }
    if (processes.get(sandboxId) === proc) {
      processes.delete(sandboxId);
    }
  });
}

function gatewayArgs(endpoint: string): string[] {
  return ["--gateway-endpoint", endpoint];
}

function labelArgs(labels: Record<string, string>): string[] {
  return Object.entries(labels).flatMap(([key, value]) => [
    "--label",
    `${key}=${value}`
  ]);
}

function envArgs(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([key, value]) => [
    "--env",
    `${key}=${value}`
  ]);
}

function spawnCli(bin: string, args: string[]): RunningProcess {
  return Bun.spawn([bin, ...args], {
    stdout: "pipe",
    stderr: "pipe"
  });
}

async function runCli(bin: string, args: string[]): Promise<string> {
  const proc = spawnCli(bin, args);
  const [stdout, stderr, code] = await Promise.all([
    new Response(readableStreamOrNull(proc.stdout)).text(),
    new Response(readableStreamOrNull(proc.stderr)).text(),
    proc.exited
  ]);
  if (code !== 0) {
    throw new Error(
      `OpenShell CLI failed (${code}): ${[stderr, stdout]
        .filter(Boolean)
        .join("\n")
        .trim()}`
    );
  }
  return stdout;
}

async function waitForCreatedSandbox(input: {
  controlClient: OpenShellSandboxClient;
  sandboxName: string;
  proc: RunningProcess;
  output: ProcessOutput;
  timeoutMs: number;
}): Promise<OpenShellSandboxRecord> {
  const timeoutAt = Date.now() + input.timeoutMs;
  let exitCode: number | null = null;
  void input.proc.exited.then((code) => {
    exitCode = code;
  });

  let lastError: unknown;
  while (Date.now() < timeoutAt) {
    if (exitCode !== null && exitCode !== 0) {
      throw new Error(
        `OpenShell sandbox create exited ${exitCode}: ${input.output.text()}`
      );
    }
    try {
      const record = await input.controlClient.getSandbox({
        sandboxId: input.sandboxName
      });
      if (record.status === "ready" || record.status === "running") {
        return record;
      }
      if (record.status === "failed" || record.status === "terminated") {
        throw new TerminalSandboxError(
          `OpenShell sandbox ${input.sandboxName} reached ${record.status}`
        );
      }
    } catch (error) {
      if (error instanceof TerminalSandboxError) {
        throw error;
      }
      lastError = error;
    }
    await sleep(500);
  }

  throw new Error(
    `OpenShell sandbox ${input.sandboxName} did not become ready: ${String(
      lastError
    )}`
  );
}

async function stopCreateProcess(proc: RunningProcess): Promise<void> {
  const exited = proc.exited.then(() => true);
  if (await Promise.race([exited, sleep(0).then(() => false)])) {
    return;
  }
  proc.kill("SIGTERM");
  if (await Promise.race([exited, sleep(2_000).then(() => false)])) {
    return;
  }
  proc.kill("SIGKILL");
  await Promise.race([exited, sleep(2_000)]);
}

function captureProcessOutput(proc: RunningProcess): ProcessOutput {
  const output = new ProcessOutput(20_000);
  void output.capture(readableStreamOrNull(proc.stdout));
  void output.capture(readableStreamOrNull(proc.stderr));
  return output;
}

class ProcessOutput {
  private chunks = "";
  constructor(private readonly maxLength: number) {}

  async capture(stream: ReadableStream<Uint8Array> | null): Promise<void> {
    if (!stream) {
      return;
    }
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      this.append(decoder.decode(value, { stream: true }));
    }
    this.append(decoder.decode());
  }

  text(): string {
    return this.chunks.trim();
  }

  private append(value: string) {
    if (!value) {
      return;
    }
    this.chunks = (this.chunks + value).slice(-this.maxLength);
  }
}

function enrichCliError(error: unknown, action: string, output: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${action} failed: ${message}${output ? `\n${output}` : ""}`);
}

function readableStreamOrNull(
  value: unknown
): ReadableStream<Uint8Array> | null {
  return value && typeof value === "object" && "getReader" in value
    ? (value as ReadableStream<Uint8Array>)
    : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class TerminalSandboxError extends Error {}

function emptySandboxPolicy() {
  return {
    network: { egress: "deny" as const },
    filesystem: { readOnlyPaths: [], readWritePaths: [] }
  };
}

function toCliPolicy(policy: SandboxPolicy) {
  const compiled = compileOpenShellGrpcSandboxPolicy(policy);
  const filesystem = compiled.filesystem as {
    includeWorkdir?: boolean;
    readOnly?: string[];
    readWrite?: string[];
  };
  return {
    version: compiled.version,
    filesystem_policy: {
      include_workdir: filesystem.includeWorkdir ?? true,
      read_only: filesystem.readOnly ?? [],
      read_write: filesystem.readWrite ?? []
    },
    landlock: compiled.landlock,
    process: compiled.process,
    network_policies: compiled.networkPolicies
  };
}
