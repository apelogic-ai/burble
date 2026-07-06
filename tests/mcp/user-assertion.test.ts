import { describe, expect, test } from "bun:test";
import { createMcpIdentityIssuer } from "../../src/mcp-identity";
import { resolveMcpUserAssertion } from "../../src/mcp/user-assertion";

describe("resolveMcpUserAssertion", () => {
  test("mints a short-lived assertion for a Slack user", async () => {
    const issuer = createMcpIdentityIssuer({
      issuer: "https://burble.example.com/mcp-identity",
      now: () => new Date("2026-07-06T12:00:00.000Z"),
      randomId: () => "assertion-1"
    });

    const result = await resolveMcpUserAssertion({
      workspaceId: "T123",
      slackUserId: "U123",
      audience: "https://18.210.100.44.nip.io/mcp",
      issuer,
      ttlSeconds: 300,
      getSlackEmail: async (userId) => {
        expect(userId).toBe("U123");
        return "person@example.com";
      }
    });

    expect(result).toMatchObject({
      subject: "T123:U123",
      email: "person@example.com"
    });
    expect(
      issuer.verifyUserAssertion({
        token: result.token,
        audience: "https://18.210.100.44.nip.io/mcp",
        now: new Date("2026-07-06T12:00:30.000Z")
      })
    ).toMatchObject({
      iss: "https://burble.example.com/mcp-identity",
      aud: "https://18.210.100.44.nip.io/mcp",
      sub: "T123:U123",
      email: "person@example.com",
      workspace_id: "T123",
      exp: 1783339500,
      jti: "assertion-1"
    });
  });

  test("fails clearly when Slack has no user email", async () => {
    const issuer = createMcpIdentityIssuer({
      issuer: "https://burble.example.com/mcp-identity"
    });

    await expect(
      resolveMcpUserAssertion({
        workspaceId: "T123",
        slackUserId: "U123",
        audience: "https://18.210.100.44.nip.io/mcp",
        issuer,
        getSlackEmail: async () => ""
      })
    ).rejects.toThrow(
      "Slack profile email is unavailable. Add users:read.email and reinstall the Slack app."
    );
  });
});
