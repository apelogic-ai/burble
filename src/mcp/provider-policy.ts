export type ProviderMcpToolPolicy = {
  enabledTools?: ReadonlySet<string>;
};

export function isProviderMcpToolEnabled(
  policy: ProviderMcpToolPolicy | undefined,
  toolName: string
): boolean {
  return !policy?.enabledTools || policy.enabledTools.has(toolName);
}
