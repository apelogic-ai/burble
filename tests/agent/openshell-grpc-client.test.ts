import { describe, expect, test } from "bun:test";
import {
  decodeOpenShellLabelValue,
  encodeOpenShellLabelValue,
  parseOpenShellExecEvent,
  shellBackgroundCommand
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
  test("generates shell syntax that can background the runtime command", async () => {
    const command = shellBackgroundCommand(["python", "/runtime/entrypoint.py"]);

    expect(command).not.toContain("&;");
    expect(command).not.toMatch(/[\r\n]/);
    expect(command).not.toContain("/dev/null");
    expect(command).toContain("& :; pid=$!");
    expect(command).toContain("exec </tmp/burble-runtime.stdin");
    expect(
      Bun.spawnSync(["sh", "-n", "-c", command], {
        stdout: "pipe",
        stderr: "pipe"
      }).exitCode
    ).toBe(0);
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
