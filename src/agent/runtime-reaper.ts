import type { RuntimeFactory } from "./runtime-factory";

export type RuntimeReaper = {
  stop: () => void;
  tick: () => Promise<void>;
};

type RuntimeReaperTimer = unknown;
type RuntimeReaperSetInterval = (
  callback: () => void,
  intervalMs: number
) => RuntimeReaperTimer;
type RuntimeReaperClearInterval = (timer: RuntimeReaperTimer) => void;

export function startRuntimeReaper(input: {
  factory: RuntimeFactory;
  intervalMs: number;
  now?: () => Date;
  setIntervalFn?: RuntimeReaperSetInterval;
  clearIntervalFn?: RuntimeReaperClearInterval;
  logInfo?: (message: string) => void;
  logError?: (error: unknown) => void;
}): RuntimeReaper {
  const now = input.now ?? (() => new Date());
  const setIntervalFn: RuntimeReaperSetInterval =
    input.setIntervalFn ?? ((callback, intervalMs) => setInterval(callback, intervalMs));
  const clearIntervalFn: RuntimeReaperClearInterval =
    input.clearIntervalFn ??
    ((timer) => clearInterval(timer as ReturnType<typeof setInterval>));
  const logInfo = input.logInfo ?? (() => undefined);
  const logError = input.logError ?? (() => undefined);
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) {
      logInfo("Runtime reaper skipped overlap");
      return;
    }

    running = true;
    try {
      logInfo("Runtime reaper start");
      await input.factory.reapIdleRuntimes(now());
      logInfo("Runtime reaper finish");
    } catch (error) {
      logError(error);
    } finally {
      running = false;
    }
  };

  const timer = setIntervalFn(() => {
    void tick();
  }, input.intervalMs);

  return {
    stop() {
      clearIntervalFn(timer);
    },
    tick
  };
}
