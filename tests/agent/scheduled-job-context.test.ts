import { describe, expect, test } from "bun:test";
import {
  buildScheduledJobContext,
  type ScheduledJobContext,
} from "../../src/agent/scheduled-job-context";
import type { AgentJobCapabilityRecord } from "../../src/db";

const capability: AgentJobCapabilityRecord = {
  jobId: "job-123",
  workspaceId: "T123",
  slackUserId: "U123",
  requiredTools: ["google_get_drive_file", "google_append_drive_text_file"],
  operationGrants: [
    {
      tool: "github_call_mcp_tool",
      operation: "issue_read",
      description: "Read one issue or pull request",
      inputSchema: { type: "object" },
    },
  ],
  routeId: "convrt_123",
  policyHash: "policy-a",
  capabilityProfile: "scheduled_job",
  runtimeType: "hermes",
  stateRefs: [
    {
      provider: "google",
      kind: "drive_file",
      id: "file-123",
      purpose: "dedupe_state",
    },
  ],
  visibilityPolicy: {
    maxOutputVisibility: "public",
    allowPrivateToolDeclassification: false,
  },
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
};

describe("buildScheduledJobContext", () => {
  test("builds a runtime-neutral scheduled job envelope", () => {
    expect(buildScheduledJobContext(capability)).toEqual({
      jobId: "job-123",
      capabilityProfile: "scheduled_job",
      allowedTools: ["google_append_drive_text_file", "google_get_drive_file"],
      operationGrants: [
        {
          tool: "github_call_mcp_tool",
          operation: "issue_read",
          description: "Read one issue or pull request",
          inputSchema: { type: "object" },
        },
      ],
      routeId: "convrt_123",
      runtimeType: "hermes",
      stateRefs: [
        {
          provider: "google",
          kind: "drive_file",
          id: "file-123",
          purpose: "dedupe_state",
        },
      ],
      visibilityPolicy: {
        maxOutputVisibility: "public",
        allowPrivateToolDeclassification: false,
      },
    } satisfies ScheduledJobContext);
  });
});
