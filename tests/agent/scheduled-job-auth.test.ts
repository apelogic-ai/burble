import { describe, expect, test } from "bun:test";
import type {
  AgentJobCapabilityRecord,
  AgentRuntimeRecord
} from "../../src/db";
import { issueScheduledJobRuntimeJwt } from "../../src/agent/scheduled-job-auth";
import { createRuntimeJwtIssuer } from "../../src/runtime-jwt";

const runtime: AgentRuntimeRecord = {
  id: "rt_123",
  workspaceId: "T123",
  slackUserId: "U123",
  engine: "hermes",
  endpointUrl: "http://runtime:8080",
  authTokenHash: "hash",
  statePath: "/data/runtime/state",
  configPath: "/data/runtime/config/hermes.yaml",
  workspacePath: "/data/runtime/workspace",
  status: "ready",
  policyHash: "policy-a",
  createdAt: "2026-06-01T00:00:00.000Z",
  lastSeenAt: "2026-06-01T00:00:00.000Z",
  lastUsedAt: "2026-06-01T00:00:00.000Z",
  stoppedAt: null,
  failureReason: null
};

const capability: AgentJobCapabilityRecord = {
  jobId: "job-123",
  workspaceId: "T123",
  slackUserId: "U123",
  requiredTools: ["google.getDriveFile", "google.appendToDriveTextFile"],
  routeId: "convrt_123",
  policyHash: "policy-a",
  capabilityProfile: "scheduled_job",
  runtimeType: "hermes",
  stateRefs: [],
  visibilityPolicy: {},
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z"
};

describe("issueScheduledJobRuntimeJwt", () => {
  test("mints a runtime JWT scoped to the stored job capability", () => {
    const issuer = createRuntimeJwtIssuer({ issuer: "https://burble.test" });

    const token = issueScheduledJobRuntimeJwt({
      issuer,
      audience: "https://burble.test/mcp",
      runtime,
      capability,
      ttlSeconds: 30
    });
    const claims = issuer.verifyRuntimeJwt({
      token,
      audience: "https://burble.test/mcp"
    });
    if (!claims) {
      throw new Error("expected runtime JWT claims");
    }

    expect(claims).toMatchObject({
      runtime_id: "rt_123",
      workspace_id: "T123",
      slack_user_id: "U123",
      job_id: "job-123",
      allowed_tools: ["google_append_to_drive_text_file", "google_get_drive_file"]
    });
    expect(claims.exp).toBeDefined();
    expect(claims.iat).toBeDefined();
    expect(claims.exp! - claims.iat!).toBe(30);
  });

  test("rejects capabilities for a different principal", () => {
    const issuer = createRuntimeJwtIssuer({ issuer: "https://burble.test" });

    expect(() =>
      issueScheduledJobRuntimeJwt({
        issuer,
        audience: "https://burble.test/mcp",
        runtime,
        capability: {
          ...capability,
          slackUserId: "U999"
        }
      })
    ).toThrow("Scheduled job capability does not match runtime principal");
  });

  test("defaults and clamps scheduled job runtime JWT TTLs", () => {
    const issuer = createRuntimeJwtIssuer({ issuer: "https://burble.test" });

    const defaultToken = issueScheduledJobRuntimeJwt({
      issuer,
      audience: "https://burble.test/mcp",
      runtime,
      capability
    });
    const defaultClaims = issuer.verifyRuntimeJwt({
      token: defaultToken,
      audience: "https://burble.test/mcp"
    });
    expect(defaultClaims!.exp - defaultClaims!.iat).toBe(15 * 60);

    const clampedToken = issueScheduledJobRuntimeJwt({
      issuer,
      audience: "https://burble.test/mcp",
      runtime,
      capability,
      ttlSeconds: 60 * 60
    });
    const clampedClaims = issuer.verifyRuntimeJwt({
      token: clampedToken,
      audience: "https://burble.test/mcp"
    });
    expect(clampedClaims!.exp - clampedClaims!.iat).toBe(15 * 60);
  });
});
