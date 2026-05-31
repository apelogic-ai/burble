import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
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
