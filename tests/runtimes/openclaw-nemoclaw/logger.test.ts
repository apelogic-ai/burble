import { describe, expect, test } from "bun:test";
import { info } from "../../../runtimes/openclaw-nemoclaw/src/logger";

describe("runtime logger", () => {
  test("includes an ISO UTC timestamp in info logs", () => {
    const messages: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      messages.push(String(message));
    };

    try {
      info("OpenClaw agent start command=openclaw");
    } finally {
      console.log = originalLog;
    }

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(
      /^\[INFO\] \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z OpenClaw agent start command=openclaw$/
    );
  });
});
