export type McpGwConnectionStatusPrincipal = {
  workspaceId: string;
  slackUserId: string;
};

export type McpGwRuntimeConnectionSummary = {
  connected: boolean;
  email?: string;
};

export type McpGwRuntimeConnectionStatuses = Partial<
  Record<"github" | "google", McpGwRuntimeConnectionSummary>
>;

type ProviderAuthStatus = {
  connected: boolean;
  email?: string;
  missingScopes: string[];
};

type ProviderAuthStatusService = {
  status(
    principal: McpGwConnectionStatusPrincipal,
  ): Promise<ProviderAuthStatus>;
};

export function createMcpGwConnectionStatusResolver(input: {
  github?: ProviderAuthStatusService;
  google?: ProviderAuthStatusService;
  logWarn?: (message: string) => void;
}): (
  principal: McpGwConnectionStatusPrincipal,
) => Promise<McpGwRuntimeConnectionStatuses> {
  return async (principal) => {
    const entries = await Promise.all(
      (["github", "google"] as const).map(async (provider) => {
        const service = input[provider];
        if (!service) {
          return null;
        }
        try {
          const status = await service.status(principal);
          return [
            provider,
            {
              connected:
                status.connected && status.missingScopes.length === 0,
              ...(status.email ? { email: status.email } : {}),
            },
          ] as const;
        } catch (error) {
          input.logWarn?.(
            `Could not resolve MCP-GW ${provider} status: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return [provider, { connected: false }] as const;
        }
      }),
    );

    return Object.fromEntries(
      entries.filter(
        (entry): entry is NonNullable<typeof entry> => Boolean(entry),
      ),
    ) as McpGwRuntimeConnectionStatuses;
  };
}
