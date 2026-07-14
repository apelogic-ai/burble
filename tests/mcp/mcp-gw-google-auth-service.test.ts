import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { createMcpIdentityIssuer } from "../../src/mcp-identity";
import { createMcpGwGoogleAuthService } from "../../src/mcp/mcp-gw-google-auth-service";

describe("MCP-GW Google auth service", () => {
  test("mints a fresh trusted user assertion for every auth operation", async () => {
    const issuer = createMcpIdentityIssuer({
      issuer: "https://burble.example.test/mcp-identity",
      keyPair: generateKeyPairSync("rsa", { modulusLength: 2048 }),
      randomId: (() => {
        let id = 0;
        return () => `assertion-${++id}`;
      })(),
    });
    const assertions: string[] = [];
    const service = createMcpGwGoogleAuthService({
      mcpUrl: "https://mcp-gw.example.test/mcp",
      audience: "https://mcp-gw.example.test/mcp",
      issuer,
      getSlackEmail: async (slackUserId) => {
        expect(slackUserId).toBe("U123");
        return "leo@example.test";
      },
      fetch: async (url, init) => {
        const token = new Headers(init?.headers)
          .get("authorization")
          ?.replace(/^Bearer /, "");
        expect(token).toBeString();
        assertions.push(String(token));
        const claims = issuer.verifyUserAssertion({
          token: String(token),
          audience: "https://mcp-gw.example.test/mcp",
        });
        expect(claims).toMatchObject({
          sub: "T123:U123",
          email: "leo@example.test",
          workspace_id: "T123",
        });

        if (String(url).endsWith("/start")) {
          return Response.json({
            authorizationUrl:
              "https://accounts.google.com/o/oauth2/v2/auth?state=state-1",
          });
        }
        if (String(url).endsWith("/status")) {
          return Response.json({ connected: true, email: "leo@example.test" });
        }
        return new Response(null, { status: 204 });
      },
    });
    const principal = { workspaceId: "T123", slackUserId: "U123" };

    await service.start(principal);
    await service.status(principal);
    await service.disconnect(principal);

    expect(assertions).toHaveLength(3);
    expect(new Set(assertions).size).toBe(3);
  });
});
