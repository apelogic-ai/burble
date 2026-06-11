import { describe, expect, test } from "bun:test";

import { providerToolCatalog } from "../../../src/providers/catalog";
import { __openClawBurbleToolMappingTestHooks } from "../../../runtimes/openclaw-nemoclaw/src/burble-tools";
import { __openClawCliProviderToolMappingTestHooks } from "../../../runtimes/openclaw-nemoclaw/src/openclaw-cli";
import type { RunRequest } from "../../../runtimes/openclaw-nemoclaw/src/types";

function buildCatalogManifestRequest(): RunRequest {
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
        tools: providerToolCatalog.map((tool) => ({
          name: tool.name,
          alias: tool.alias,
          provider: tool.provider,
          enabled: true
        }))
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
  test("manifest mappings match the legacy OpenClaw mappings for every catalog tool", () => {
    const request = buildCatalogManifestRequest();

    for (const tool of providerToolCatalog) {
      expect(
        __openClawBurbleToolMappingTestHooks.manifestToolNameToMcpToolName(
          tool.name,
          request
        )
      ).toBe(
        __openClawBurbleToolMappingTestHooks.legacyBurbleToolNameToMcpToolName(
          tool.name
        )
      );
      expect(
        __openClawBurbleToolMappingTestHooks.manifestToolNameToMcpToolName(
          tool.alias,
          request
        )
      ).toBe(
        __openClawBurbleToolMappingTestHooks.legacyBurbleToolNameToMcpToolName(
          tool.alias
        )
      );
      expect(
        __openClawCliProviderToolMappingTestHooks.manifestMcpToolNameToBurbleToolName(
          tool.name,
          request
        )
      ).toBe(
        __openClawCliProviderToolMappingTestHooks.legacyMcpToolNameToBurbleToolName(
          tool.name
        )
      );
    }
  });

  test("legacy OpenClaw mappings contain no tools outside the provider catalog", () => {
    const catalogNames = new Set(providerToolCatalog.map((tool) => tool.name));
    const catalogAliases = new Set(
      providerToolCatalog.flatMap((tool) => [
        tool.alias,
        ...(tool.aliases ?? [])
      ])
    );

    for (const legacyInput of __openClawBurbleToolMappingTestHooks.legacyBurbleToolNameInputs()) {
      if (legacyInput.includes(".")) {
        expect(catalogAliases.has(legacyInput), legacyInput).toBe(true);
      } else {
        expect(catalogNames.has(legacyInput), legacyInput).toBe(true);
      }
    }

    for (const legacyMcpName of __openClawCliProviderToolMappingTestHooks.legacyMcpToolNames()) {
      expect(catalogNames.has(legacyMcpName), legacyMcpName).toBe(true);
    }
  });
});
