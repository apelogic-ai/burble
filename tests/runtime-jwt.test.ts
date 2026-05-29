import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  test("can carry optional job-scoped tool claims", () => {
    const issuer = createRuntimeJwtIssuer({
      issuer: "http://burble-app:3000",
      now: () => new Date("2026-05-22T12:00:00.000Z")
    });

    const token = issuer.issueRuntimeJwt({
      audience: "http://agentgateway:3000/mcp",
      runtimeId: "rt_u123",
      workspaceId: "T123",
      slackUserId: "U123",
      jobId: "job-123",
      allowedTools: ["github_search_issues", "github_list_my_pull_requests"]
    });

    expect(
      issuer.verifyRuntimeJwt({
        token,
        audience: "http://agentgateway:3000/mcp",
        now: new Date("2026-05-22T12:00:30.000Z")
      })
    ).toMatchObject({
      job_id: "job-123",
      allowed_tools: ["github_list_my_pull_requests", "github_search_issues"]
    });
  });

  test("reuses a persistent private key across issuer restarts", () => {
    const privateKeyPath = join(
      mkdtempSync(join(tmpdir(), "burble-runtime-jwt-")),
      "runtime-jwt-private.pem"
    );
    const first = createRuntimeJwtIssuer({
      issuer: "http://burble-app:3000",
      privateKeyPath,
      now: () => new Date("2026-05-22T12:00:00.000Z")
    });
    const token = first.issueRuntimeJwt({
      audience: "http://agentgateway:3000/mcp",
      runtimeId: "rt_u123",
      workspaceId: "T123",
      slackUserId: "U123"
    });
    const second = createRuntimeJwtIssuer({
      issuer: "http://burble-app:3000",
      privateKeyPath,
      now: () => new Date("2026-05-22T12:00:30.000Z")
    });

    expect(readFileSync(privateKeyPath, "utf8")).toContain("PRIVATE KEY");
    expect(second.jwks().keys[0]?.kid).toBe(first.jwks().keys[0]?.kid);
    expect(
      second.verifyRuntimeJwt({
        token,
        audience: "http://agentgateway:3000/mcp",
        now: new Date("2026-05-22T12:00:30.000Z")
      })
    ).toMatchObject({
      runtime_id: "rt_u123",
      workspace_id: "T123",
      slack_user_id: "U123"
    });
  });
});
