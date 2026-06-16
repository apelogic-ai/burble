import { describe, expect, test } from "bun:test";
import {
  extractBurbleJobId,
  summarizeBurbleJobIdContext
} from "../../../runtimes/openclaw-nemoclaw/openclaw-plugins/burble-channel/job-id";

describe("burble channel plugin job identity", () => {
  test("reads scheduler-owned job ids from top-level and nested contexts", () => {
    expect(extractBurbleJobId({ jobId: " job-123 " })).toBe("job-123");
    expect(extractBurbleJobId({ job_id: "job-456" })).toBe("job-456");
    expect(extractBurbleJobId({ scheduledJob: { jobId: "job-789" } })).toBe(
      "job-789"
    );
    expect(extractBurbleJobId({ scheduled_job: { job_id: "job-abc" } })).toBe(
      "job-abc"
    );
    expect(extractBurbleJobId({ job: { id: "job-def" } })).toBe("job-def");
    expect(extractBurbleJobId({ cron: { jobId: "job-cron" } })).toBe(
      "job-cron"
    );
    expect(extractBurbleJobId({ delivery: { jobId: "job-delivery" } })).toBe(
      "job-delivery"
    );
    expect(extractBurbleJobId({ origin: { job_id: "job-origin" } })).toBe(
      "job-origin"
    );
    expect(extractBurbleJobId({ identity: { jobId: "job-identity" } })).toBe(
      "job-identity"
    );
  });

  test("does not trust model-reachable metadata or extra job ids", () => {
    expect(
      extractBurbleJobId({
        metadata: { jobId: "model-controlled-job" },
        extra: { jobId: "model-controlled-job" }
      })
    ).toBeUndefined();
  });

  test("summarizes context keys without dumping values", () => {
    expect(
      summarizeBurbleJobIdContext({
        text: "secret text",
        to: "convrt_123",
        scheduler: {
          jobId: "secret-job"
        }
      })
    ).toBe("scheduler=[jobId] ctxKeys=[scheduler,text,to]");
  });
});
