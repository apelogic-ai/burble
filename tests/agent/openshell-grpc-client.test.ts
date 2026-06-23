import { describe, expect, test } from "bun:test";
import {
  compileOpenShellGrpcSandboxPolicy,
  createOpenShellGrpcSandboxClient,
  decodeOpenShellLabelValue,
  encodeOpenShellLabelValue,
  openShellCommandString
} from "../../src/agent/sandbox-providers/openshell-grpc-client";
import { dockerInternalAllowedIps } from "../../src/agent/sandbox-policy";

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

describe("OpenShell workload launch", () => {
  test("formats supervised workload command strings for diagnostics", () => {
    expect(openShellCommandString(["python", "/runtime/entrypoint.py"])).toBe(
      "python /runtime/entrypoint.py"
    );
    expect(openShellCommandString(["bun", "src/index.ts"])).toBe(
      "bun src/index.ts"
    );
  });

  test("rejects gRPC create-time workload launch because OpenShell reserves OPENSHELL_* env", async () => {
    const client = createOpenShellGrpcSandboxClient({
      endpoint: "http://127.0.0.1:65535"
    });

    await expect(
      client.createSandbox({
        principal: { workspaceId: "T123", userId: "U123" },
        runtime: { engine: "hermes", image: "burble-nemo-hermes:dev" },
        labels: {},
        policy: {
          network: { egress: "deny" },
          filesystem: { readOnlyPaths: [], readWritePaths: [] }
        },
        start: {
          argv: ["python", "/runtime/entrypoint.py"],
          env: { BURBLE_RUNTIME_ID: "rt_123" }
        }
      })
    ).rejects.toThrow("use AGENT_RUNTIME_SANDBOX_TRANSPORT=cli");
  });

  test("rejects blank supervised workload commands", () => {
    expect(() => openShellCommandString([])).toThrow("must be non-empty");
    expect(() => openShellCommandString(["bun", ""])).toThrow(
      "must be non-empty"
    );
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

  test("uses valid TLS enum values for egress endpoints", () => {
    const policy = compileOpenShellGrpcSandboxPolicy({
      network: {
        egress: "allowlist",
        allowedHosts: ["api.openai.com", "burble-app:3000"],
        allowedEndpoints: [
          { host: "api.openai.com", tls: true },
          {
            host: "burble-app:3000",
            tls: false,
            allowedIps: dockerInternalAllowedIps
          }
        ]
      },
      filesystem: {
        readOnlyPaths: ["/runtime"],
        readWritePaths: ["/tmp"]
      }
    }) as {
      networkPolicies: {
        burble_runtime: {
          endpoints: Array<{ host: string; tls?: string }>;
        };
      };
    };

    expect(policy.networkPolicies.burble_runtime.endpoints).toContainEqual(
      expect.objectContaining({ host: "api.openai.com" })
    );
    expect(
      policy.networkPolicies.burble_runtime.endpoints.find(
        (endpoint) => endpoint.host === "api.openai.com"
      )?.tls
    ).toBeUndefined();
    expect(policy.networkPolicies.burble_runtime.endpoints).toContainEqual(
      expect.objectContaining({
        host: "burble-app",
        tls: "skip",
        allowed_ips: dockerInternalAllowedIps
      })
    );
  });
});
