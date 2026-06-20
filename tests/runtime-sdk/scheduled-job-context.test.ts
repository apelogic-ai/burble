import { describe, expect, test } from "bun:test";
import {
  formatRuntimeScheduledJobContextLines,
  withTrustedScheduledJobId,
  type RuntimeScheduledJobContext
} from "@burble/runtime-sdk/scheduled-job-context";

const scheduledJob: RuntimeScheduledJobContext = {
  jobId: "job-123",
  capabilityProfile: "scheduled_job",
  allowedTools: ["google_get_drive_file", "github_search_issues", "github_search_issues"],
  routeId: "convrt_123",
  runtimeType: "openclaw-gateway",
  stateRefs: [
    {
      provider: "google",
      kind: "drive_file",
      id: "file-123",
      purpose: "dedupe_state"
    }
  ],
  visibilityPolicy: {
    maxOutputVisibility: "public",
    allowPrivateToolDeclassification: false
  }
};

describe("scheduled job runtime context helpers", () => {
  test("formats scheduled job context lines deterministically", () => {
    expect(
      formatRuntimeScheduledJobContextLines(scheduledJob, {
        includeRuntimeType: true
      })
    ).toEqual([
      "Scheduled Burble job context:",
      "- jobId=job-123",
      "- capabilityProfile=scheduled_job",
      "- allowedTools=github_search_issues,google_get_drive_file",
      "- routeId=convrt_123",
      "- runtimeType=openclaw-gateway",
      "- maxOutputVisibility=public",
      "- allowPrivateToolDeclassification=false",
      "- stateRef provider=google kind=drive_file id=file-123 purpose=dedupe_state",
      "For this scheduled job, use only the listed allowedTools for Burble provider calls. Treat stateRefs as durable job state locations supplied by Burble.",
      "Respect maxOutputVisibility when sending scheduled output. Do not publicly post private-tool-derived content; public channel delivery for authenticated provider read output requires an explicit declassification approval flow that is not implemented yet. Write-only provider state tools do not by themselves make public-source output private."
    ]);
  });

  test("uses the trusted scheduler job id over model-supplied input", () => {
    expect(
      withTrustedScheduledJobId(
        { query: "org:apelogic-ai is:pr", jobId: "model-controlled-job" },
        scheduledJob
      )
    ).toEqual({
      query: "org:apelogic-ai is:pr",
      jobId: "job-123"
    });
  });

  test("creates an object input when scheduled provider input is not a record", () => {
    expect(withTrustedScheduledJobId("not-json", scheduledJob)).toEqual({
      jobId: "job-123"
    });
  });
});
