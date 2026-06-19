import { describe, expect, test } from "bun:test";
import {
  compileOpenShellSandboxPolicy
} from "../../src/agent/sandbox-providers/openshell-policy";

describe("OpenShell sandbox policy compiler", () => {
  test("compiles the neutral sandbox policy into deterministic OpenShell config", () => {
    const compiled = compileOpenShellSandboxPolicy({
      policy: {
        network: {
          egress: "allowlist",
          allowedHosts: [
            "GitHub.com",
            "burble-gateway.internal",
            "github.com"
          ]
        },
        filesystem: {
          readOnlyPaths: ["/workspace", "/workspace"],
          readWritePaths: ["/tmp/burble", "/data/openclaw"]
        },
        resources: {
          cpuCount: 2,
          memoryMb: 1024,
          diskMb: 4096
        },
        maxLifetimeMs: 60_000
      },
      credentials: [
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
      ]
    });

    expect(compiled).toEqual({
      version: 1,
      egress: {
        default: "deny",
        allowHosts: ["burble-gateway.internal", "github.com"]
      },
      filesystem: {
        readOnly: ["/workspace"],
        readWrite: ["/data/openclaw", "/tmp/burble"]
      },
      resources: {
        cpuCount: 2,
        memoryMb: 1024,
        diskMb: 4096,
        maxLifetimeMs: 60_000
      },
      providers: [
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
    });
  });

  test("compiles open and denied egress without implicit host allowlists", () => {
    expect(
      compileOpenShellSandboxPolicy({
        policy: { network: { egress: "open" } }
      }).egress
    ).toEqual({ default: "allow", allowHosts: [] });

    expect(
      compileOpenShellSandboxPolicy({
        policy: { network: { egress: "deny" } }
      }).egress
    ).toEqual({ default: "deny", allowHosts: [] });
  });

  test("rejects invalid neutral policy values before they reach OpenShell", () => {
    expect(() =>
      compileOpenShellSandboxPolicy({
        policy: {
          network: { egress: "allowlist", allowedHosts: [" "] }
        }
      })
    ).toThrow("allowedHosts cannot include blank hosts");

    expect(() =>
      compileOpenShellSandboxPolicy({
        policy: {
          network: { egress: "deny" },
          filesystem: { readOnlyPaths: ["relative/path"] }
        }
      })
    ).toThrow("must be absolute");

    expect(() =>
      compileOpenShellSandboxPolicy({
        policy: {
          network: { egress: "deny" },
          resources: { memoryMb: 0 }
        }
      })
    ).toThrow("memoryMb must be a positive integer");
  });
});
