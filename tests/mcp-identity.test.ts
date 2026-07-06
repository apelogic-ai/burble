import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpIdentityIssuer } from "../src/mcp-identity";
import { createRuntimeJwtIssuer } from "../src/runtime-jwt";

describe("createMcpIdentityIssuer", () => {
  test("issues user assertions with the MCP-GW identity contract", () => {
    const issuer = createMcpIdentityIssuer({
      issuer: "https://burble.example.com/mcp-identity",
      now: () => new Date("2026-07-06T12:00:00.000Z")
    });

    const token = issuer.issueUserAssertion({
      audience: "https://18.210.100.44.nip.io/mcp",
      subject: "T123:U123",
      workspaceId: "T123",
      email: "person@example.com",
      ttlSeconds: 300
    });
    const claims = issuer.verifyUserAssertion({
      token,
      audience: "https://18.210.100.44.nip.io/mcp",
      now: new Date("2026-07-06T12:02:00.000Z")
    });

    expect(issuer.jwks().keys[0]).toMatchObject({
      kty: "RSA",
      alg: "RS256",
      use: "sig",
      kid: expect.any(String)
    });
    expect(issuer.jwks().keys[0]).not.toHaveProperty("d");
    expect(claims).toMatchObject({
      iss: "https://burble.example.com/mcp-identity",
      aud: "https://18.210.100.44.nip.io/mcp",
      sub: "T123:U123",
      email: "person@example.com",
      workspace_id: "T123",
      iat: 1783339200,
      nbf: 1783339200,
      exp: 1783339500,
      jti: expect.any(String)
    });
  });

  test("rejects expired assertions and the wrong audience", () => {
    const issuer = createMcpIdentityIssuer({
      issuer: "https://burble.example.com/mcp-identity",
      now: () => new Date("2026-07-06T12:00:00.000Z")
    });
    const token = issuer.issueUserAssertion({
      audience: "https://18.210.100.44.nip.io/mcp",
      subject: "T123:U123",
      workspaceId: "T123",
      email: "person@example.com",
      ttlSeconds: 1
    });

    expect(
      issuer.verifyUserAssertion({
        token,
        audience: "https://other.example.com/mcp",
        now: new Date("2026-07-06T12:00:00.000Z")
      })
    ).toBeNull();
    expect(
      issuer.verifyUserAssertion({
        token,
        audience: "https://18.210.100.44.nip.io/mcp",
        now: new Date("2026-07-06T12:00:02.000Z")
      })
    ).toBeNull();
  });

  test("reuses a persistent private key across issuer restarts", () => {
    const privateKeyPath = join(
      mkdtempSync(join(tmpdir(), "burble-mcp-identity-")),
      "mcp-identity-private.pem"
    );
    const first = createMcpIdentityIssuer({
      issuer: "https://burble.example.com/mcp-identity",
      privateKeyPath,
      now: () => new Date("2026-07-06T12:00:00.000Z")
    });
    const token = first.issueUserAssertion({
      audience: "https://18.210.100.44.nip.io/mcp",
      subject: "T123:U123",
      workspaceId: "T123",
      email: "person@example.com"
    });
    const second = createMcpIdentityIssuer({
      issuer: "https://burble.example.com/mcp-identity",
      privateKeyPath,
      now: () => new Date("2026-07-06T12:00:30.000Z")
    });

    expect(readFileSync(privateKeyPath, "utf8")).toContain("PRIVATE KEY");
    expect(second.jwks().keys[0]?.kid).toBe(first.jwks().keys[0]?.kid);
    expect(
      second.verifyUserAssertion({
        token,
        audience: "https://18.210.100.44.nip.io/mcp",
        now: new Date("2026-07-06T12:00:30.000Z")
      })
    ).toMatchObject({
      sub: "T123:U123",
      email: "person@example.com",
      workspace_id: "T123"
    });
  });

  test("does not accept runtime JWTs or share runtime JWT key material", () => {
    const runtimeIssuer = createRuntimeJwtIssuer({
      issuer: "https://burble.example.com"
    });
    const identityIssuer = createMcpIdentityIssuer({
      issuer: "https://burble.example.com/mcp-identity"
    });
    const runtimeToken = runtimeIssuer.issueRuntimeJwt({
      audience: "https://18.210.100.44.nip.io/mcp",
      runtimeId: "rt_u123",
      workspaceId: "T123",
      slackUserId: "U123"
    });
    const identityToken = identityIssuer.issueUserAssertion({
      audience: "https://18.210.100.44.nip.io/mcp",
      subject: "T123:U123",
      workspaceId: "T123",
      email: "person@example.com"
    });

    expect(
      identityIssuer.verifyUserAssertion({
        token: runtimeToken,
        audience: "https://18.210.100.44.nip.io/mcp"
      })
    ).toBeNull();
    expect(
      runtimeIssuer.verifyRuntimeJwt({
        token: identityToken,
        audience: "https://18.210.100.44.nip.io/mcp"
      })
    ).toBeNull();
    expect(identityIssuer.jwks().keys[0]?.kid).not.toBe(
      runtimeIssuer.jwks().keys[0]?.kid
    );
  });
});
