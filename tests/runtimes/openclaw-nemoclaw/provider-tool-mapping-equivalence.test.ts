import { describe, expect, test } from "bun:test";

import { providerToolCatalog } from "../../../src/providers/catalog";
import { __openClawBurbleToolMappingTestHooks } from "../../../runtimes/openclaw-nemoclaw/src/burble-tools";
import { __openClawCliProviderToolMappingTestHooks } from "../../../runtimes/openclaw-nemoclaw/src/openclaw-cli";
import type { RunRequest } from "../../../runtimes/openclaw-nemoclaw/src/types";

function buildCatalogManifestRequest(): RunRequest {
  return buildManifestRequest(
    providerToolCatalog.map((tool) => ({
      name: tool.name,
      alias: tool.alias,
      provider: tool.provider,
      enabled: true
    }))
  );
}

function buildManifestRequest(
  tools: NonNullable<
    NonNullable<NonNullable<RunRequest["runtime"]>["manifest"]>["tools"]
  >
): RunRequest {
  return {
    runId: "run_mapping_equivalence",
    runtime: {
      id: "rt_mapping_equivalence",
      manifest: {
        version: "test",
        policyHash: "policy",
        skills: [],
        memory: {
          userMemoryEnabled: false,
          workspaceMemoryEnabled: false,
          jobMemoryEnabled: false
        },
        tools
      }
    },
    input: {
      text: "test",
      connections: {
        github: { connected: false }
      }
    }
  };
}

describe("OpenClaw provider tool mapping equivalence", () => {
  test("manifest mappings match the provider tool catalog for every catalog tool", () => {
    const request = buildCatalogManifestRequest();

    for (const tool of providerToolCatalog) {
      expect(
        __openClawBurbleToolMappingTestHooks.manifestToolNameToMcpToolName(
          tool.name,
          request
        )
      ).toBe(tool.name);
      expect(
        __openClawBurbleToolMappingTestHooks.manifestToolNameToMcpToolName(
          tool.alias,
          request
        )
      ).toBe(tool.name);
      expect(
        __openClawBurbleToolMappingTestHooks.toMcpToolName(tool.name, request)
      ).toBe(tool.name);
      expect(
        __openClawBurbleToolMappingTestHooks.toMcpToolName(tool.alias, request)
      ).toBe(tool.name);
      expect(
        __openClawCliProviderToolMappingTestHooks.manifestMcpToolNameToBurbleToolName(
          tool.name,
          request
        )
      ).toBe(tool.alias);
      expect(
        __openClawCliProviderToolMappingTestHooks.mcpToolNameToBurbleToolName(
          tool.name,
          request
        )
      ).toBe(tool.alias);
    }
  });

  test("provider tool aliases declared for compatibility resolve only when selected in the manifest", () => {
    const appendTool = providerToolCatalog.find(
      (tool) => tool.name === "google_append_to_drive_text_file"
    );
    expect(appendTool).toBeDefined();
    const request = buildManifestRequest([
      {
        name: appendTool!.name,
        alias: "google.appendToDriveTextFile",
        provider: appendTool!.provider,
        enabled: true
      }
    ]);

    expect(
      __openClawBurbleToolMappingTestHooks.toMcpToolName(
        "google.appendToDriveTextFile",
        request
      )
    ).toBe("google_append_to_drive_text_file");
    expect(
      __openClawCliProviderToolMappingTestHooks.mcpToolNameToBurbleToolName(
        "google_append_to_drive_text_file",
        request
      )
    ).toBe("google.appendToDriveTextFile");
  });

  test("provider tools absent or disabled in the manifest do not fall back to legacy maps", () => {
    const disabledRequest = buildManifestRequest([
      {
        name: "github_get_authenticated_user",
        alias: "github.getAuthenticatedUser",
        provider: "github",
        enabled: false
      }
    ]);
    const absentRequest = buildManifestRequest([]);

    expect(() =>
      __openClawBurbleToolMappingTestHooks.toMcpToolName(
        "github.getAuthenticatedUser",
        disabledRequest
      )
    ).toThrow("Unsupported Burble MCP tool: github.getAuthenticatedUser");
    expect(
      __openClawCliProviderToolMappingTestHooks.mcpToolNameToBurbleToolName(
        "github_get_authenticated_user",
        disabledRequest
      )
    ).toBeNull();
    expect(() =>
      __openClawBurbleToolMappingTestHooks.toMcpToolName(
        "github.getAuthenticatedUser",
        absentRequest
      )
    ).toThrow("Unsupported Burble MCP tool: github.getAuthenticatedUser");
    expect(
      __openClawCliProviderToolMappingTestHooks.mcpToolNameToBurbleToolName(
        "github_get_authenticated_user",
        absentRequest
      )
    ).toBeNull();
  });
});
