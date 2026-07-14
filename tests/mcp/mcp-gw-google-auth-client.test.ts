import { describe, expect, test } from "bun:test";
import {
  disconnectMcpGwGoogleAuth,
  getMcpGwGoogleAuthStatus,
  McpGwGoogleAuthError,
  startMcpGwGoogleAuth,
} from "../../src/mcp/mcp-gw-google-auth-client";

describe("MCP-GW Google auth client", () => {
  test("starts Google consent with the Burble bearer assertion", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const result = await startMcpGwGoogleAuth(
      {
        mcpUrl: "https://mcp-gw.example.test/mcp",
        bearerToken: "burble-assertion",
        fetch: async (url, init) => {
          requests.push({ url: String(url), init });
          return Response.json({
            authorizationUrl:
              "https://accounts.google.com/o/oauth2/v2/auth?state=state-1",
          });
        },
      },
      { redirectAfter: "https://burble.example.test/google/connected" },
    );

    expect(result).toEqual({
      authorizationUrl:
        "https://accounts.google.com/o/oauth2/v2/auth?state=state-1",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "https://mcp-gw.example.test/oauth/google/start",
    );
    expect(requests[0]?.init?.method).toBe("POST");
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe(
      "Bearer burble-assertion",
    );
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      redirectAfter: "https://burble.example.test/google/connected",
    });
  });

  test("reads authoritative MCP-GW connection and scope status", async () => {
    const result = await getMcpGwGoogleAuthStatus({
      mcpUrl: "https://mcp-gw.example.test/mcp/",
      bearerToken: "burble-assertion",
      fetch: async (url, init) => {
        expect(String(url)).toBe(
          "https://mcp-gw.example.test/oauth/google/status",
        );
        expect(init?.method).toBe("GET");
        return Response.json({
          connected: false,
          email: "leo@example.test",
          scopesRequired: ["drive", "gmail"],
          scopesGranted: ["drive"],
          missingScopes: ["gmail"],
        });
      },
    });

    expect(result).toEqual({
      connected: false,
      email: "leo@example.test",
      scopesRequired: ["drive", "gmail"],
      scopesGranted: ["drive"],
      missingScopes: ["gmail"],
    });
  });

  test("disconnects the asserted MCP-GW principal", async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    await disconnectMcpGwGoogleAuth({
      mcpUrl: "https://mcp-gw.example.test/mcp",
      bearerToken: "burble-assertion",
      fetch: async (url, init) => {
        request = { url: String(url), init };
        return new Response(null, { status: 204 });
      },
    });

    expect(request?.url).toBe(
      "https://mcp-gw.example.test/oauth/google/disconnect",
    );
    expect(request?.init?.method).toBe("POST");
  });

  test("rejects an insecure authorization URL from MCP-GW", async () => {
    await expect(
      startMcpGwGoogleAuth({
        mcpUrl: "https://mcp-gw.example.test/mcp",
        bearerToken: "burble-assertion",
        fetch: async () =>
          Response.json({ authorizationUrl: "http://accounts.google.com/auth" }),
      }),
    ).rejects.toThrow("secure Google authorization URL");
  });

  test("reports bounded upstream failures without leaking the response body", async () => {
    await expect(
      getMcpGwGoogleAuthStatus({
        mcpUrl: "https://mcp-gw.example.test/mcp",
        bearerToken: "burble-assertion",
        fetch: async () =>
          new Response('{"secret":"do-not-log"}', {
            status: 503,
            headers: { "content-type": "application/json" },
          }),
      }),
    ).rejects.toEqual(
      new McpGwGoogleAuthError(
        "MCP-GW Google auth status request failed with HTTP 503",
        503,
      ),
    );
  });

  test("aborts a stalled MCP-GW auth request", async () => {
    const startedAt = Date.now();
    await expect(
      getMcpGwGoogleAuthStatus({
        mcpUrl: "https://mcp-gw.example.test/mcp",
        bearerToken: "burble-assertion",
        requestTimeoutMs: 10,
        fetch: async (_url, init) =>
          await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(init.signal?.reason ?? new Error("aborted"));
            });
          }),
      }),
    ).rejects.toThrow("timed out after 10ms");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});
