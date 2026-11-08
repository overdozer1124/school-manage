/**
 * Login failure rate limiting (Issue #16). Counts failed password
 * logins per key (an email address, a source address) inside a sliding
 * window; a key at the limit is refused with 429 until its failures
 * age out of the window.
 *
 * The counts live in this process's memory only. That is deliberate
 * for now: the platform runs as a single process. If it is ever run
 * as several processes, the counts must move to a shared store (the
 * database), or each process would grant its own allowance.
 */
export interface RateLimiter {
  /** True when the key already has maxFailures failures in the window. */
  isBlocked(key: string): boolean;
  /** Records one failed attempt for the key. */
  recordFailure(key: string): void;
  /** Forgets the key's failures (a successful login clears the slate). */
  reset(key: string): void;
}

export function createRateLimiter(options: {
  maxFailures: number;
  windowMs: number;
  now?: () => number;
  /**
   * Upper bound on the keys held at once. Keys arrive from the network
   * (an attacker can mint fresh email addresses endlessly), so past
   * this bound a recordFailure first sweeps the keys whose failures
   * have all aged out; a key still inside its window is never swept.
   */
  maxKeys?: number;
}): RateLimiter {
  const now = options.now ?? Date.now;
  const maxKeys = options.maxKeys ?? 10_000;
  const failures = new Map<string, number[]>();

  function recent(key: string): number[] {
    const cutoff = now() - options.windowMs;
    const kept = (failures.get(key) ?? []).filter((at) => at > cutoff);
    if (kept.length === 0) failures.delete(key);
    else failures.set(key, kept);
    return kept;
  }

  function sweep(): void {
    for (const key of [...failures.keys()]) recent(key);
  }

  return {
    isBlocked(key) {
      return recent(key).length >= options.maxFailures;
    },
    recordFailure(key) {
      if (failures.size > maxKeys) sweep();
      const kept = recent(key);
      kept.push(now());
      failures.set(key, kept);
    },
    reset(key) {
      failures.delete(key);
    },
  };
}
