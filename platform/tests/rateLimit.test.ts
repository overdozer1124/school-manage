import { describe, expect, it } from "vitest";
import { createRateLimiter } from "../src/auth/rateLimit.js";

describe("login rate limiter (Issue #16)", () => {
  it("blocks at the limit and frees the key when the window passes", () => {
    let now = 1_000_000;
    const limiter = createRateLimiter({ maxFailures: 3, windowMs: 60_000, now: () => now });
    expect(limiter.isBlocked("k")).toBe(false);
    limiter.recordFailure("k");
    limiter.recordFailure("k");
    expect(limiter.isBlocked("k")).toBe(false);
    limiter.recordFailure("k");
    expect(limiter.isBlocked("k")).toBe(true);

    now += 59_000;
    expect(limiter.isBlocked("k")).toBe(true);
    now += 2_000;
    expect(limiter.isBlocked("k")).toBe(false);
  });

  it("keeps keys separate and forgets a key on reset", () => {
    const limiter = createRateLimiter({ maxFailures: 2, windowMs: 60_000, now: () => 0 });
    limiter.recordFailure("a");
    limiter.recordFailure("a");
    expect(limiter.isBlocked("a")).toBe(true);
    expect(limiter.isBlocked("b")).toBe(false);
    limiter.reset("a");
    expect(limiter.isBlocked("a")).toBe(false);
  });

  it("sweeps aged-out keys once the key bound is passed", () => {
    let now = 0;
    const limiter = createRateLimiter({
      maxFailures: 2,
      windowMs: 1_000,
      now: () => now,
      maxKeys: 3,
    });
    limiter.recordFailure("old-1");
    limiter.recordFailure("old-2");
    limiter.recordFailure("old-3");
    limiter.recordFailure("old-4");
    now = 5_000; // every failure so far has aged out
    limiter.recordFailure("old-5"); // size was over the bound: sweep runs
    limiter.recordFailure("fresh");
    limiter.recordFailure("fresh");
    // The fresh key is inside its window and must survive sweeps.
    expect(limiter.isBlocked("fresh")).toBe(true);
    expect(limiter.isBlocked("old-1")).toBe(false);
  });
});
