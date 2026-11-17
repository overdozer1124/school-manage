/**
 * Request counting for the public viewing route (Issue #41
 * review). The public route is the one surface of this server
 * that answers with no session at all, and one call fans out to
 * several database and platform reads (a range of up to 366
 * days), so it carries a per-source-address allowance: a sliding
 * window of request timestamps, refused past the limit until the
 * oldest requests age out.
 *
 * The shape follows the platform's login limiter (Issue #16,
 * platform/src/auth/rateLimit.ts) — a sliding window per key,
 * counts held in this process's memory only, keys bounded with a
 * sweep — with one difference: that limiter counts failures
 * (wrong passwords), this one counts requests, because a public
 * read has no failure to count; the load is the request itself.
 * The counts living in one process's memory is the same stance
 * as the platform's: if this server is ever run as several
 * processes, each grants its own allowance.
 */
export interface RequestRateLimiter {
  /** Records one request for the key and answers whether it is
   *  within the allowance. A refused request is not recorded, so
   *  hammering at the limit does not extend the wait. */
  tryAcquire(key: string): boolean;
}

export function createRequestRateLimiter(options: {
  maxRequests: number;
  windowMs: number;
  now?: () => number;
  /**
   * Upper bound on the keys held at once. Keys arrive from the
   * network (an attacker can mint fresh source addresses), so
   * past this bound a tryAcquire first sweeps the keys whose
   * requests have all aged out; a key still inside its window is
   * never swept.
   */
  maxKeys?: number;
}): RequestRateLimiter {
  const now = options.now ?? Date.now;
  const maxKeys = options.maxKeys ?? 10_000;
  const requests = new Map<string, number[]>();

  function recent(key: string): number[] {
    const cutoff = now() - options.windowMs;
    const kept = (requests.get(key) ?? []).filter((at) => at > cutoff);
    if (kept.length === 0) requests.delete(key);
    else requests.set(key, kept);
    return kept;
  }

  function sweep(): void {
    for (const key of [...requests.keys()]) recent(key);
  }

  return {
    tryAcquire(key) {
      if (requests.size > maxKeys) sweep();
      const kept = recent(key);
      if (kept.length >= options.maxRequests) return false;
      kept.push(now());
      requests.set(key, kept);
      return true;
    },
  };
}
