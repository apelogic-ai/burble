import { describe, expect, test } from "bun:test";
import { startRuntimeReaper } from "../../src/agent/runtime-reaper";
import type { RuntimeFactory } from "../../src/agent/runtime-factory";

describe("startRuntimeReaper", () => {
  test("calls the runtime factory on an interval and can be stopped", async () => {
    const reapedAt: string[] = [];
    const logs: string[] = [];
    let scheduled = false;
    let cleared = false;
    const factory = {
      async getOrCreateRuntime() {
        throw new Error("not used");
      },
      async stopRuntime() {
        throw new Error("not used");
      },
      async reapIdleRuntimes(now) {
        reapedAt.push(now.toISOString());
      }
    } satisfies RuntimeFactory;

    const reaper = startRuntimeReaper({
      factory,
      intervalMs: 1000,
      now: () => new Date("2026-05-21T00:00:00.000Z"),
      setIntervalFn: (callback) => {
        expect(typeof callback).toBe("function");
        scheduled = true;
        return 123;
      },
      clearIntervalFn: () => {
        cleared = true;
      },
      logInfo: (message) => logs.push(message)
    });

    await reaper.tick();
    reaper.stop();

    expect(reapedAt).toEqual(["2026-05-21T00:00:00.000Z"]);
    expect(scheduled).toBe(true);
    expect(cleared).toBe(true);
    expect(logs).toContain("Runtime reaper start");
    expect(logs).toContain("Runtime reaper finish");
  });

  test("skips overlapping ticks", async () => {
    const logs: string[] = [];
    let release!: () => void;
    let calls = 0;
    const factory = {
      async getOrCreateRuntime() {
        throw new Error("not used");
      },
      async stopRuntime() {
        throw new Error("not used");
      },
      async reapIdleRuntimes() {
        calls += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    } satisfies RuntimeFactory;

    const reaper = startRuntimeReaper({
      factory,
      intervalMs: 1000,
      setIntervalFn: () => 123,
      clearIntervalFn: () => undefined,
      logInfo: (message) => logs.push(message)
    });

    const firstTick = reaper.tick();
    await reaper.tick();
    release();
    await firstTick;

    expect(calls).toBe(1);
    expect(logs).toContain("Runtime reaper skipped overlap");
  });
});
