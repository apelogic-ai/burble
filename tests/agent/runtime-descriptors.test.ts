import { describe, expect, test } from "bun:test";
import {
  defaultRuntimeImageForEngine,
  isKnownDefaultRuntimeImage,
  runtimeCompatibilityFamily,
  runtimeConfigFileName,
  runtimeDescriptor,
  runtimeEngines,
  runtimeHealthCheckAttempts
} from "../../src/agent/runtime-descriptors";

describe("runtime descriptors", () => {
  test("enumerates supported runtime engines in one registry", () => {
    expect(runtimeEngines).toEqual([
      "deterministic",
      "openclaw",
      "openclaw-gateway",
      "burble-direct",
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

  test("exposes runtime config shape and readiness policy", () => {
    expect(runtimeConfigFileName("burble-direct")).toBe("openclaw.json");
    expect(runtimeConfigFileName("burble-native")).toBe("burble-native.json");
    expect(runtimeConfigFileName("hermes")).toBe("hermes.json");
    expect(runtimeHealthCheckAttempts("openclaw")).toBe(90);
    expect(runtimeHealthCheckAttempts("openclaw-gateway")).toBe(90);
    expect(runtimeHealthCheckAttempts("hermes")).toBe(30);
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
      toolBridgeModes: ["tool_gateway", "mcp"],
      usageReporting: "exact",
      multimodalInput: false
    });
    expect(runtimeDescriptor("burble-native").capabilities).toMatchObject({
      runtimeType: "burble-native",
      toolBridgeModes: ["tool_gateway"],
      toolCalls: false,
      usageReporting: "exact",
      nativeScheduler: false,
      scheduledProviderCalls: false,
      multimodalInput: false,
      memory: false,
      durableWorkflowState: false,
      attachments: false
    });
  });

  test("centralizes runtime compatibility families", () => {
    expect(runtimeCompatibilityFamily("openclaw")).toBe("openclaw");
    expect(runtimeCompatibilityFamily("openclaw-gateway")).toBe("openclaw");
    expect(runtimeCompatibilityFamily("burble-direct")).toBe("burble-direct");
    expect(runtimeCompatibilityFamily("burble-native")).toBe("burble-native");
    expect(runtimeCompatibilityFamily("hermes")).toBe("hermes");
    expect(runtimeCompatibilityFamily("future-engine")).toBe("future-engine");
  });
});
