import { describe, expect, test } from "bun:test";
import { readConfig } from "../../src/config";
import {
  buildBrokeredRuntimeSandboxPolicy,
  buildRuntimeSandboxPolicyFromConfig,
  dockerInternalAllowedIps,
  openShellHostAllowedIps,
  sandboxAllowedHostsFromUrls
} from "../../src/agent/sandbox-policy";
import {
  compileOpenShellProviderBindings,
  compileOpenShellSandboxPolicy
} from "../../src/agent/sandbox-providers/openshell-policy";

describe("brokered runtime sandbox policy", () => {
  test("derives the neutral egress allowlist from gateway URLs", () => {
    const policy = buildBrokeredRuntimeSandboxPolicy({
      toolGatewayUrl: "http://burble-app:3000/internal/tools",
      mcpGatewayUrl: "http://agentgateway:3000/mcp/",
      modelProviderUrls: ["https://api.openai.com/v1", "https://api.openai.com"],
      filesystem: {
        readOnlyPaths: ["/data/runtime/config"],
        readWritePaths: ["/data/runtime/workspace"]
      },
      resources: {
        cpuCount: 2,
        memoryMb: 2048
      },
      maxLifetimeMs: 86_400_000
    });

    expect(policy).toEqual({
      network: {
        egress: "allowlist",
        allowedHosts: [
          "agentgateway:3000",
          "api.openai.com",
          "burble-app:3000"
        ],
        allowedEndpoints: [
          {
            host: "agentgateway:3000",
            tls: false,
            allowedIps: dockerInternalAllowedIps
          },
          { host: "api.openai.com", tls: true },
          {
            host: "burble-app:3000",
            tls: false,
            allowedIps: dockerInternalAllowedIps
          }
        ]
      },
      filesystem: {
        readOnlyPaths: ["/data/runtime/config"],
        readWritePaths: ["/data/runtime/workspace"]
      },
      resources: {
        cpuCount: 2,
        memoryMb: 2048
      },
      maxLifetimeMs: 86_400_000
    });

    expect(compileOpenShellSandboxPolicy({ policy }).egress).toEqual({
      default: "deny",
      allowHosts: ["agentgateway:3000", "api.openai.com", "burble-app:3000"]
    });
  });

  test("normalizes and validates URL-derived sandbox hosts", () => {
    expect(
      sandboxAllowedHostsFromUrls([
        " HTTP://Burble-App:3000/internal/tools ",
        null,
        undefined,
        "",
        "https://api.openai.com/v1",
        "https://API.OPENAI.com/",
        "wss://connect.browserbase.com/session",
        "ws://Chrome.Example.Net:9222/devtools/browser/1"
      ])
    ).toEqual([
      "api.openai.com",
      "burble-app:3000",
      "chrome.example.net:9222",
      "connect.browserbase.com"
    ]);

    expect(() => sandboxAllowedHostsFromUrls(["file:///etc/passwd"])).toThrow(
      "must use http, https, ws, or wss"
    );
    expect(() => sandboxAllowedHostsFromUrls(["api.openai.com"])).toThrow(
      "must be an absolute http/https/ws/wss URL"
    );
  });

  test("uses the OpenShell host veth IP for host-routed gateways", () => {
    const policy = buildBrokeredRuntimeSandboxPolicy({
      toolGatewayUrl: "http://host.openshell.internal:3000/internal/tools",
      mcpGatewayUrl: "http://host.openshell.internal:3001/mcp",
      modelProviderUrls: ["http://host.openshell.internal:4000/v1"]
    });

    expect(policy.network.allowedEndpoints).toEqual([
      {
        host: "host.openshell.internal:3000",
        tls: false,
        allowedIps: openShellHostAllowedIps
      },
      {
        host: "host.openshell.internal:3001",
        tls: false,
        allowedIps: openShellHostAllowedIps
      },
      {
        host: "host.openshell.internal:4000",
        tls: false,
        allowedIps: openShellHostAllowedIps
      }
    ]);
  });

  test("requires the model provider URL before building brokered egress", () => {
    expect(() =>
      buildBrokeredRuntimeSandboxPolicy({
        toolGatewayUrl: "http://burble-app:3000/internal/tools",
        modelProviderUrls: []
      })
    ).toThrow("modelProviderUrls must include at least one URL");

    expect(() =>
      buildBrokeredRuntimeSandboxPolicy({
        toolGatewayUrl: "http://burble-app:3000/internal/tools",
        modelProviderUrls: [" "]
      })
    ).toThrow("modelProviderUrls must include at least one URL");
  });

  test("derives brokered egress from runtime gateway configuration", () => {
    const config = readConfig({
      ...validConfigEnv(),
      AGENT_RUNTIME_FACTORY: "docker",
      AGENT_RUNTIME_TOOL_GATEWAY_URL: "http://burble-app:3000/internal/tools",
      AGENT_RUNTIME_MCP_GATEWAY_URL: "http://agentgateway:3000/mcp/"
    });

    const policy = buildRuntimeSandboxPolicyFromConfig(config, {
      modelProviderUrls: ["https://api.openai.com/v1"]
    });

    expect(policy.network).toEqual({
      egress: "allowlist",
      allowedHosts: [
        "agentgateway:3000",
        "api.openai.com",
        "burble-app:3000"
      ],
      allowedEndpoints: [
        {
          host: "agentgateway:3000",
          tls: false,
          allowedIps: dockerInternalAllowedIps
        },
        { host: "api.openai.com", tls: true },
        {
          host: "burble-app:3000",
          tls: false,
          allowedIps: dockerInternalAllowedIps
        }
      ]
    });
    expect(compileOpenShellSandboxPolicy({ policy }).egress).toEqual({
      default: "deny",
      allowHosts: ["agentgateway:3000", "api.openai.com", "burble-app:3000"]
    });
  });
});

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

  test("compiles neutral credential bindings into OpenShell provider config", () => {
    expect(
      compileOpenShellProviderBindings([
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
      ])
    ).toEqual([
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
    ]);
  });
});

function validConfigEnv(): Record<string, string> {
  return {
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_APP_TOKEN: "xapp-test",
    GITHUB_CLIENT_ID: "github-client",
    GITHUB_CLIENT_SECRET: "github-secret",
    BASE_URL: "https://burble.example",
    INTERNAL_API_TOKEN: "internal-token"
  };
}
