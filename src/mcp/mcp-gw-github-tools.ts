const burbleDiscoveryToolNames = new Set([
  "github_list_mcp_tools",
  "github_call_mcp_tool",
]);
const mcpGwGitHubOAuthToolNames = new Set([
  "github_oauth_status",
  "github_oauth_start",
]);

export function isFederatedGitHubToolName(name: string): boolean {
  return (
    /^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(name) &&
    /(?:^|_)github_[a-z0-9_]+$/.test(name) &&
    !burbleDiscoveryToolNames.has(name)
  );
}

export function resolveMcpGwGitHubToolName(
  canonicalName: string,
  advertisedNames: readonly string[],
): string {
  if (advertisedNames.includes(canonicalName)) {
    return canonicalName;
  }

  const matches = advertisedNames.filter(
    (name) =>
      isFederatedGitHubToolName(name) &&
      name.endsWith(`_${canonicalName}`),
  );
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length > 1) {
    throw new Error(
      `GitHub tool ${canonicalName} has multiple advertised MCP-GW matches: ${matches.join(", ")}.`,
    );
  }
  throw new Error(`GitHub tool ${canonicalName} is not advertised by MCP-GW.`);
}

export function hasMcpGwGitHubProviderTools(
  advertisedNames: readonly string[],
): boolean {
  return advertisedNames.some(
    (name) =>
      isFederatedGitHubToolName(name) &&
      !mcpGwGitHubOAuthToolNames.has(name),
  );
}
