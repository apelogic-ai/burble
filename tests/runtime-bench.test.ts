import { describe, expect, test } from "bun:test";
import { buildRunRequest } from "../scripts/runtime-bench";

describe("runtime benchmark request", () => {
  test("can exercise the scheduled OpenClaw agent without Slack", () => {
    const request = buildRunRequest(
      {
        url: "http://127.0.0.1:18080",
        label: "direct",
        iterations: 1,
        warmup: 0,
        stream: true,
        executionMode: "openclaw-native",
        routeId: "convrt_bench",
        scheduled: true,
        questions: ["reply with ok"]
      },
      "reply with ok",
      "bench-run"
    ) as Record<string, any>;

    expect(request.input.scheduledJob).toEqual({
      jobId: "job_bench",
      capabilityProfile: "scheduled_job",
      allowedTools: ["web_search", "web_fetch", "burble_provider_call"],
      routeId: "convrt_bench",
      runtimeType: "openclaw",
      stateRefs: [],
      visibilityPolicy: {
        maxOutputVisibility: "user_private"
      }
    });
  });
});
