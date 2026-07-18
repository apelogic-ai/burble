export type McpGwProviderToolCatalog = {
  oauthToolNames: readonly string[];
  isProviderToolName: (name: string) => boolean;
};

export const mcpGwGoogleToolCatalog: McpGwProviderToolCatalog = {
  oauthToolNames: ["google_oauth_status", "google_oauth_start"],
  isProviderToolName: (name) =>
    name.startsWith("google_") || name.startsWith("gws_"),
};

export function hasMcpGwProviderDataTools(
  advertisedNames: readonly string[],
  catalog: McpGwProviderToolCatalog,
): boolean {
  const oauthToolNames = new Set(catalog.oauthToolNames);
  return advertisedNames.some(
    (name) => catalog.isProviderToolName(name) && !oauthToolNames.has(name),
  );
}

export function isMcpGwProviderOAuthOnlyCatalog(
  advertisedNames: readonly string[],
  catalog: McpGwProviderToolCatalog,
): boolean {
  return (
    catalog.oauthToolNames.some((name) => advertisedNames.includes(name)) &&
    !hasMcpGwProviderDataTools(advertisedNames, catalog)
  );
}
