import { describe, expect, test } from "bun:test";
import {
  defaultSandboxStartCommandForEngine,
  defaultRuntimeImageForEngine,
  isKnownDefaultRuntimeImage,
  runtimeCompatibilityFamily,
  runtimeConfigFileName,
  runtimeDescriptor,
  runtimeEngines,
  runtimeHealthCheckAttempts
} from "../../src/agent/runtime-descriptors";

describe("runtime descriptors", () => {
  const bunRuntimeSandboxStartCommand = [
    "sh",
    "-lc",
    "cd /runtime && exec bun src/index.ts"
  ];

  test("enumerates supported runtime engines in one registry", () => {
    expect(runtimeEngines).toEqual([
      "deterministic",
      "openclaw",
      "openclaw-gateway",
      "burble-native",
      "hermes"
    ]);
  });

  test("keeps canonical default images and known fallback images per engine", () => {
    expect(defaultRuntimeImageForEngine("openclaw")).toBe(
      "burble-openclaw-nemoclaw-openclaw-cli:dev"
    );
    expect(defaultRuntimeImageForEngine("openclaw-gateway")).toBe(
      "burble-openclaw-nemoclaw-openclaw-cli:dev"
    );
    expect(defaultRuntimeImageForEngine("hermes")).toBe(
      "burble-nemo-hermes:dev"
    );
    expect(defaultRuntimeImageForEngine("burble-native")).toBe(
      "burble-native-runtime:dev"
    );
    expect(
      isKnownDefaultRuntimeImage(
        "openclaw",
        "burble-openclaw-nemoclaw:dev"
      )
    ).toBe(true);
    expect(
      isKnownDefaultRuntimeImage("hermes", "burble-openclaw-nemoclaw:dev")
    ).toBe(false);
  });

  test("keeps sandbox start commands with the engine descriptors", () => {
    expect(defaultSandboxStartCommandForEngine("hermes")).toEqual([
      "python",
      "/runtime/entrypoint.py"
    ]);
    expect(defaultSandboxStartCommandForEngine("openclaw")).toEqual([
      ...bunRuntimeSandboxStartCommand
    ]);
    expect(defaultSandboxStartCommandForEngine("openclaw-gateway")).toEqual([
      ...bunRuntimeSandboxStartCommand
    ]);
    expect(defaultSandboxStartCommandForEngine("burble-native")).toEqual([
      ...bunRuntimeSandboxStartCommand
    ]);
  });

  test("exposes runtime config shape and readiness policy", () => {
    expect(runtimeConfigFileName("burble-native")).toBe("burble-native.json");
    expect(runtimeConfigFileName("hermes")).toBe("hermes.json");
    expect(runtimeHealthCheckAttempts("openclaw")).toBe(90);
    expect(runtimeHealthCheckAttempts("openclaw-gateway")).toBe(90);
    expect(runtimeHealthCheckAttempts("hermes")).toBe(30);
    expect(runtimeDescriptor("openclaw").container.sandboxReadOnlyPaths).toEqual([
      "/"
    ]);
    expect(runtimeDescriptor("openclaw").container.sandboxReadWritePaths).toEqual([
      "/dev/pts"
    ]);
  });

  test("exposes known capability manifests for policy selection", () => {
    expect(runtimeDescriptor("openclaw").capabilities).toMatchObject({
      runtimeType: "openclaw",
      toolBridgeModes: ["tool_gateway", "mcp"],
      usageReporting: "exact",
      multimodalInput: true
    });
    expect(runtimeDescriptor("deterministic").capabilities).toMatchObject({
      runtimeType: "deterministic",
      usageReporting: "none"
    });
    expect(runtimeDescriptor("hermes").capabilities).toMatchObject({
      runtimeType: "hermes",
      transports: ["http", "sse", "ndjson", "websocket"],
      toolBridgeModes: ["tool_gateway", "mcp"],
      usageReporting: "exact",
      multimodalInput: false,
      attachments: true
    });
    expect(runtimeDescriptor("burble-native").capabilities).toMatchObject({
      runtimeType: "burble-native",
      toolBridgeModes: ["tool_gateway"],
      toolCalls: true,
      usageReporting: "exact",
      nativeScheduler: false,
      scheduledProviderCalls: true,
      multimodalInput: false,
      memory: false,
      durableWorkflowState: false,
      attachments: true
    });
  });

  test("centralizes runtime compatibility families", () => {
    expect(runtimeCompatibilityFamily("openclaw")).toBe("openclaw");
    expect(runtimeCompatibilityFamily("openclaw-gateway")).toBe("openclaw");
    expect(runtimeCompatibilityFamily("burble-native")).toBe("burble-native");
    expect(runtimeCompatibilityFamily("hermes")).toBe("hermes");
    expect(runtimeCompatibilityFamily("future-engine")).toBe("future-engine");
  });
});
