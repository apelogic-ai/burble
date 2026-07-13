import { describe, expect, test } from "bun:test";
import { nextIterationDelayMs } from "../scripts/llm-ab";

describe("local LLM A/B cadence", () => {
  test("anchors each pair to the original soak start time", () => {
    expect(nextIterationDelayMs(1_000, 1, 60, 11_000)).toBe(50_000);
    expect(nextIterationDelayMs(1_000, 2, 60, 125_000)).toBe(0);
  });
});
