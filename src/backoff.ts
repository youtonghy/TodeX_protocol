/** Retry delays shared by reconnects and gap recovery. */

export type BackoffOptions = {
  /** Delay ceiling of the first retry (attempt 0). */
  baseMs: number;
  /** Ceiling the exponential growth stops at. */
  capMs: number;
  /** Uniform [0, 1) source; injectable for tests. */
  random?: () => number;
};

/**
 * Exponential backoff with "equal jitter": the ceiling `min(cap, base * 2^n)`
 * is split into a fixed half and a random half, so clients that failed
 * together spread their retries out while each still waits at least half the
 * ceiling (full jitter could retry immediately and keep hammering a backend
 * that is down).
 */
export function jitteredBackoffMs(attempt: number, options: BackoffOptions): number {
  const random = options.random ?? Math.random;
  // Past 2^30 the ceiling is long saturated; clamping keeps the power finite.
  const exponent = Math.max(0, Math.min(Number.isFinite(attempt) ? Math.floor(attempt) : 0, 30));
  const ceiling = Math.min(options.capMs, options.baseMs * 2 ** exponent);
  const half = ceiling / 2;
  const sample = Math.min(Math.max(random(), 0), 1);
  return Math.round(half + sample * half);
}
