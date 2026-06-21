import { describe, expect, test } from "bun:test";
import {
  decodeOpenShellLabelValue,
  encodeOpenShellLabelValue
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
