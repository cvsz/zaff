import { describe, expect, it } from "vitest";
import { startTimer } from "./timer.js";

describe("startTimer", () => {
  it("returns elapsed durationMs from end()", async () => {
    const timer = startTimer();
    await new Promise((resolve) => setTimeout(resolve, 15));
    const durationMs = timer.end();
    expect(durationMs).toBeGreaterThanOrEqual(10);
    expect(durationMs).toBeLessThan(1000);
  });

  it("accepts an optional label and keeps measuring independently", async () => {
    const timer = startTimer();
    const first = timer.end("step1");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = timer.end("step2");
    expect(second).toBeGreaterThan(first);
  });
});
