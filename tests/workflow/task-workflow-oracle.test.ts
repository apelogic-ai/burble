import { describe, expect, test } from "bun:test";
import type { AgentJobRunRecord } from "../../src/db";
import {
  compareTaskWorkflowProjection,
  createTaskWorkflowOracleLoop,
} from "../../src/workflow/task-workflow-oracle";
import {
  recordTaskWorkflowRunFailed,
  recordTaskWorkflowRunStarted,
  recordTaskWorkflowRunSucceeded,
  recordTaskWorkflowRunTriggered,
} from "../../src/workflow/task-workflow-shadow";
import { createInMemoryTaskWorkflowEventStore } from "../../src/workflow/task-workflow-store";

describe("task workflow oracle", () => {
  test("accepts matching authoritative and workflow projections", () => {
    const store = createInMemoryTaskWorkflowEventStore();
    const run = agentRun({
      status: "succeeded",
      startedAt: "2026-06-29T10:00:01.000Z",
      finishedAt: "2026-06-29T10:00:05.000Z",
    });
    recordTaskWorkflowRunTriggered({ store, run });
    recordTaskWorkflowRunStarted({ store, run });
    recordTaskWorkflowRunSucceeded({ store, run, outputText: "Done." });

    const result = compareTaskWorkflowProjection({
      workflowState: store.replayState(),
      authoritativeRuns: [run],
    });

    expect(result).toEqual({ ok: true, mismatches: [] });
  });

  test("reports missing workflow runs", () => {
    const result = compareTaskWorkflowProjection({
      workflowState: createInMemoryTaskWorkflowEventStore().replayState(),
      authoritativeRuns: [agentRun({ status: "queued" })],
    });

    expect(result.ok).toBe(false);
    expect(result.mismatches).toEqual([
      {
        kind: "missing_workflow_run",
        runId: "jobrun-1",
        jobId: "job-1",
        authoritativeStatus: "queued",
      },
    ]);
  });

  test("reports terminal and reason divergence", () => {
    const store = createInMemoryTaskWorkflowEventStore();
    const authoritativeRun = agentRun({
      status: "failed",
      failureReason: "lease expired",
      startedAt: "2026-06-29T10:00:01.000Z",
      finishedAt: "2026-06-29T10:00:05.000Z",
    });
    recordTaskWorkflowRunTriggered({ store, run: authoritativeRun });
    recordTaskWorkflowRunStarted({ store, run: authoritativeRun });
    recordTaskWorkflowRunFailed({
      store,
      run: authoritativeRun,
      failureClass: "runtime_failed",
      reason: "provider timeout",
    });

    const result = compareTaskWorkflowProjection({
      workflowState: store.replayState(),
      authoritativeRuns: [authoritativeRun],
    });

    expect(result.mismatches.map((mismatch) => mismatch.kind)).toEqual([
      "failure_reason_mismatch",
    ]);
    expect(result.mismatches[0]).toMatchObject({
      runId: "jobrun-1",
      expected: "lease expired",
      actual: "provider timeout",
    });
  });

  test("reports workflow runs with no authoritative row", () => {
    const store = createInMemoryTaskWorkflowEventStore();
    recordTaskWorkflowRunTriggered({
      store,
      run: agentRun({ status: "queued" }),
    });

    const result = compareTaskWorkflowProjection({
      workflowState: store.replayState(),
      authoritativeRuns: [],
    });

    expect(result.mismatches).toEqual([
      {
        kind: "missing_authoritative_run",
        runId: "jobrun-1",
        jobId: "job-1",
        workflowStatus: "created",
      },
    ]);
  });

  test("ignores old terminal workflow-only runs", () => {
    const store = createInMemoryTaskWorkflowEventStore();
    const run = agentRun({
      status: "succeeded",
      finishedAt: "2026-06-20T10:00:00.000Z",
    });
    recordTaskWorkflowRunTriggered({ store, run });
    recordTaskWorkflowRunStarted({ store, run });
    recordTaskWorkflowRunSucceeded({ store, run, outputText: "Done." });

    const result = compareTaskWorkflowProjection({
      workflowState: store.replayState(),
      authoritativeRuns: [],
      now: new Date("2026-06-29T10:00:00.000Z"),
      maxWorkflowOnlyTerminalAgeMs: 24 * 60 * 60_000,
    });

    expect(result).toEqual({ ok: true, mismatches: [] });
  });

  test("tolerates in-flight nonterminal status skew", () => {
    const store = createInMemoryTaskWorkflowEventStore();
    const run = agentRun({ status: "running" });
    recordTaskWorkflowRunTriggered({ store, run });

    const result = compareTaskWorkflowProjection({
      workflowState: store.replayState(),
      authoritativeRuns: [run],
    });

    expect(result).toEqual({ ok: true, mismatches: [] });
  });

  test("oracle loop logs mismatches from replayed state", async () => {
    const store = createInMemoryTaskWorkflowEventStore();
    const warnings: string[] = [];
    recordTaskWorkflowRunTriggered({
      store,
      run: agentRun({ status: "queued" }),
    });
    const loop = createTaskWorkflowOracleLoop({
      replayWorkflowState: () => store.replayState(),
      listAuthoritativeRuns: () => [],
      logWarn: (message) => warnings.push(message),
    });

    const result = await loop.tick();

    expect(result.ok).toBe(false);
    expect(result.mismatches[0]?.kind).toBe("missing_authoritative_run");
    expect(warnings[0]).toContain("Task workflow oracle found mismatches");
  });
});

function agentRun(input: Partial<AgentJobRunRecord>): AgentJobRunRecord {
  return {
    runId: input.runId ?? "jobrun-1",
    jobId: input.jobId ?? "job-1",
    workspaceId: input.workspaceId ?? "T123",
    slackUserId: input.slackUserId ?? "U123",
    triggerSource: input.triggerSource ?? "manual",
    status: input.status ?? "queued",
    failureReason: input.failureReason ?? null,
    createdAt: input.createdAt ?? "2026-06-29T10:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-06-29T10:00:00.000Z",
    startedAt: input.startedAt ?? null,
    finishedAt: input.finishedAt ?? null,
  };
}
