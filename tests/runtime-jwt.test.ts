import { describe, expect, test } from "bun:test";
import { createRuntimeJwtIssuer } from "../src/runtime-jwt";

describe("createRuntimeJwtIssuer", () => {
  test("issues principal-scoped runtime JWTs and exposes a JWKS", () => {
    const issuer = createRuntimeJwtIssuer({
      issuer: "http://burble-app:3000",
      now: () => new Date("2026-05-22T12:00:00.000Z")
    });

    const token = issuer.issueRuntimeJwt({
      audience: "http://agentgateway:3000/mcp",
      runtimeId: "rt_u123",
      workspaceId: "T123",
      slackUserId: "U123",
      ttlSeconds: 60
    });
    const claims = issuer.verifyRuntimeJwt({
      token,
      audience: "http://agentgateway:3000/mcp",
      now: new Date("2026-05-22T12:00:30.000Z")
    });

    expect(issuer.jwks().keys[0]).toMatchObject({
      kty: "RSA",
      alg: "RS256",
      use: "sig",
      kid: expect.any(String)
    });
    expect(issuer.jwks().keys[0]).not.toHaveProperty("d");
    expect(claims).toMatchObject({
      iss: "http://burble-app:3000",
      aud: "http://agentgateway:3000/mcp",
      sub: "T123:U123",
      runtime_id: "rt_u123",
      workspace_id: "T123",
      slack_user_id: "U123"
    });
  });

  test("rejects expired tokens and the wrong audience", () => {
    const issuer = createRuntimeJwtIssuer({
      issuer: "http://burble-app:3000",
      now: () => new Date("2026-05-22T12:00:00.000Z")
    });
    const token = issuer.issueRuntimeJwt({
      audience: "http://agentgateway:3000/mcp",
      runtimeId: "rt_u123",
      workspaceId: "T123",
      slackUserId: "U123",
      ttlSeconds: 1
    });

    expect(
      issuer.verifyRuntimeJwt({
        token,
        audience: "http://other-gateway:3000/mcp",
        now: new Date("2026-05-22T12:00:00.000Z")
      })
    ).toBeNull();
    expect(
      issuer.verifyRuntimeJwt({
        token,
        audience: "http://agentgateway:3000/mcp",
        now: new Date("2026-05-22T12:00:02.000Z")
      })
    ).toBeNull();
  });
});
