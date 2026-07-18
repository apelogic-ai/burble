import { describe, expect, test } from "bun:test";
import { createMcpGwConnectionStatusResolver } from "../../src/mcp/mcp-gw-connection-status";

const principal = { workspaceId: "T123", slackUserId: "U123" };

describe("MCP-GW runtime connection status", () => {
  test("resolves provider-owned status and treats missing scopes as disconnected", async () => {
    const resolve = createMcpGwConnectionStatusResolver({
      github: {
        status: async (input) => {
          expect(input).toEqual(principal);
          return {
            connected: true,
            email: "code@example.com",
            scopesRequired: ["repo"],
            scopesGranted: ["repo"],
            missingScopes: [],
          };
        },
      },
      google: {
        status: async () => ({
          connected: true,
          email: "workspace@example.com",
          scopesRequired: ["drive", "docs"],
          scopesGranted: ["drive"],
          missingScopes: ["docs"],
        }),
      },
    });

    await expect(resolve(principal)).resolves.toEqual({
      github: { connected: true, email: "code@example.com" },
      google: { connected: false, email: "workspace@example.com" },
    });
  });

  test("keeps one provider status failure from hiding another provider", async () => {
    const warnings: string[] = [];
    const resolve = createMcpGwConnectionStatusResolver({
      github: {
        status: async () => {
          throw new Error("status unavailable");
        },
      },
      google: {
        status: async () => ({
          connected: true,
          scopesRequired: [],
          scopesGranted: [],
          missingScopes: [],
        }),
      },
      logWarn: (message) => warnings.push(message),
    });

    await expect(resolve(principal)).resolves.toEqual({
      github: { connected: false },
      google: { connected: true },
    });
    expect(warnings).toEqual([
      "Could not resolve MCP-GW github status: status unavailable",
    ]);
  });
});
