import { describe, expect, test } from "bun:test";
import {
  disconnectMcpGwGitHubAuth,
  getMcpGwGitHubAuthStatus,
  McpGwGitHubAuthError,
  startMcpGwGitHubAuth,
} from "../../src/mcp/mcp-gw-github-auth-client";

describe("MCP-GW GitHub auth client", () => {
  test("captures the GitHub consent redirect with the Burble assertion", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const result = await startMcpGwGitHubAuth(
      {
        mcpUrl: "https://mcp-gw.example.test/mcp",
        bearerToken: "burble-assertion",
        fetch: async (url, init) => {
          requests.push({ url: String(url), init });
          return new Response(null, {
            status: 302,
            headers: {
              location:
                "https://github.com/login/oauth/authorize?client_id=client&state=state-1",
            },
          });
        },
      },
      { redirectAfter: "https://burble.example.test/github/connected" },
    );

    expect(result).toEqual({
      authorizationUrl:
        "https://github.com/login/oauth/authorize?client_id=client&state=state-1",
    });
    expect(requests[0]?.url).toBe(
      "https://mcp-gw.example.test/oauth/github/start?redirect_after=https%3A%2F%2Fburble.example.test%2Fgithub%2Fconnected",
    );
    expect(requests[0]?.init?.method).toBe("GET");
    expect(requests[0]?.init?.redirect).toBe("manual");
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe(
      "Bearer burble-assertion",
    );
  });

  test("reads authoritative connection and scope status", async () => {
    const result = await getMcpGwGitHubAuthStatus({
      mcpUrl: "https://mcp-gw.example.test/mcp/",
      bearerToken: "burble-assertion",
      fetch: async (url, init) => {
        expect(String(url)).toBe(
          "https://mcp-gw.example.test/oauth/github/status",
        );
        expect(init?.method).toBe("GET");
        return Response.json({
          connected: false,
          email: "leo@example.test",
          scopesRequired: ["repo", "read:org", "workflow", "notifications"],
          scopesGranted: ["repo", "read:org"],
          missingScopes: ["workflow", "notifications"],
        });
      },
    });

    expect(result).toEqual({
      connected: false,
      email: "leo@example.test",
      scopesRequired: ["repo", "read:org", "workflow", "notifications"],
      scopesGranted: ["repo", "read:org"],
      missingScopes: ["workflow", "notifications"],
    });
  });

  test("disconnects the asserted MCP-GW principal", async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    await disconnectMcpGwGitHubAuth({
      mcpUrl: "https://mcp-gw.example.test/mcp",
      bearerToken: "burble-assertion",
      fetch: async (url, init) => {
        request = { url: String(url), init };
        return new Response(null, { status: 204 });
      },
    });

    expect(request?.url).toBe(
      "https://mcp-gw.example.test/oauth/github/disconnect",
    );
    expect(request?.init?.method).toBe("POST");
  });

  test("rejects redirects outside GitHub authorization", async () => {
    await expect(
      startMcpGwGitHubAuth({
        mcpUrl: "https://mcp-gw.example.test/mcp",
        bearerToken: "burble-assertion",
        fetch: async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://evil.example/auth" },
          }),
      }),
    ).rejects.toThrow("secure GitHub authorization URL");
  });

  test("reports bounded upstream failures without leaking the response", async () => {
    await expect(
      getMcpGwGitHubAuthStatus({
        mcpUrl: "https://mcp-gw.example.test/mcp",
        bearerToken: "burble-assertion",
        fetch: async () => new Response("secret", { status: 503 }),
      }),
    ).rejects.toEqual(
      new McpGwGitHubAuthError(
        "MCP-GW GitHub auth status request failed with HTTP 503",
        503,
      ),
    );
  });
});
