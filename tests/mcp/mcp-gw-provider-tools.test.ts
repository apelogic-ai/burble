import { describe, expect, test } from "bun:test";
import {
  hasMcpGwProviderDataTools,
  isMcpGwProviderOAuthOnlyCatalog,
} from "../../src/mcp/mcp-gw-provider-tools";

describe("MCP-GW provider-owned OAuth catalogs", () => {
  const catalog = {
    oauthToolNames: ["example_oauth_status", "example_oauth_start"],
    isProviderToolName: (name: string) => name.startsWith("example_"),
  };

  test("recognizes a helper-only provider catalog", () => {
    const names = [
      "other_search",
      "example_oauth_status",
      "example_oauth_start",
    ];

    expect(isMcpGwProviderOAuthOnlyCatalog(names, catalog)).toBe(true);
    expect(hasMcpGwProviderDataTools(names, catalog)).toBe(false);
  });

  test("recognizes a connected provider data catalog", () => {
    const names = [
      "example_oauth_status",
      "example_oauth_start",
      "example_search",
    ];

    expect(isMcpGwProviderOAuthOnlyCatalog(names, catalog)).toBe(false);
    expect(hasMcpGwProviderDataTools(names, catalog)).toBe(true);
  });

  test("does not infer disconnected state when provider helpers are absent", () => {
    expect(
      isMcpGwProviderOAuthOnlyCatalog(["other_search"], catalog),
    ).toBe(false);
  });
});
