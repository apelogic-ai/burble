import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  createObservabilitySink,
  createJsonlObservabilitySink,
  createPartitionedJsonlObservabilitySink
} from "../src/observability";

function tempJsonlPath(): string {
  return join(mkdtempSync(join(tmpdir(), "burble-observability-")), "events.jsonl");
}

function readJsonl(path: string): unknown[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("createJsonlObservabilitySink", () => {
  test("writes structured JSONL events with stable timestamps", () => {
    const path = tempJsonlPath();
    const sink = createJsonlObservabilitySink({
      path,
      now: () => new Date("2026-05-30T12:00:00.000Z")
    });

    sink.emit({
      name: "conversation.request.started",
      traceId: "trace-1",
      workspaceId: "T123",
      principalId: "T123:U123",
      status: "ok",
      attributes: {
        textLength: 12
      }
    });

    expect(readJsonl(path)).toEqual([
      {
        schemaVersion: 1,
        timestamp: "2026-05-30T12:00:00.000Z",
        name: "conversation.request.started",
        traceId: "trace-1",
        workspaceId: "T123",
        principalId: "T123:U123",
        status: "ok",
        attributes: {
          textLength: 12
        }
      }
    ]);
  });

  test("redacts sensitive fields and omits content by default", () => {
    const path = tempJsonlPath();
    const sink = createJsonlObservabilitySink({
      path,
      now: () => new Date("2026-05-30T12:00:00.000Z")
    });

    sink.emit({
      name: "tool.call.started",
      traceId: "trace-1",
      attributes: {
        authorization: "Bearer secret",
        nested: {
          refreshToken: "refresh-secret",
          safe: "visible"
        }
      },
      content: {
        text: "private prompt"
      }
    });

    expect(readJsonl(path)).toEqual([
      {
        schemaVersion: 1,
        timestamp: "2026-05-30T12:00:00.000Z",
        name: "tool.call.started",
        traceId: "trace-1",
        attributes: {
          authorization: "[redacted]",
          nested: {
            refreshToken: "[redacted]",
            safe: "visible"
          }
        }
      }
    ]);
  });

  test("persists sanitized content only when explicitly enabled", () => {
    const path = tempJsonlPath();
    const sink = createJsonlObservabilitySink({
      path,
      includeContent: true,
      now: () => new Date("2026-05-30T12:00:00.000Z")
    });

    sink.emit({
      name: "conversation.response.completed",
      traceId: "trace-1",
      content: {
        text: "answer",
        accessToken: "secret"
      }
    });

    expect(readJsonl(path)).toEqual([
      {
        schemaVersion: 1,
        timestamp: "2026-05-30T12:00:00.000Z",
        name: "conversation.response.completed",
        traceId: "trace-1",
        content: {
          text: "answer",
          accessToken: "[redacted]"
        }
      }
    ]);
  });
});

describe("createPartitionedJsonlObservabilitySink", () => {
  test("writes events to hourly workspace/runtime partitions", () => {
    const dir = mkdtempSync(join(tmpdir(), "burble-observability-"));
    const sink = createPartitionedJsonlObservabilitySink({
      dir,
      now: () => new Date("2026-05-31T03:10:00.000Z")
    });

    sink.emit({
      name: "runtime.run.completed",
      workspaceId: "T123",
      runtimeType: "openclaw",
      attributes: {
        promptChars: 1200
      }
    });

    const path = join(
      dir,
      "native",
      "year=2026",
      "month=05",
      "day=31",
      "hour=03",
      "workspace=T123",
      "runtime=openclaw",
      "events.jsonl"
    );
    expect(readJsonl(path)).toEqual([
      {
        schemaVersion: 1,
        timestamp: "2026-05-31T03:10:00.000Z",
        name: "runtime.run.completed",
        workspaceId: "T123",
        runtimeType: "openclaw",
        attributes: {
          promptChars: 1200
        }
      }
    ]);
  });

  test("also writes Observer-compatible normalized trace entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "burble-observability-"));
    const sink = createPartitionedJsonlObservabilitySink({
      dir,
      now: () => new Date("2026-05-31T03:10:00.000Z")
    });

    sink.emit({
      name: "tool.gateway.started",
      workspaceId: "T123",
      principalId: "T123:U123",
      runtimeId: "rt_123",
      runtimeType: "openclaw",
      sessionId: "thread-1",
      toolName: "github.listMyPullRequests",
      callId: "call-1"
    });
    sink.emit({
      name: "tool.gateway.completed",
      workspaceId: "T123",
      principalId: "T123:U123",
      runtimeId: "rt_123",
      runtimeType: "openclaw",
      sessionId: "thread-1",
      toolName: "github.listMyPullRequests",
      callId: "call-1",
      durationMs: 42,
      status: "ok"
    });
    sink.emit({
      name: "llm.call.completed",
      workspaceId: "T123",
      principalId: "T123:U123",
      runtimeId: "rt_123",
      runtimeType: "openclaw",
      sessionId: "thread-1",
      model: "openai:gpt-5.4",
      durationMs: 1200,
      status: "ok",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cachedInputTokens: 3,
        reasoningTokens: 2
      }
    });

    const path = join(
      dir,
      "observer-normalized",
      "2026-05-31",
      "openclaw",
      "thread-1.jsonl"
    );
    expect(readJsonl(path)).toEqual([
      expect.objectContaining({
        timestamp: "2026-05-31T03:10:00.000Z",
        agent: "openclaw",
        sessionId: "thread-1",
        entryType: "tool_call",
        role: "assistant",
        developer: "T123:U123",
        machine: "rt_123",
        project: "T123",
        toolName: "github.listMyPullRequests",
        toolCallId: "call-1",
        tokenUsage: null
      }),
      expect.objectContaining({
        timestamp: "2026-05-31T03:10:00.000Z",
        agent: "openclaw",
        sessionId: "thread-1",
        entryType: "tool_result",
        role: "tool",
        toolName: "github.listMyPullRequests",
        toolCallId: "call-1",
        durationMs: 42,
        success: true
      }),
      expect.objectContaining({
        timestamp: "2026-05-31T03:10:00.000Z",
        agent: "openclaw",
        sessionId: "thread-1",
        entryType: "token_usage",
        role: "assistant",
        model: "openai:gpt-5.4",
        tokenUsage: {
          input: 10,
          output: 5,
          cacheRead: 3,
          cacheCreation: 0,
          reasoning: 2
        },
        durationMs: 1200,
        success: true
      })
    ]);
  });

  test("does not write runtime heartbeats to Observer normalized traces", () => {
    const dir = mkdtempSync(join(tmpdir(), "burble-observability-"));
    const sink = createPartitionedJsonlObservabilitySink({
      dir,
      now: () => new Date("2026-05-31T03:10:00.000Z")
    });

    sink.emit({
      name: "runtime.heartbeat",
      workspaceId: "T123",
      principalId: "T123:U123",
      runtimeId: "rt_123",
      runtimeType: "openclaw",
      status: "ok"
    });

    const path = join(
      dir,
      "observer-normalized",
      "2026-05-31",
      "openclaw",
      "unknown.jsonl"
    );
    expect(existsSync(path)).toBe(false);
  });

  test("sanitizes partition path segments and keeps content policy", () => {
    const dir = mkdtempSync(join(tmpdir(), "burble-observability-"));
    const sink = createPartitionedJsonlObservabilitySink({
      dir,
      now: () => new Date("2026-05-31T03:10:00.000Z")
    });

    sink.emit({
      name: "tool.gateway.started",
      workspaceId: "team/slack",
      runtimeType: "openclaw gateway",
      attributes: {
        accessToken: "secret"
      },
      content: {
        text: "private"
      }
    });

    const path = join(
      dir,
      "native",
      "year=2026",
      "month=05",
      "day=31",
      "hour=03",
      "workspace=team_slack",
      "runtime=openclaw_gateway",
      "events.jsonl"
    );
    expect(existsSync(path)).toBe(true);
    expect(readJsonl(path)).toEqual([
      {
        schemaVersion: 1,
        timestamp: "2026-05-31T03:10:00.000Z",
        name: "tool.gateway.started",
        workspaceId: "team/slack",
        runtimeType: "openclaw gateway",
        attributes: {
          accessToken: "[redacted]"
        }
      }
    ]);
  });
});

describe("createObservabilitySink", () => {
  test("prefers partitioned directory logging over legacy single-file path", () => {
    const dir = mkdtempSync(join(tmpdir(), "burble-observability-dir-"));
    const path = tempJsonlPath();
    const sink = createObservabilitySink({
      path,
      dir,
      includeContent: true,
      now: () => new Date("2026-05-31T03:10:00.000Z")
    });

    sink.emit({
      name: "runtime.run.completed",
      workspaceId: "T123",
      runtimeType: "openclaw",
      content: {
        text: "kept because includeContent is enabled"
      }
    });

    const partitionPath = join(
      dir,
      "native",
      "year=2026",
      "month=05",
      "day=31",
      "hour=03",
      "workspace=T123",
      "runtime=openclaw",
      "events.jsonl"
    );

    expect(existsSync(path)).toBe(false);
    expect(readJsonl(partitionPath)).toEqual([
      expect.objectContaining({
        schemaVersion: 1,
        name: "runtime.run.completed",
        workspaceId: "T123",
        runtimeType: "openclaw",
        content: {
          text: "kept because includeContent is enabled"
        }
      })
    ]);
  });
});
