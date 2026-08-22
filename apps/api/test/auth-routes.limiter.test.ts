import { describe, expect, it } from "vitest";
import {
  RATE_LIMITER_MAX_BUCKETS,
  createFixedWindowRateLimiter,
} from "../src/auth-routes.js";

describe("createFixedWindowRateLimiter eviction", () => {
  it("evicts only expired buckets when the map fills", () => {
    let now = 0;
    const limiter = createFixedWindowRateLimiter(
      { windowMs: 100, max: 1 },
      () => now
    );
    for (let i = 0; i < 50; i++) limiter.allow(`k${i}`);
    expect(limiter.size()).toBe(50);
    now = 150;
    limiter.allow("fresh");
    expect(limiter.size()).toBe(1);
    expect(limiter.allow("fresh")).toBe(false);
  });

  it("keeps unrelated live buckets when crossing the size threshold", () => {
    const limiter = createFixedWindowRateLimiter(
      { windowMs: 60_000, max: 1 },
      () => 0
    );
    for (let i = 0; i < RATE_LIMITER_MAX_BUCKETS - 2; i++) {
      limiter.allow(`attacker-${i}`);
    }
    limiter.allow("survivor");
    expect(limiter.allow("survivor")).toBe(false);

    for (let i = 0; i < 500; i++) {
      limiter.allow(`overflow-${i}`);
    }

    expect(limiter.size()).toBeLessThanOrEqual(RATE_LIMITER_MAX_BUCKETS);
    expect(limiter.allow("survivor")).toBe(false);
    expect(limiter.allow("never-seen-before")).toBe(true);
  });

  it("still enforces per-key limits after eviction churn", () => {
    let now = 0;
    const limiter = createFixedWindowRateLimiter({ windowMs: 100, max: 2 }, () => now);
    for (let i = 0; i < RATE_LIMITER_MAX_BUCKETS + 10; i++) {
      limiter.allow(`churn-${i}`);
    }
    now = 200;
    expect(limiter.allow("churn-0")).toBe(true);
    expect(limiter.allow("churn-0")).toBe(true);
    expect(limiter.allow("churn-0")).toBe(false);
  });
});
