import { describe, expect, test } from "bun:test";
import {
  decodeOpenShellLabelValue,
  encodeOpenShellLabelValue,
  openShellLaunchCommand,
  parseOpenShellExecEvent,
} from "../../src/agent/sandbox-providers/openshell-grpc-client";

describe("OpenShell gRPC client labels", () => {
  test("encodes Docker image refs as OpenShell-safe label values", () => {
    const encoded = encodeOpenShellLabelValue(
      "ghcr.io/apelogic-ai/burble-nemo-hermes:dev"
    );

    expect(encoded).toMatch(/^[A-Za-z0-9_.-]+$/);
    expect(encoded).not.toContain(":");
    expect(encoded).not.toContain("/");
    expect(decodeOpenShellLabelValue(encoded)).toBe(
      "ghcr.io/apelogic-ai/burble-nemo-hermes:dev"
    );
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
    expect(
      [...python, ...bun].every((part) => !/[\r\n]/.test(part))
    ).toBe(true);
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
