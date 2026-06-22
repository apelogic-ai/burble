import { describe, expect, test } from "bun:test";
import {
  compileOpenShellGrpcSandboxPolicy,
  decodeOpenShellLabelValue,
  encodeOpenShellLabelValue,
  openShellLaunchCommand,
  parseOpenShellExecEvent,
} from "../../src/agent/sandbox-providers/openshell-grpc-client";

describe("OpenShell gRPC client labels", () => {
  test("encodes Docker image refs as OpenShell-safe label values", () => {
    const encoded = encodeOpenShellLabelValue(
      "burble-nemo-hermes:dev"
    );

    expect(encoded).toMatch(/^[A-Za-z0-9_.-]+$/);
    expect(encoded.length).toBeLessThanOrEqual(63);
    expect(encoded).not.toContain(":");
    expect(encoded).not.toContain("/");
    expect(decodeOpenShellLabelValue(encoded)).toBe(
      "burble-nemo-hermes:dev"
    );
  });

  test("hashes oversized label values to satisfy OpenShell's 63 character cap", () => {
    const encoded = encodeOpenShellLabelValue(
      "burble-openclaw-nemoclaw-openclaw-cli:dev"
    );

    expect(encoded).toMatch(/^burble_sha256\.[a-f0-9]+$/);
    expect(encoded.length).toBeLessThanOrEqual(63);
  });

  test("leaves already safe label values readable", () => {
    expect(encodeOpenShellLabelValue("hermes")).toBe("hermes");
    expect(decodeOpenShellLabelValue("hermes")).toBe("hermes");
  });
});

describe("OpenShell gRPC exec events", () => {
  test("generates a shell-free launcher command for default runtime entrypoints", () => {
    const python = openShellLaunchCommand(["python", "/runtime/entrypoint.py"]);
    const bun = openShellLaunchCommand(["bun", "src/index.ts"]);

    expect(python[0]).toBe("python");
    expect(python[1]).toBe("-c");
    expect(bun[0]).toBe("bun");
    expect(bun[1]).toBe("-e");
    // Only the inline launcher script (index 2) is multi-line; the interpreter,
    // flag, and forwarded argv must never carry newlines that could split args.
    const nonScript = [
      python[0],
      python[1],
      ...python.slice(3),
      bun[0],
      bun[1],
      ...bun.slice(3)
    ];
    expect(nonScript.every((part) => !/[\r\n]/.test(part))).toBe(true);
    expect([...python, ...bun].join(" ")).not.toContain("/dev/null");
    expect([...python, ...bun].join(" ")).not.toContain("sh -");
  });

  test("python launcher reports immediate startup failure output", () => {
    const command = openShellLaunchCommand([
      "python3",
      "-c",
      "import sys; print('runtime crashed', file=sys.stderr); sys.exit(2)"
    ]);
    const result = Bun.spawnSync(command, {
      stdout: "pipe",
      stderr: "pipe"
    });

    expect(result.exitCode).toBe(2);
    expect(new TextDecoder().decode(result.stderr)).toContain(
      "runtime crashed"
    );
  });

  test("decodes byte output and snake-case exit codes", () => {
    expect(
      parseOpenShellExecEvent({
        stderr: { data: Buffer.from("runtime crashed\n") },
        exit: { exit_code: 2 }
      })
    ).toEqual({
      output: "runtime crashed\n",
      exitCode: 2,
      summary: "exit{exit_code}+stderr{data}"
    });
  });

  test("summarizes event shape when no text output is decoded", () => {
    expect(
      parseOpenShellExecEvent({
        stderr: { chunk: { bytes: 7 } },
        exit: { exitCode: 2 }
      })
    ).toEqual({
      output: "",
      exitCode: 2,
      summary: "exit{exitCode}+stderr{chunk}"
    });
  });
});

describe("OpenShell gRPC policy compiler", () => {
  test("allows runtime interpreter binaries to use the egress allowlist", () => {
    const policy = compileOpenShellGrpcSandboxPolicy({
      network: {
        egress: "allowlist",
        allowedHosts: ["api.openai.com", "burble-app:3000"]
      },
      filesystem: {
        readOnlyPaths: ["/runtime"],
        readWritePaths: ["/data/openclaw/hermes", "/tmp"]
      }
    }) as {
      networkPolicies: {
        burble_runtime: {
          binaries: Array<{ path: string; harness: boolean }>;
        };
      };
    };

    expect(policy.networkPolicies.burble_runtime.binaries).toContainEqual({
      path: "/usr/local/bin/python3.11",
      harness: false
    });
    expect(policy.networkPolicies.burble_runtime.binaries).toContainEqual({
      path: "/usr/local/bin/hermes",
      harness: false
    });
    expect(policy.networkPolicies.burble_runtime.binaries).toContainEqual({
      path: "/usr/local/bin/bun",
      harness: false
    });
  });
});
