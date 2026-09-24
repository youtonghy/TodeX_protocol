export interface RetryWithDelaysOptions {
  /** Wait before each retry; the operation runs `delaysMs.length + 1` times at most. */
  delaysMs: readonly number[];
  /** Checked after every failure and wait; a cancelled run resolves `null` quietly. */
  isCancelled?: () => boolean;
  /** Receives the last error once every retry has failed. */
  onGiveUp?: (error: unknown) => void;
}

/**
 * Runs `operation`, retrying after each delay in `delaysMs` while it throws.
 * Resolves `null` instead of rejecting once retries are exhausted or the
 * caller cancels, so background loads keep their fallback state.
 */
export async function retryWithDelays<T>(
  operation: () => Promise<T>,
  { delaysMs, isCancelled = () => false, onGiveUp }: RetryWithDelaysOptions,
): Promise<T | null> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (isCancelled()) return null;
      const delay = delaysMs[attempt];
      if (delay === undefined) {
        onGiveUp?.(error);
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (isCancelled()) return null;
    }
  }
}
